/** DSH executor: manages one persistent worker session and workspace directory per ticket. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory, verifyLocalWorkspace, workerBin } from '../infra/environment.ts'
import { recordedAttachments, stageAttachments } from '../app/scoped-files.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, RetryLaunch, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import type { Environments } from '../environments/service.ts'
import type { RemoteWorkspace } from '../environments/remote-workspace.ts'
import type { Personas } from '../personas/service.ts'
import type { Sessions } from '../app/sessions.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Speculation } from '../speculation/service.ts'
import type { SpeculationRun } from '../speculation/model.ts'
import { cancelled, collectJob, runningJobs, until, untilQuiet } from './background.ts'
import { collectExecutionEvidence, type ExecutionEvidenceInput } from './evidence.ts'
import { EXECUTION_EVIDENCE_LIMIT, emptyRemoteExecutionEvidence, unavailableExecutionEvidence, type ExecutionEvidence } from '../supervision/execution-evidence.ts'
import { safeLaunchFailure, safeWorkerFailure, WorkerFailureFence } from './failure.ts'
import { automaticRestartBudget, isAutomaticRestartInput } from '../core/recovery.ts'
import { ExecutorStops } from './stops.ts'
import { admissionTrace } from '../infra/admission-trace.ts'

const now = (): string => new Date().toISOString()
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Completed failure retries for a pending launch; interrupted dispatches are held separately, never automatically replayed. */
const LAUNCH_RETRIES = 3
/** How long a worker's background work may run on after its turn ended before it is stopped and the worker reported waiting. */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** How long a host stop waits for the workers' background work to stop. */
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * Internal error thrown when a ticket's workspace prepare command fails during launch.
 * DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
 */
class PrepareFailed extends Error {}
/** Launch transport eligibility uses bounded typed fields; provider requests are retried by Harness itself. */
export const transient = (error: unknown): boolean => safeLaunchFailure(error).retryable
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Host dependencies used by `DshExecutor`. */
export interface ExecutorHost {
  speculation?: Pick<Speculation, 'queued' | 'admit' | 'problem'>
  /** Present in the application runtime; reusable executor-only hosts may supply their own admission boundary. */
  environments?: Environments
  personas?: Pick<Personas, 'snapshot'>
  remote?: RemoteWorkspace
  /** DSH Cordis context: agents and their events, and the subprocess service used to run prepare commands. */
  readonly context: Context
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'db' | 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'ensure' | 'kick' | 'wake' | 'retryState' | 'beginLaunch' | 'finishLaunch'> & Partial<Pick<Effects, 'cancel'>>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir' | 'executionMode'>
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  closing(): boolean
  /** Permit final scoped observations during intentional shutdown, but never after ownership loss. */
  authorizeStopObservation?(): void
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string, remoteRoot?: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir, remoteRoot), name), assignment }
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
const LOCAL_RESUMED = 'This ticket ended earlier and the following input resumed it under the same mandate. Inspect the saved files, '
  + 'published artifacts and new input, then continue within the original scope without repeating completed work. Hand back requests '
  + 'outside that scope with orchestrator_trigger_handback and report dropped. If no work is needed, report dropped without a message. '
  + 'Report ready when the follow-up is done.'
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
export function inputMessage(input: TicketInput, trigger?: object, local = false): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return local ? LOCAL_RESUMED : RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
export class WorkerSlots {
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
   * @param max - Returns the configured maximum number of concurrent worker slots.
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** Number of slots currently in use across running workers and starting reservations. */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free.
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  free(ticketId: string): void { this.starting.delete(ticketId) }
  holds(ticketId: string): boolean { return this.starting.has(ticketId) }
}

