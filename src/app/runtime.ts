/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, canStop, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, executionRoot, type Variable } from './execution-environment.ts'
import { RemoteWorkspace, remoteWorld } from '../environments/remote-workspace.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId, ticketOfSession } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { Supervision } from '../supervision/service.ts'
import { Workspace } from '../workspace/service.ts'
import { Inbox } from '../workspace/inbox.ts'
import { Library } from '../workspace/library.ts'
import { Environments } from '../environments/service.ts'
import { Endpoints } from '../environments/endpoints.ts'
import { Personas } from '../personas/service.ts'
import { resolveRoleModel } from './role-models.ts'
import { WorldPool } from '../environments/pool.ts'
import { openRuntimeOwnership, assertOwnership, ownershipReady } from '../ownership/runtime.ts'
import type { CoordinatorOwnership } from '../ownership/lease.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly supervision: Supervision
  readonly workspace: Workspace
  readonly inbox: Inbox
  readonly library: Library
  readonly environments: Environments
  readonly endpoints: Endpoints
  readonly personas: Personas
  readonly worlds: WorldPool
  readonly remoteWorkspace?: RemoteWorkspace
  readonly ownership?: CoordinatorOwnership
  readonly ready: Promise<void>
  private quiescing?: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private readonly environmentHealth = this.board.claim('environment')
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private initialized = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      if (store.get(KV.recovery.hold)) throw new Error('This is a staged checkpoint restore. Reconcile coordinator ownership, Sessions and external effects before enabling execution.')
      const world = remoteWorld(ctx)
      if (machine.ownership && machine.executionMode !== 'local') throw new Error('Ownership-controlled repository publication requires a fenced publication service; use a general-mission profile until that integration is available')
      if (world) assertOwnership(machine.ownership, world.ownershipBinding)
      this.ownership = openRuntimeOwnership(store, machine.ownership, [executionRoot(store.settings(), machine.stateDir, world?.grant.root)])
      const remote = this.remoteWorkspace = world ? new RemoteWorkspace(world, ctx.fs, ctx.subprocess, this.lifetime) : undefined
      const environments = this.environments = new Environments({ store, filesystem: ctx.fs, subprocess: ctx.subprocess, lifetime: this.lifetime,
        remote, ownership: this.ownership, worlds: () => runtime.worlds, root: () => executionRoot(store.settings(), machine.stateDir, world?.grant.root), mode: () => machine.executionMode ?? 'repository', engine: () => runtime.engine })
      this.endpoints = new Endpoints({ store, stateDir: machine.stateDir, lifetime: this.lifetime, ownership: this.ownership, ownershipConfig: machine.ownership,
        workerRoots: () => [...environments.list().items.filter(item => item.kind === 'local').flatMap(item => [item.root, item.configuredRoot]),
          ...(!world ? [executionRoot(store.settings(), machine.stateDir)] : [])] })
      this.worlds = new WorldPool(ctx, { store, endpoints: this.endpoints, lifetime: this.lifetime, ownership: this.ownership, ownershipConfig: machine.ownership, report,
        revoked: binding => { for (const ticket of store.tickets.open()) if (ticket.execution?.environment?.environmentId === binding && canStop(ticket)) runtime.engine.stopTicket(ticket.id, 'Managed execution world revoked by the operator') } })
      const library = this.library = new Library(store)
      const personas = this.personas = new Personas(store, async model => { await resolveRoleModel(ctx, model) })
      const workspace = this.workspace = new Workspace(store, () => runtime.engine, () => !this.paused() && !this.closing(),
        id => library.evidenceRevision(id), ticket => environments.allows(ticket.execution?.environment), reference => personas.snapshot(reference), reference => environments.select(reference))
      const inbox = this.inbox = new Inbox(store, workspace, library,
        async id => (await ctx.sessionController.inspect(id as SessionId, AbortSignal.any([this.lifetime, AbortSignal.timeout(15_000)]))).events)
      this.disposers.push(ctx.on('session/event', (session, event) => {
        const id = ticketOfSession(session.id)
        if (id) inbox.record(id, event)
      }))
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart, remote,
        incompatibleTickets: () => store.tickets.open().some(ticket => ticket.execution
          && (ticket.execution.mode ?? 'repository') !== (machine.executionMode ?? 'repository')) })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu,
        () => machine.executionMode === 'local')
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      }, id => this.ownership ? id === 'workspace' : id !== 'github' || machine.executionMode !== 'local')
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      this.disposers.push(sources.register(workspace.source))
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime, remote, worlds: this.worlds, personas, ownership: this.ownership, environmentAllowed: ticket => environments.allows(ticket.execution?.environment),
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine, environments, remote, personas,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => environments.policy(workspace.policy(settingsPolicy(store.settings(), sources)))
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured() && setup.deployment.repository) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      this.supervision = new Supervision({ store, engine, stateDir: machine.stateDir,
        configured: () => setup.configured() && !this.closing() && !this.lifetime.aborted, health: () => this.health })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources, library, planning: workspace.plans, personas, worlds: this.worlds,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      if (this.ownership) {
        const lost = () => {
          if (this.closingFlag) return
          this.initialized = false; this.stopped.abort(this.ownership!.signal.reason)
          this.runtimeHealth.set({ state: 'error', detail: 'Coordinator ownership lost; execution is stopped. Restart only after inspecting receipts.', at: now() })
          void this.passes.stop().catch(report)
          for (const id of [this.masterId, ...store.tickets.list().map(ticket => workerSessionId(ticket.id))])
            ctx.agents.get(id as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
          this.quiescing = this.executor.shutdown().catch(report)
        }
        this.ownership.signal.addEventListener('abort', lost, { once: true })
        this.disposers.push(() => this.ownership!.signal.removeEventListener('abort', lost))
      }
      this.ready = this.initialize().catch(async error => {
        await this.ownership?.close()
        if (!this.closingFlag) this.runtimeHealth.set({ state: 'error', detail: `Initialization failed: ${String(error)}`, at: now() })
        throw error
      })
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> {
    const ready = !this.closingFlag && this.environments.ready()
    this.environmentHealth.set({ state: ready ? 'ready' : 'paused',
      detail: ready ? 'Execution environment is enrolled and verified' : 'Execution environment needs enrollment, verification or authorization' })
    return this.board.all
  }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag || this.lifetime.aborted }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.initialized || this.closing() || !ownershipReady(this.ownership) || !this.setup.configured() || !this.environments.ready() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    await this.ownership?.start()
    this.lifetime.throwIfAborted()
    if (this.ownership && this.remoteWorkspace) await this.remoteWorkspace.world.refresh()
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    await this.environments.initialize().catch(error => this.ctx.logger.warn('Execution environment enrollment: %s', String(error)))
    await this.worlds.initialize()
    if (this.closing()) return
    if (this.remoteWorkspace && !this.environments.ready()) {
      this.runtimeHealth.set({ state: 'paused', detail: 'Remote execution environment requires authorization or enrollment', at: now() }); return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.remoteWorkspace?.world.grant.root ?? this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.initialized = true
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, get ready() { return runtime.ready }, sourceLinks, remoteRoot: this.remoteWorkspace?.world.grant.root,
      ownership: this.ownership, authorizeMutation: () => { this.ownership?.proof(); this.lifetime.throwIfAborted() },
      get health() { return runtime.health }, remoteEffects: this.remoteWorkspace?.world,
      supervision: this.supervision, workspace: this.workspace, library: this.library, inbox: this.inbox, environments: this.environments, endpoints: this.endpoints, personas: this.personas, worlds: this.worlds,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    // Abort an acquisition wait before awaiting any startup-dependent work; loss is terminal for this instance.
    const ownership = this.ownership?.close()
    try {
      await this.endpoints.stop()
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await (this.quiescing ??= this.executor.shutdown())
      this.executor.dispose()
      this.sessions.dispose()
      await this.worlds.stop()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      await ownership
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
