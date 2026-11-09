/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ApiSessionNotFound } from '@deepseek-ai/dsh-api-session-controller'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel, installPersistedModelSelection } from './role-models.ts'
import { RemotePresets, remotePresetBinding } from '../remote/presets.ts'
import { remoteSearchTools } from '../remote/search.ts'
import type { RemoteWorkspace } from '../environments/remote-workspace.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'
import type { Personas } from '../personas/service.ts'
import { bindPersona, personaDenial } from '../personas/runtime.ts'
import type { WorldPool } from '../environments/pool.ts'
import type { OwnershipAccess } from '../ownership/protocol.ts'
import { ownershipReady } from '../ownership/runtime.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  readonly remote?: RemoteWorkspace
  readonly worlds?: WorldPool
  readonly personas?: Pick<Personas, 'verify'>
  readonly ownership?: OwnershipAccess
  environmentAllowed?(ticket: Ticket): boolean
  executionProblem?(ticket: Ticket): string | undefined
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true; remote?: boolean }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  private readonly remotePresets?: RemotePresets
  private readonly guardedWorlds = new WeakSet<Agent>()
  private readonly remoteOwners = new WeakMap<Agent, string>()
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    if (host.remote) this.remotePresets = new RemotePresets(this.ctx, host.remote.world)
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', async ({ text }, requestId) => { await this.prompt(host.masterId, requestId, text, 'steer') }, { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const remote = this.remoteFor(sessionId, agent)
        if ((remotePresetBinding(agent?.session.header?.agentPreset) || this.host.store.tickets.get(ticketId ?? '')?.execution?.environment?.world) && !remote) return
        const ours = sessionId === this.host.masterId ? this.preset('orchestrator') : ticketId && this.host.store.tickets.get(ticketId) ? this.preset('worker', remote) : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    this.host.lifetime.throwIfAborted(); this.host.ownership?.proof()
    const ctx = this.ctx
    const ticketId = ticketOfSession(id), ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined
    const persona = this.pinPersona(id, ticket)
    const remote = this.remoteFor(id), presets = this.presetsFor(remote)
    const desired = ticket?.execution?.environment?.world
    if (desired && !remote) throw new Error('The Session execution world is unavailable; local fallback is forbidden')
    const binding = remote?.world.status().binding ?? 'local'
    const saved = this.host.store.get(KV.sessions.world(id))
    if (saved && saved !== binding) throw new Error('Session belongs to another execution world; authorize a new Session')
    if (remote) {
      remote.assertPair()
      await presets!.prepare()
      try {
        const existing = await ctx.sessionController.inspect(id as SessionId, this.host.lifetime)
        if (remotePresetBinding(existing.meta.agentPreset) !== binding || existing.meta.cwd !== cwd)
          throw new Error('Existing Session has a different execution world or working directory')
      } catch (error) {
        if (!(error instanceof ApiSessionNotFound)) throw error
      }
    }
    this.host.store.set(KV.sessions.world(id), binding)
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      if (remote) {
        const handle = await ctx.agents.create({ sessionId: id as SessionId, meta: { cwd, agentPreset: this.preset(role, remote) }, signal: this.host.lifetime,
          setup: async (scope, agent) => {
            installPersistedModelSelection(ctx, agent)
            await presets!.mount(scope, role === 'worker' ? 'worker' : 'router')
            return { commit: () => { remote.assertPair(); if (this.host.worlds?.lookup(binding)) this.host.worlds.assertMounted(agent, binding) } }
          } })
        result = { agent: handle.agent }
      } else {
        const workspace = await ctx.workspaceRegistry.create(cwd)
        // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
        await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
          agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
        result = await ctx.sessionController.resolveAgent(id as SessionId)
      }
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : persona?.definition.model ?? settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  private remoteFor(id: string, agent?: Agent): RemoteWorkspace | undefined {
    if (id === this.host.masterId) return this.host.remote
    const ticketId = ticketOfSession(id), ticket = ticketId && this.host.store.tickets.get(ticketId)
    const saved = this.host.store.get(KV.sessions.world(id))
    const binding = (ticket && ticket.execution?.environment?.world) || remotePresetBinding(agent?.session.header?.agentPreset) || (saved !== 'local' ? saved : undefined)
    if (!binding || binding === this.host.remote?.world.status().binding) return this.host.remote
    return this.host.worlds?.lookup(binding)?.workspace
  }
  private presetsFor(remote?: RemoteWorkspace): RemotePresets | undefined {
    return remote && (remote === this.host.remote ? this.remotePresets : this.host.worlds?.lookup(remote.world.status().binding)?.presets)
  }
  private preset(role: 'orchestrator' | 'worker', remote = this.host.remote): string {
    return this.presetsFor(remote)?.id(role === 'orchestrator' ? 'router' : 'worker') ?? (role === 'orchestrator' ? ROUTER_PRESET : WORKER_PRESET)
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    this.assertSavedWorld(sessionId)
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver once per request id and return whether history contains it after flushing, including a deduplicated retry. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<boolean> {
    this.assertSavedWorld(sessionId)
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    return this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, () => {
      const problem = this.worldProblem(result.agent); if (problem) throw new Error(problem)
      authorize?.()
    }, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    this.installWorldGuard(agent)
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { await this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [], remote: !!this.remoteFor(agent.id, agent) }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (!master) this.bindRemoteSearch(agent, binding)
    if (master) {
      binding.disposers.push(agent.ctx.tools.restrict({ allow: this.host.remote || this.host.ownership ? ['skill'] : ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
      await this.decoratePersona(agent, ticket!, binding)
    }
  }
  /** Keep a Session and every resumed descendant on the persona definition that its task originally selected. */
  private pinPersona(id: string, ticket?: Ticket) {
    const persona = ticket?.execution?.persona, expected = persona?.digest ?? 'default'
    if (persona) {
      if (!this.host.personas) throw new Error('Persona registry is unavailable')
      this.host.personas.verify(persona)
    }
    const stored = this.host.store.get(KV.sessions.persona(id))
    if (stored && stored !== expected) throw new Error('Session belongs to another persona version; authorize a new run')
    const owner = this.host.store.get(KV.sessions.personaOwner(id))
    if (owner && owner !== ticket?.id) throw new Error('Session belongs to another persona task; authorize a new run')
    if (!stored) this.host.store.set(KV.sessions.persona(id), expected)
    if (persona && !owner) this.host.store.set(KV.sessions.personaOwner(id), ticket!.id)
    return persona
  }
  private async decoratePersona(agent: Agent, ticket: Ticket, binding: SessionBinding): Promise<void> {
    try {
      const persona = this.pinPersona(agent.id, ticket)
      if (persona) binding.disposers.push(await bindPersona(agent, persona))
    } catch (error) { this.failPersona(agent, String(error)); throw error }
  }
  private failPersona(agent: Agent, reason: string): void {
    agent.ctx.effect(() => agent.ctx.tools.guard(() => reason))
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'dsh-superagent-persona-unavailable', order: -10001, interpolate: false,
      text: () => { throw new Error(reason) } }))
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === this.preset('orchestrator')
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const persona = store.tickets.get(ticketId)?.execution?.persona
    const remote = this.remoteFor(agent.id, agent)
    const allow = WORK_TOOLS.filter(name => !(remote && name === 'pwsh') && agent.ctx.tools.get(name, parent) && (!persona || !personaDenial(persona, name)))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      if (!current || !liveTicket(current)) return 'Ticket ended; new work needs a new authorized ticket'
      if ((current.execution?.persona?.digest ?? 'default') !== (persona?.digest ?? 'default')) return 'The task persona changed; authorize a new run'
      if (this.host.environmentAllowed && !this.host.environmentAllowed(current)) return 'Execution environment authorization is unavailable or revoked'
      const problem = this.host.executionProblem?.(current)
      if (problem) return problem
      return this.worldProblem(agent)
    })]
  }
  private assertSavedWorld(id: string): void {
    const saved = this.host.store.get(KV.sessions.world(id)), current = this.remoteFor(id)?.world.status().binding ?? 'local'
    if (saved && saved !== current) throw new Error('Session belongs to another execution world')
  }
  private worldProblem(agent: Agent): string | undefined {
    if (this.host.lifetime.aborted || this.host.closing()) return 'Coordinator is stopping or has lost ownership'
    if (!ownershipReady(this.host.ownership)) return 'Coordinator execution ownership is unavailable'
    const recorded = remotePresetBinding(agent.session.header?.agentPreset), remote = this.remoteFor(agent.id, agent)
    if (this.host.ownership && !remote && agent.id !== this.host.masterId) return 'Ownership-controlled work requires an enrolled endpoint world'
    const saved = this.host.store.get(KV.sessions.world(agent.id))
    if (recorded !== remote?.world.status().binding || saved && saved !== (remote?.world.status().binding ?? 'local'))
      return 'Session belongs to another execution world'
    if (remote && !remote.world.status().ready) return 'Remote execution authority is unavailable or revoked'
    if (remote) {
      if (recorded && this.host.worlds?.lookup(recorded)) {
        try { this.host.worlds.assertMounted(agent, recorded) } catch (error) { return String(error) }
      }
      if (agent.id !== this.host.masterId) {
        const owner = this.ticketOf(agent)?.id ?? this.remoteOwners.get(agent)
        const ticket = owner && this.host.store.tickets.get(owner)
        if (!ticket) return 'Remote Session has no verified parent mission'
        if (!liveTicket(ticket)) return 'Ticket ended; new work needs a new authorized ticket'
        if (this.host.environmentAllowed && !this.host.environmentAllowed(ticket)) return 'Execution environment authorization is unavailable or revoked'
      }
      const policy = this.ctx.get('sandboxPolicy') as { resolve(request: { session: Agent['session'] }): { mode: string } } | undefined
      if (policy?.resolve({ session: agent.session }).mode !== 'danger-full-access')
        return 'This profile uses endpoint grant confinement; select its Endpoint grant permissions before running tools'
    }
    return undefined
  }
  private installWorldGuard(agent: Agent): void {
    if (this.guardedWorlds.has(agent)) return
    this.guardedWorlds.add(agent)
    const saved = this.host.store.get(KV.sessions.world(agent.id))
    const remote = this.remoteFor(agent.id, agent)
    if (!this.host.ownership && !remote && !remotePresetBinding(agent.session.header?.agentPreset) && (!saved || saved === 'local')) return
    agent.ctx.effect(() => agent.ctx.tools.guard(execution => execution.name === 'pwsh' ? 'This remote execution world does not provide PowerShell' : this.worldProblem(agent)))
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'dsh-superagent-execution-world', order: -10000, interpolate: false,
      text: () => { const problem = this.worldProblem(agent); if (problem) throw new Error(problem); return '' } }))
    if (!remote) return
    agent.ctx.on('tools/execute', (execution, next) => {
      const problem = this.worldProblem(agent); if (problem) throw new Error(problem)
      const world = this.remoteFor(agent.id, agent)!.world, ticketId = this.ticketOf(agent)?.id ?? this.remoteOwners.get(agent)
      const ticket = ticketId ? this.host.store.tickets.get(ticketId) : undefined, assignment = ticket?.assignments.at(-1)
      const authorize = () => {
        const problem = this.worldProblem(agent)
        if (problem) throw new Error(problem)
        if (ticket && this.host.store.tickets.get(ticket.id)?.assignments.at(-1)?.id !== assignment?.id)
          throw new Error('Mission assignment changed before remote dispatch')
        if (this.host.closing()) throw new Error('Coordinator is stopping')
      }
      if (agent.id === this.host.masterId) return world.withOwner({ kind: 'host', purpose: 'router-tool' }, authorize, next)
      if (!ticket || !assignment) throw new Error('Remote effect has no owning mission assignment')
      return world.withOwner({ kind: 'assignment', ticketId: ticket.id, assignmentId: assignment.id, sessionId: agent.id,
        callId: execution.callId, tool: execution.name }, authorize, next)
    }, { prepend: true })
  }
  /**
   * Worker descendants inherit mission guards. Remote descendants must prove their immutable parent chain, including
   * unloaded parents after restart; unowned remote Sessions remain denied by the world guard.
   */
  private async limitSubagent(agent: Agent): Promise<void> {
    let parent = agent.session.header.parentSession
    const remote = this.remoteFor(agent.id, agent)
    if (remote) {
      for (let depth = 0; parent !== undefined && depth < 8; depth++) {
        let header = this.ctx.agents.get(parent)?.session.header
        try { header ??= (await this.ctx.sessionController.inspect(parent, this.host.lifetime)).meta }
        catch { return }
        if (!header || remotePresetBinding(header.agentPreset) !== remote.world.status().binding) return
        const ticketId = ticketOfSession(parent), ticket = ticketId && this.host.store.tickets.get(ticketId)
        if (ticket && header.cwd === ticket.execution?.directory) {
          this.remoteOwners.set(agent, ticket.id)
          const binding: SessionBinding = { disposers: this.workOnly(agent, ticket.id), subagent: true, remote: true }
          this.bindings.set(agent, binding); this.bindRemoteSearch(agent, binding); await this.decoratePersona(agent, ticket, binding); return
        }
        parent = header.parentSession
      }
      return
    }
    // Recover immutable parent headers too: a resumed descendant must not escape persona restrictions when its parent is unloaded.
    let recordedOwner: string | undefined
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      // Each previously verified child is a durable lineage anchor; deeper teams do not lose their persona at the traversal bound.
      recordedOwner = this.host.store.get(KV.sessions.personaOwner(parent))
      if (recordedOwner) break
      let header = this.ctx.agents.get(parent)?.session.header
      try { header ??= (await this.ctx.sessionController.inspect(parent, this.host.lifetime)).meta } catch { break }
      parent = header?.parentSession
    }
    const ticketId = recordedOwner ?? (parent === undefined ? undefined : ticketOfSession(parent))
    const ticket = ticketId && this.host.store.tickets.get(ticketId)
    if (!ticket) {
      const saved = this.host.store.get(KV.sessions.persona(agent.id))
      if (saved && saved !== 'default') {
        const reason = 'Cannot restore this persona-bound descendant without its owning task'
        this.failPersona(agent, reason); throw new Error(reason)
      }
      return
    }
    const binding: SessionBinding = { disposers: this.workOnly(agent, ticket.id), subagent: true }
    this.bindings.set(agent, binding); await this.decoratePersona(agent, ticket, binding)
  }
  private bindRemoteSearch(agent: Agent, binding: SessionBinding): void {
    const remote = this.remoteFor(agent.id, agent)
    if (!remote) return
    const ticketId = this.ticketOf(agent)?.id ?? this.remoteOwners.get(agent), persona = ticketId ? this.host.store.tickets.get(ticketId)?.execution?.persona : undefined
    if (persona && personaDenial(persona, 'grep')) return
    const register = this.registerTool(agent, binding)
    const subprocess = this.host.worlds?.lookup(remote.world.status().binding)?.subprocess ?? this.ctx.subprocess
    for (const tool of remoteSearchTools(agent.session.header.cwd!, remote, subprocess))
      register(tool.name, tool.description, tool.schema, tool.execute)
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled && !binding.remote ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