/**
 * Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
 * `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
export class DshExecutor implements Executor {
  readonly stops: ExecutorStops
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  private readonly failures: WorkerFailureFence<Agent, Agent['session']>
  /**
   * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  private readonly settling = new Map<string, AbortController>()
  /** Live handlers only; a saved dispatch marker without its handler is an unknown outcome. */
  private readonly launching = new Set<string>()
  private readonly preparingRepositories = new Map<string, AbortController>()
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** When a person's message typed into a worker's Session last started a turn, by ticket. */
  private readonly personal = new Map<string, string>()
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  constructor(private readonly host: ExecutorHost) {
    this.stops = new ExecutorStops({ store: host.store, context: host.context, effects: host.effects, signal: host.lifetime,
      closing: host.closing, authorize: () => { if (host.closing()) throw new Error('Coordinator authority is unavailable') },
      authorizeObservation: () => { if (host.authorizeStopObservation) host.authorizeStopObservation(); else if (host.lifetime.aborted) throw new Error('Coordinator authority is unavailable') },
      remote: record => {
        const ticket = host.store.tickets.get(record.ticketId)
        if (!ticket || !record.execution) return undefined
        return this.remoteFor({ ...ticket, execution: { name: '', assignment: '', ...record.execution } })
      } })
    this.stops.recover()
    this.failures = new WorkerFailureFence(agent => {
      if (host.closing() || host.lifetime.aborted || host.context.agents.get(agent.id) !== agent) return
      const ticket = this.ticketOf(agent), assignment = ticket && latestAssignment(ticket)
      if (!ticket || !liveTicket(ticket) || !assignment || assignment.state === 'ended') return
      return { agent, session: agent.session, assignmentId: assignment.id }
    })
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    // Each launch reserves a worker slot so launches run concurrently while slots are free.
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const selected = ticket.mandate.actor.source === 'workspace' ? sourceTrigger(this.host, ticket)?.meta.environment : undefined
    if (selected && (typeof selected !== 'string' || !this.host.environments)) throw new PrepareFailed('Invalid managed execution world selection')
    const remote = selected ? this.host.environments!.select(selected as string) : this.host.remote
    const execution = { ...ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir, remote?.world.grant.root),
      ...(this.host.machine.executionMode === 'local' ? { mode: 'local' as const } : {}) }
    if (selected) execution.directory = join(remote!.world.grant.root, execution.name)
    const environment = this.host.environments?.bind(execution, selected as string | undefined)
    const reference = ticket.mandate.actor.source === 'workspace' ? sourceTrigger(this.host, ticket)?.meta.persona : undefined
    if (reference && !this.host.personas) throw new PrepareFailed('Persona registry is unavailable')
    const persona = reference ? this.host.personas!.snapshot(reference) : undefined
    return { ...ticket, ...(environment ? { mandate: { ...ticket.mandate, environment } } : {}),
      execution: { ...execution, ...(environment ? { environment } : {}), ...(persona ? { persona } : {}) } }
  }
  /**
   * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
   * execution environment variables, then verifies the directory as the worker sees it.
   * Local mode runs the same command. It runs only when the directory is absent. A non-empty directory left by a failed
   * command is kept and not overwritten; an empty one is removed so the next assignment can run the command again.
   * The command's PATH starts with the worker shims, so `DSH_SUPERAGENT_BLOCKED_COMMANDS` fail by name. Let the command
   * exit non-zero on failure; do not append `|| true`.
   * @throws PrepareFailed with the command's output when the prepare command fails.
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    const remote = this.remoteFor(ticket)
    if (remote) {
      if (ticket.execution?.mode !== 'local') throw new PrepareFailed('Remote repository execution requires endpoint credential bindings')
      await remote.mkdir(directory)
      return
    }
    await mkdir(dirname(directory), { recursive: true })
    const local = ticket.execution?.mode === 'local'
    const command = this.host.store.settings().executor.prepare.trim()
    const env: Record<string, string> = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    env.PATH = [workerBin(this.host.machine.stateDir), process.env.PATH ?? ''].filter(Boolean).join(delimiter)
    // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
        await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    if (!local) await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.stops.activate(ticket.id)
    this.host.speculation?.queued(ticket, assignment)
    this.host.effects.ensure('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
    if (this.heldLaunch(assignment.id)) this.launchUnknown(ticket.id)
  }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, assignment: Assignment): void {
    if (this.heldLaunch(assignment.id)) { this.launchUnknown(ticket.id); return }
    this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId) return
    await this.stopped(ticketId)
    const stopProblem = this.stops.problem(ticketId)
    if (stopProblem) throw new Later(stopProblem)
    if (this.host.effects.retryState('launch', assignmentId)?.launchStarted) {
      if (!waitsForPerson(ticket)) this.launchUnknown(ticket.id)
      throw new Later('Original launch outcome remains unknown')
    }
    if (assignment.state !== 'pending' || waitsForPerson(ticket)) return
    await this.host.speculation?.admit(ticket, assignment)
    this.slots.reserve(ticketId, 'launch')
    try {
      const failures = this.host.effects.retryState('launch', assignmentId)?.attempts ?? LAUNCH_RETRIES
      this.host.effects.beginLaunch(assignmentId)
      this.launching.add(assignmentId)
      try { await this.launch(ticket, assignment); this.host.effects.finishLaunch(assignmentId) }
      catch (error) {
        // Shutdown leaves an uncertain launch held under its original identity; known transient launch failures use queue backoff.
        // A failed prepare command is not retried automatically because an existing directory counts as prepared, so retrying
        // would treat whatever a failed prepare command left behind in the directory as a prepared workspace; instead the
        // ticket is marked failed and waits until new human input or an explicit retry arrives.
        if (this.host.closing()) throw new Later('Launch interrupted during shutdown')
        const current = this.host.store.tickets.get(ticketId)
        if (current && liveTicket(current) && latestAssignment(current)?.id === assignmentId && latestAssignment(current)?.state === 'running') {
          this.host.context.agents.get(workerSessionId(ticketId) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
          const loaded = this.host.context.agents.get(workerSessionId(ticketId) as SessionId)
          if (loaded) this.holdAutomaticInbox(loaded, current)
          this.launchUnknown(ticketId)
          throw new Later('Accepted launch acknowledgement remains uncertain')
        }
        if (error instanceof Later) { this.host.effects.finishLaunch(assignmentId); throw error }
        const failure = safeLaunchFailure(error)
        if (!(error instanceof PrepareFailed) && failure.retryable && failures < LAUNCH_RETRIES) throw new RetryLaunch(failure.summary)
        this.host.store.atomic(() => {
          this.launchFailed(ticketId, assignmentId, error instanceof PrepareFailed ? error
            : new Error(`${failure.summary} Completed launch failures: ${failures + 1}; allowance: ${LAUNCH_RETRIES + 1}.`))
          this.host.effects.finishLaunch(assignmentId)
        })
      }
    } finally { this.launching.delete(assignmentId); this.slots.free(ticketId) }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    // A stop of the worker's background work ends with a cancel, which would drop what is delivered meanwhile.
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    if (this.heldLaunch(target.id)) { this.launchUnknown(ticketId); return }
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          if (!this.stops.owns(this.host.context.agents.get(sessionId as SessionId), assignment.id)) {
            this.stopWork(ticketId, 'Original worker admission continuity is unavailable', true)
            await this.stopped(ticketId)
          }
          // Recreate the worker session if it was externally deleted.
          if (!this.host.context.agents.get(sessionId as SessionId)) {
            await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker')
          }
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      if (this.heldLaunch(assignment.id)) throw new Later('Original launch outcome remains unknown')
      const stopProblem = this.stops.problem(ticket.id)
      if (stopProblem) throw new Later(stopProblem)
      if (waitsForPerson(current) && isAutomaticRestartInput(current, input)) throw new Later('Automatic recovery input is held')
      const problem = this.host.speculation?.problem(current)
      if (problem) throw new Later(problem)
      // A stop of the worker's background work that started meanwhile ends with a cancel, which would drop the Input.
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger, ticket.execution?.mode === 'local')
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    const consumed = await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', () => {
      live()
      const agent = this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)
      if (!agent) throw new Later('Original worker Session is unavailable')
      this.stops.admitted(agent, assignment.id)
    })
    // A previous attempt may have committed history before the Store's acknowledgement. Deduplication must repair that acknowledgement too.
    if (consumed) this.host.engine.inputsRead(ticket.id, [input.id])
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
   * report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const stopId = this.stops.request(ticket, assignment, { ownTurn })
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      this.preparingRepositories.get(ticket.id)?.abort(new Error(reason))
      this.track(ticket.id, this.stops.run(stopId))
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /** Stop what a ticket's worker runs in the background (see `stopBackground`). */
  private stopWork(ticketId: string, reason: string, keepInbox = false): void {
    this.preparingRepositories.get(ticketId)?.abort(new Error(reason))
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    if (ticket && assignment) this.track(ticketId, this.stops.run(this.stops.request(ticket, assignment, { keepInbox })))
  }
  /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
    const problem = this.stops.problem(ticketId)
    if (problem) throw new Later(problem)
  }
  /** Host-governed stop without impersonating a human cancellation or discarding saved preparation. */
  halt(ticketId: string, reason: string, assignmentId?: string): void {
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket && (assignmentId ? ticket.assignments.find(item => item.id === assignmentId) : latestAssignment(ticket))
    if (!ticket || !assignment) return
    const stopId = this.stops.request(ticket, assignment)
    if (assignmentId ?? assignment?.id) this.host.effects.cancel?.('launch', assignmentId ?? assignment!.id)
    if (!assignmentId || latestAssignment(ticket)?.id === assignmentId) this.host.effects.cancel?.('delivery', ticketId)
    this.host.store.afterCommit(() => {
      if (latestAssignment(this.host.store.tickets.get(ticketId)!)?.id === assignment.id) this.preparingRepositories.get(ticketId)?.abort(new Error(reason))
      this.track(ticketId, this.stops.run(stopId))
    })
  }
  /** Runtime activity, including a launch that reserved a slot but has not delivered an assignment. */
  busy(ticketId: string): boolean {
    const ticket = this.host.store.tickets.get(ticketId)
    return this.slots.holds(ticketId) || !!ticket && this.running(ticket)
  }
  /** Prove known work quiet; a missing local process after restart needs an evidenced operator attestation. */
  async quiescence(run: SpeculationRun): Promise<string | undefined> {
    if (this.stops.problem(run.ticketId)) return
    if (this.slots.holds(run.ticketId) || this.stopping.has(run.ticketId)) return
    const ticket = this.host.store.tickets.get(run.ticketId)
    if (!ticket) return
    const ctx = this.host.context, queue = [workerSessionId(run.ticketId)], seen = new Set<string>()
    const children = ctx.get('subagents') as { listChildren(id: string): Promise<readonly { id: string }[]> } | undefined
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      if (seen.size >= 128) return
      seen.add(id)
      if (ctx.agents.get(id as SessionId)?.status === 'running' || runningJobs(ctx, id).length) return
      if (children) {
        const result = await until(children.listChildren(id), this.host.lifetime, 2000)
        if (result === false) return
        queue.push(...result.map(item => item.id))
      }
    }
    let remote: RemoteWorkspace | undefined
    try { remote = this.remoteFor({ ...ticket, execution: run.execution }) } catch { return }
    if (remote) {
      if (await until(remote.world.refreshEffects(), this.host.lifetime, 2000) === false) return
      if (!remote.world.quiescent(run.ticketId)) return
    }
    if (this.stops.problem(run.ticketId) || this.slots.holds(run.ticketId) || this.stopping.has(run.ticketId)
      || [...seen].some(id => ctx.agents.get(id as SessionId)?.status === 'running' || runningJobs(ctx, id).length)) return
    if (remote) return 'Harness workers/jobs and original endpoint effect receipts are quiescent'
    if (run.recovered && !run.attestation) return
    return run.attestation ? 'Local recovery attestation and current Harness activity checked' : 'Current Harness workers, descendants and owned jobs are idle'
  }
  /**
   * On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
   * of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
   */
  async shutdown(): Promise<void> {
    for (const preparation of this.preparingRepositories.values()) preparation.abort(new Error('Coordinator is stopping'))
    this.prepareShutdown()
    for (const { collect } of this.left.values()) collect.abort()
    await this.stops.idle()
  }
  /** Persist original stop intent before Runtime cancels turns or releases its ownership. */
  prepareShutdown(): void {
    for (const ticket of this.host.store.tickets.list()) {
      const assignment = latestAssignment(ticket)
      if (assignment && this.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
        this.stops.request(ticket, assignment, { keepInbox: true })
    }
  }
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  private launchUnknown(ticketId: string): void {
    this.failed(ticketId, 'Worker launch was interrupted; its outcome is unknown. Review the original assignment and execution receipts before explicitly retrying. No replacement launch was dispatched.')
  }
  private heldLaunch(assignmentId: string): boolean {
    return !!this.host.effects.retryState('launch', assignmentId)?.launchStarted && !this.launching.has(assignmentId)
  }
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  private remoteFor(ticket: Ticket): RemoteWorkspace | undefined { return this.host.environments ? this.host.environments.remoteFor(ticket) : this.host.remote }
  /** Bounded observation only: loading a Session or probing the endpoint would change the execution being supervised. */
  executionEvidence(ticket: Ticket): ExecutionEvidence {
    const assignmentId = latestAssignment(ticket)?.id ?? null, sessionId = workerSessionId(ticket.id)
    const current = this.host.store.tickets.get(ticket.id)
    if (!current || (latestAssignment(current)?.id ?? null) !== assignmentId) return unavailableExecutionEvidence(sessionId, assignmentId)
    const cap = (value: number) => Math.min(EXECUTION_EVIDENCE_LIMIT, Math.max(0, value))
    const result = collectExecutionEvidence({ sessionId, assignmentId,
      agents: { get: id => this.host.context.agents.get(id as SessionId), list: () => this.host.context.agents.list() },
      jobs: () => this.host.context.get('jobs') as ReturnType<ExecutionEvidenceInput['jobs']>,
      handedOff: this.left.get(ticket.id)?.jobs ?? new Set<string>(),
      executor: { availability: 'available', provenance: 'process-and-durable-queue', retrying: false,
        turnRetryAttempts: 0, launchRetryAttempts: cap(assignmentId ? this.host.effects.retryState('launch', assignmentId)?.attempts ?? 0 : 0),
        recovery: { providerRetryOwner: 'harness', terminalTurnRetries: 0, launchRetryLimit: LAUNCH_RETRIES,
          hostRestart: { ...automaticRestartBudget(current), limit: 3 } },
        settling: this.settling.has(ticket.id), preparing: this.preparingRepositories.has(ticket.id), stopping: this.stopping.has(ticket.id),
        knownHandedOffJobs: this.left.get(ticket.id)?.jobs.size ?? 0 },
      remoteEffects: () => {
        const remote = this.remoteFor(current)
        const expectedWorld = current.execution?.environment?.world
        if (!assignmentId || !remote && !expectedWorld) return emptyRemoteExecutionEvidence('not_applicable')
        return remote && expectedWorld ? remote.world.executionEvidence(current.id, assignmentId, expectedWorld) : emptyRemoteExecutionEvidence()
      } })
    const after = this.host.store.tickets.get(ticket.id)
    return after && (latestAssignment(after)?.id ?? null) === assignmentId ? result : unavailableExecutionEvidence(sessionId, assignmentId)
  }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const remote = this.remoteFor(ticket)
    if (!remote) return this.launchOwned(ticket, assignment)
    return remote.world.withOwner({ kind: 'assignment', ticketId: ticket.id, assignmentId: assignment.id,
      sessionId: workerSessionId(ticket.id), callId: `prepare:${assignment.id}`, tool: 'workspace-prepare' }, () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (this.host.closing() || !current || !liveTicket(current) || latestAssignment(current)?.id !== assignment.id)
        throw new PrepareFailed('Assignment changed before remote workspace preparation')
      if (this.host.paused()) throw new Later('Processing is paused')
      const problem = this.host.speculation?.problem(current)
      if (problem) throw new Later(problem)
    }, () => this.launchOwned(ticket, assignment))
  }
  private async launchOwned(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      const held = this.stops.problem(ticket.id)
      if (held) throw new Later(held)
      const problem = stored && this.host.speculation?.problem(stored)
      if (problem) throw new Later(problem)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const remote = this.remoteFor(ticket)
    const workspace = ticket.execution?.directory ?? ''
    if ((ticket.execution?.mode ?? 'repository') !== (this.host.machine.executionMode ?? 'repository'))
      throw new PrepareFailed('Ticket execution mode differs from this profile')
    if (!current()) return
    if (this.host.environments) {
      try { ticket = this.host.environments.pin(ticket); await this.host.environments.validate(ticket) }
      catch (error) { throw new PrepareFailed(`Execution environment unavailable: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (!current()) return
    // Repository worlds require the original endpoint receipt; a partial or preexisting directory is never adopted.
    if (remote?.repository) {
      const preparation = new AbortController()
      this.preparingRepositories.set(ticket.id, preparation)
      try { await remote.prepareRepository(workspace, ticket.id, preparation.signal) }
      catch (error) { throw new PrepareFailed(String(error)) }
      finally { if (this.preparingRepositories.get(ticket.id) === preparation) this.preparingRepositories.delete(ticket.id) }
      if (!current()) return
    } else if (!await (remote ? remote.exists(workspace) : stat(workspace).then(() => true, () => false))) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (this.host.environments) await this.host.environments.validate(ticket).catch((error: unknown) => { throw new PrepareFailed(String(error)) })
    if (ticket.execution?.mode === 'local') await (remote ? remote.verify(workspace)
      : verifyLocalWorkspace(workspace, this.host.context.subprocess, this.host.lifetime, this.host.context.fs))
      .catch((error: unknown) => { throw new PrepareFailed(`Local task directory is unavailable: ${String(error)}`) })
    if (!current()) return
    // An existing non-empty directory was left untouched by prepare. Copies land beside it and do not replace those files.
    if (!remote) await stageAttachments(workspace, recordedAttachments(this.host.store, ticket))
      .catch((error: unknown) => { this.host.context.logger.warn('dsh-superagent could not stage an attachment: %s', error instanceof Error ? error.message : String(error)) })
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) return
    this.removeLegacyContinuations(agent, ticket)
    // The background work of the Assignment this one replaces stops first, so its end does not clear this one's message.
    await this.stopped(ticket.id)
    if (!current()) return
    // A message put back for this Assignment may still wait in the Session, kept by a restart's cancel or persisted across a
    // crash, where this launch's message would take it into a step beside the copy delivered next: that copy is the only one.
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: ticket.execution?.mode === 'local'
      ? 'A person retried this task. Continue from its saved files, artifacts and current assignment.' : RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(remote?.repository ? { repository: { url: remote.repository.url, baseCommit: remote.repository.commit, branch: 'agentic/' + ticket.id,
          note: 'This is the original prepared source. Continue from current files and Git history; do not reset the task to the base commit. External publication requires its own authorization.' } } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    const stateOf = () => this.host.store.tickets.get(ticket.id)?.assignments.find(item => item.id === assignment.id)?.state ?? null
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => {
        admissionTrace('launch.authorize', { assignmentId: assignment.id, state: stateOf() })
        if (!current()) throw new Error('Launch authorization changed before worker delivery')
        // Record the admission first so an unconfirmed stop still refuses the launch. Then mark the assignment
        // running before the message is queued: the worker prompt guard reads that state during the turn that
        // the queue starts, which is before this delivery's accepted callback.
        this.stops.admitted(agent, assignment.id)
        this.host.engine.assignmentStarted(ticket.id, assignment.id, false)
        admissionTrace('launch.authorize.running', { assignmentId: assignment.id, state: stateOf() })
      },
      () => {
        admissionTrace('launch.accepted.before', { assignmentId: assignment.id, state: stateOf() })
        this.host.engine.assignmentStarted(ticket.id, assignment.id)
        admissionTrace('launch.accepted.after', { assignmentId: assignment.id, state: stateOf() })
      })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private removeLegacyContinuations(agent: Agent, ticket: Ticket): void {
    for (const assignment of ticket.assignments) for (let attempt = 1; attempt <= 3; attempt++)
      agent.inbox.remove(this.host.sessions.promptedId(`retry:${assignment.id}:${attempt}`))
  }
  private holdAutomaticInbox(agent: Agent, ticket: Ticket): void {
    this.removeLegacyContinuations(agent, ticket)
    agent.inbox.remove(this.host.sessions.promptedId(`assignment:${ticket.id}`))
    for (const assignment of ticket.assignments) agent.inbox.remove(this.host.sessions.promptedId(`assignment:${ticket.id}:${assignment.id}`))
    for (const input of ticket.inputs) if (isAutomaticRestartInput(ticket, input)) agent.inbox.remove(this.host.sessions.promptedId(input.id))
  }
  /** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/created', ({ agent }) => {
      const ticket = this.ticketOf(agent)
      if (ticket && ctx.agents.get(agent.id) === agent) {
        this.removeLegacyContinuations(agent, ticket)
        const assignment = latestAssignment(ticket)
        if (waitsForPerson(ticket) || assignment && this.heldLaunch(assignment.id)) this.holdAutomaticInbox(agent, ticket)
      }
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      if (this.host.closing() || this.host.lifetime.aborted || ctx.agents.get(agent.id) !== agent) return
      if (status === 'idle') { const id = ticketOfSession(agent.id); if (id) this.stops.refresh(id) }
      // A turn that starts ends the look at its worker's background work; the turn's own idle looks afresh.
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // The turn a stop of the worker's subagents woke and cancelled is no turn of the worker's.
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket) && !this.stops.problem(ticket.id)) void this.background(this.workerIdle(ticket, assignment, agent))
    }))
    // A person's message typed into a worker's Session, which the ticket does not record.
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (this.host.closing() || ctx.agents.get(agent.id) !== agent) return
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // The Inputs a message of dsh-superagent's carries, which its worker reads once the Session took the message into its
    // history: a step that claimed it may be cancelled or fail before, which drops it.
    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (this.host.closing() || this.host.lifetime.aborted) return
      const agent = ctx.agents.get(session.id)
      if (!agent || agent.session !== session) return
      const ticket = this.ticketOf(agent), assignment = ticket && latestAssignment(ticket)
      if (assignment && event.type === 'turn/start') {
        admissionTrace('session.turn/start', { assignmentId: assignment.id, state: assignment.state, turn: event.data.turn })
        this.stops.turnStarted(agent, event.data.turn); this.failures.beginTurn(agent, session, assignment.id, event.data.turn)
      }
      if (assignment && event.type === 'step/start') this.failures.beginStep(agent, session, assignment.id, event.data.turn, event.data.step)
      if (assignment && event.type === 'turn/end') this.failures.endTurn(agent, session, assignment.id, event.data.turn)
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind !== 'reopen' && !input.readAt
          && this.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }))
    this.disposers.push(ctx.on('agent/request', ({ agent, turn, step, signal }, next) => {
      const ticket = this.ticketOf(agent), assignment = ticket && latestAssignment(ticket)
      admissionTrace('agent/request', { assignmentId: assignment?.id ?? null, state: assignment?.state ?? null, turn, allowed: assignment ? this.stops.turnAllowed(agent, assignment.id, turn) : null })
      if (ticket && this.stops.problem(ticket.id)) throw new Error('Original work is not confirmed stopped')
      if (ticket && assignment && !this.stops.turnAllowed(agent, assignment.id, turn)) throw new Error('Original worker turn has no current assignment admission')
      if (ticket && assignment) this.stops.beforeAdmission(ticket.id, assignment.id)
      if (assignment) this.failures.request(agent, agent.session, assignment.id, turn, step, signal)
      return next()
    }))
    this.disposers.push(ctx.on('agent/disposed', ({ agent }) => { this.failures.retire(agent) }))
    this.disposers.push(ctx.on('agent/error', ({ agent, turn, step, error }) => {
      const ticket = this.ticketOf(agent), assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.stops.problem(ticket.id) || !this.stops.turnAllowed(agent, assignment.id, turn)
        || !this.failures.consumeTerminal(agent, agent.session, assignment.id, turn, step)) return
      // Harness owns request retries. A terminal error records a human-visible hold; it never creates another model turn.
      try { this.failed(ticket.id, safeWorkerFailure(error).summary) }
      catch { this.host.health.set({ state: 'error', detail: 'Worker failure could not be recorded', at: now() }) }
    }))
  }
  /** Unsubscribes worker events; provider retry lifecycle remains owned by Harness. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.failures.clear()
  }
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  resume(): void {
    // Launch pending tickets oldest first (in acceptance order).
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      const loaded = this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)
      if (loaded) this.removeLegacyContinuations(loaded, ticket)
      if (latest && this.host.effects.retryState('launch', latest.id)?.launchStarted) {
        if (loaded) this.holdAutomaticInbox(loaded, ticket)
        this.stopWork(ticket.id, 'Original launch outcome remains unknown', true)
        if (!waitsForPerson(ticket)) this.launchUnknown(ticket.id)
        continue
      }
      if (running) {
        // A restart within this process left DSH's Sessions, jobs and subagents running: they stop first. The inbox keeps an
        // Input that was handed over but not yet taken.
        const agent = this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)
        if (automaticRestartBudget(ticket).exhausted || waitsForPerson(ticket)) {
          if (agent) this.holdAutomaticInbox(agent, ticket)
        }
        this.stopWork(ticket.id, 'dsh-superagent restarted', true)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      }
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background(work: Promise<unknown>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
   * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
   */
  private handOff(ticketId: string, agent: Agent): void {
    const ticket = this.host.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    if (ticket && assignment) this.track(ticketId, this.stops.run(this.stops.request(ticket, assignment, { scope: 'descendants', keepInbox: true })))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended) return
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
    await agent.whenIdle()
    if (this.host.context.agents.get(agent.id) !== agent || agent.status !== 'idle') return
    // The ticket while the Assignment that went idle runs it.
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person;
    // an Input delivered after its result or question is new work.
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // A turn a person started in the Session is the person's work, which goes on in the background as any turn's does.
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // The worker read what reached it before a turn that ended: one it handed off with, or one whose background work ended.
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile: at most for the limit from
    // this idle, and until the worker runs again or the Assignment ends.
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current) return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // Its shell jobs that ran past the limit are killed, which it is told at its next turn; its subagents, whose stop would
      // wake it, go on.
      const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name)
      if (jobs.length) {
        this.track(ticket.id, this.stops.run(this.stops.request(current, idle, { scope: 'jobs',
          jobIds: runningJobs(this.host.context, sessionId, left).map(job => job.id) })))
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended; their stop was requested: ${jobs.join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
    if (handedOff(current)) return
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
  }
}
