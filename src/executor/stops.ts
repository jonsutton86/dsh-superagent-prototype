/** Original-scope stop receipts and observation, sharing the main Store and Effects authority. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Assignment, Ticket } from '../core/index.ts'
import type { RemoteWorkspace } from '../environments/remote-workspace.ts'
import { WorkspaceError } from '../workspace/model.ts'
import { cancelled, killJobs, until } from './background.ts'
import { StopAttestationRequest, StopAttestationReceiptSchema, StopRecordSchema, stopHeld, stopSummary,
  type StopAttestationReceipt, type StopDetail, type StopRecord } from './stop-model.ts'
import { readStop, saveStop, stopDigest, stopExecutionDigest, stopHolds, stopScopeDigest } from './stop-store.ts'
export { stopHolds } from './stop-store.ts'

interface Jobs { list(owner: string): readonly { id: string; owner?: string; status: string }[] }
interface Children { listChildren(owner: string): Promise<readonly { id: string }[]>; drainChildren(parent: Agent, ids: readonly string[]): Promise<void> }
interface Binding { agent: Agent; session: Agent['session']; jobs: unknown; children: unknown }
// Module-lifetime evidence only. Reloaded Sessions and empty registries cannot establish an earlier dispatch's continuity.
const admissions = new WeakMap<Agent, Binding & { assignmentId: string }>()
const unsettledDrains = new WeakMap<Agent, Set<Promise<void>>>()
const turns = new WeakMap<Agent, { session: Agent['session']; turn: number; assignmentId: string | undefined }>()
interface Host {
  store: Pick<Store, 'db' | 'tickets' | 'atomic' | 'afterCommit'>; context: Context;
  effects: Pick<Effects, 'ensure' | 'handle' | 'kick' | 'wake'>; signal: AbortSignal;
  remote(record: StopRecord): RemoteWorkspace | undefined; authorize(): void; authorizeObservation(): void; closing(): boolean;
}
const active = (status: string) => status === 'running' || status === 'stopping'
const terminal = (status: string) => ['completed', 'failed', 'killed'].includes(status)
const NOW = () => new Date().toISOString()

/**
 * Persists intent before cancellation, and releases admission only after scoped observation or original-bound operator evidence.
 * Queue work and direct shutdown share one live operation. A cold restore never acquires a new local cancellation target.
 */
export class ExecutorStops {
  private readonly instance = randomUUID()
  private readonly bindings = new Map<string, Binding>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly observations = new Map<string, Promise<StopDetail>>()
  constructor(private readonly host: Host) {
    host.effects.handle('stop', async ({ stopId }) => {
      await this.run(stopId)
      if (stopHeld(this.require(stopId))) throw new Later('Original work is not confirmed stopped')
    }, { limit: () => 4, retry: [2000, 30000], quiet: true })
  }
  private require(id: string): StopRecord {
    const record = readStop(this.host.store.db, id)
    if (!record) throw new WorkspaceError(404, 'Original stop was not found')
    return record
  }
  private *records(ticketId: string): Generator<StopRecord> {
    for (const row of this.host.store.db.prepare('SELECT value FROM executor_stop WHERE ticket=? ORDER BY rowid DESC').iterate(ticketId))
      yield StopRecordSchema.parse(JSON.parse(String(row.value)))
  }
  holds(ticketId: string) { return stopHolds(this.host.store, ticketId) }
  /** Called at the original worker delivery boundary, never merely when a Session is loaded. */
  admitted(agent: Agent, assignmentId: string): void {
    const ticketId = agent.id.startsWith('worker-') ? agent.id.slice(7) : undefined
    if (ticketId) this.beforeAdmission(ticketId, assignmentId)
    admissions.set(agent, { agent, assignmentId, session: agent.session, jobs: this.host.context.get('jobs'), children: this.host.context.get('subagents') })
  }
  /** Bind a native or delivered turn to the admission that existed when that exact turn began. */
  turnStarted(agent: Agent, turn: number): void {
    turns.set(agent, { session: agent.session, turn, assignmentId: admissions.get(agent)?.assignmentId })
  }
  turnAllowed(agent: Agent, assignmentId: string, turn: number): boolean {
    const bound = turns.get(agent), admitted = admissions.get(agent)
    return !!bound && bound.turn === turn && bound.session === agent.session && bound.assignmentId === assignmentId
      && admitted?.assignmentId === assignmentId && admitted.session === agent.session && this.host.context.agents.get(agent.id) === agent
  }
  owns(agent: Agent | undefined, assignmentId: string): boolean {
    const admitted = agent && admissions.get(agent)
    return !!agent && !!admitted && admitted.assignmentId === assignmentId && admitted.session === agent.session
      && admitted.jobs === this.host.context.get('jobs') && admitted.children === this.host.context.get('subagents')
      && this.host.context.agents.get(agent.id) === agent
  }
  executionAllowed(agent: Agent, assignmentId: string): boolean {
    const bound = turns.get(agent)
    return this.owns(agent, assignmentId) && bound?.session === agent.session && bound.assignmentId === assignmentId
  }
  /** Consume reusable full-stop coverage before any later model/tool/direct-Session work under that same assignment. */
  beforeAdmission(ticketId: string, assignmentId: string): void {
    const problem = this.problem(ticketId)
    if (problem) throw new Error(problem)
    this.host.store.atomic(() => {
      for (const row of this.host.store.db.prepare("SELECT value FROM executor_stop WHERE assignment=? AND state='quiet' AND json_extract(value,'$.coverageConsumed')=0").iterate(assignmentId)) {
        const record = StopRecordSchema.parse(JSON.parse(String(row.value)))
        if (record.ticketId === ticketId && (record.scope === 'all' || record.scope === 'legacy')) this.update(record, { coverageConsumed: true })
      }
    })
  }
  /** Install holds before restored Sessions can consume native notifications or queued messages. */
  recover(): void {
    for (const ticket of this.host.store.tickets.open()) {
      const assignment = ticket.assignments.at(-1)
      if (assignment && (assignment.state === 'running' || this.host.store.db.prepare("SELECT 1 FROM effect WHERE kind='launch' AND key=? AND launch_started=1").get(assignment.id)))
        this.request(ticket, assignment, { keepInbox: true })
    }
    // An interrupted operator validation never becomes accepted by absence. Preserve its original request and explicit refusal.
    for (const row of this.host.store.db.prepare("SELECT id,value FROM executor_stop_control WHERE json_extract(value,'$.phase')='pending'").iterate()) {
      const receipt = StopAttestationReceiptSchema.parse(JSON.parse(String(row.value)))
      this.host.store.db.prepare('UPDATE executor_stop_control SET value=? WHERE id=?').run(JSON.stringify({ ...receipt, phase: 'refused', settledAt: NOW(),
        reason: 'Operator evidence validation was interrupted; original stop remains held' }), String(row.id))
    }
  }
  problem(ticketId: string): string | undefined { return this.host.store.db.prepare("SELECT 1 FROM executor_stop WHERE ticket=? AND state NOT IN ('quiet','dormant') LIMIT 1").get(ticketId)
    ? 'Original work is not confirmed stopped; inspect its stop receipt' : undefined }
  /** Actual lifecycle progress observes the existing authorization, without minting a replacement stop. */
  refresh(ticketId: string): void {
    for (const row of this.host.store.db.prepare("SELECT id FROM executor_stop WHERE ticket=? AND state NOT IN ('quiet','dormant') ORDER BY id").iterate(ticketId)) {
      this.host.effects.wake('stop', String(row.id))
      void this.run(String(row.id)).catch(() => {})
    }
  }
  private released(record: StopRecord): void {
    if (this.problem(record.ticketId)) return
    const assignment = this.host.store.tickets.get(record.ticketId)?.assignments.at(-1)
    if (assignment) this.host.effects.wake('launch', assignment.id)
    this.host.effects.wake('delivery', record.ticketId)
  }
  list(ticketId?: string, cursor = '', limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor.length > 200) throw new WorkspaceError(400, 'Invalid stop page')
    const rows = ticketId === undefined
      ? this.host.store.db.prepare('SELECT value FROM executor_stop WHERE id>? ORDER BY id LIMIT ?').all(cursor, limit + 1)
      : this.host.store.db.prepare('SELECT value FROM executor_stop WHERE ticket=? AND id>? ORDER BY id LIMIT ?').all(ticketId, cursor, limit + 1)
    const records = rows.map(row => StopRecordSchema.parse(JSON.parse(String(row.value))))
    return { items: records.slice(0, limit).map(stopSummary), nextCursor: records.length > limit ? records[limit - 1]!.id : null }
  }
  detail(id: string): StopDetail {
    const record = this.require(id)
    return { ...stopSummary(record), createdAt: record.createdAt, settledAt: record.settledAt,
      execution: record.execution, world: record.world, targets: { jobIds: record.jobIds, sessions: record.sessions },
      canRecheck: stopHeld(record), canAttest: record.state === 'unknown' && record.world === null && !!record.execution && !this.pending.has(id) && !this.draining(record) }
  }
  private update(record: StopRecord, change: Partial<StopRecord>): StopRecord {
    return this.host.store.atomic(() => {
      const current = this.require(record.id)
      if (current.revision !== record.revision) return current
      const next = { ...current, ...change }
      if (JSON.stringify(next) === JSON.stringify(current)) return current
      next.revision++; saveStop(this.host.store.db, next); return next
    })
  }
  /** Activate legacy coverage before reuse; a closed historical task is not itself an active stop incident. */
  activate(ticketId: string): void {
    for (const record of this.records(ticketId)) if (record.state === 'dormant') {
      this.update(record, { state: 'unknown', reason: 'Original legacy Session stop coverage must be reviewed before reuse' })
      this.host.effects.ensure('stop', record.id, { stopId: record.id })
    }
  }
  /** Original lifecycle identity is frozen before any Agent, job or descendant receives cancellation. */
  request(ticket: Ticket, assignment: Assignment, options: { scope?: StopRecord['scope']; keepInbox?: boolean; ownTurn?: boolean; jobIds?: string[] } = {}): string {
    const scope = options.scope ?? 'all', sessionId = 'worker-' + ticket.id
    const jobs = [...new Set(options.jobIds ?? [])].sort()
    if (jobs.length > 256) throw new Error('Stop target capacity exceeded')
    for (const matching of this.records(ticket.id)) if (matching.assignmentId === assignment.id && matching.scope === scope
      && (scope !== 'jobs' || JSON.stringify(matching.jobIds) === JSON.stringify(jobs)) && stopHeld(matching)) return matching.id
    const latest = this.host.store.tickets.get(ticket.id)?.assignments.at(-1)
    const agent = this.host.context.agents.get(sessionId as SessionId)
    // A delayed old halt must not cancel a newer assignment in the shared Session.
    const owned = latest?.id === assignment.id || latest?.state === 'pending'
      && ticket.assignments.at(-2)?.id === assignment.id
    let previous: StopRecord | undefined
    for (const record of this.records(ticket.id)) if (record.assignmentId === assignment.id && (record.scope === 'all' || record.scope === 'legacy') && record.state === 'quiet') { previous = record; break }
    if (previous && !previous.coverageConsumed) return previous.id
    const execution = assignment.execution ?? null
    let world: string | null = execution?.environment?.world ?? null
    const record: StopRecord = { version: 1, id: randomUUID(), ticketId: ticket.id, assignmentId: assignment.id, sessionId,
      revision: 1, scope, state: owned ? 'prepared' : 'unknown', reason: owned ? 'Original work stop requested' : 'Original assignment is no longer the live Session owner',
      execution, world, executionBindingHash: '', scopeHash: '', createdAt: NOW(), instance: this.instance, legacy: false,
      keepInbox: options.keepInbox ?? false, ownTurn: options.ownTurn ?? false, jobIds: jobs, sessions: [sessionId], dispatched: false,
      coverageConsumed: false, proof: null, settledAt: null, attestationId: null }
    record.world = world; record.executionBindingHash = stopExecutionDigest(execution, world); record.scopeHash = stopScopeDigest(record)
    const launch = this.host.store.db.prepare("SELECT launch_started,attempts FROM effect WHERE kind='launch' AND key=?").get(assignment.id)
    const undispatched = owned && scope === 'all' && !assignment.startedAt && !assignment.deliveredAt && !assignment.report && !agent
      && ticket.assignments.length === 1 && launch?.launch_started === 0 && launch.attempts === 0
    if (undispatched) Object.assign(record, { state: 'quiet', proof: 'undispatched', settledAt: NOW(), reason: 'Original assignment never crossed worker dispatch' })
    this.host.store.atomic(() => {
      saveStop(this.host.store.db, record)
      if (stopHeld(record)) this.host.effects.ensure('stop', record.id, { stopId: record.id })
      const admission = agent && admissions.get(agent)
      if (owned && admission?.assignmentId === assignment.id && admission.session === agent!.session
        && admission.jobs === this.host.context.get('jobs') && admission.children === this.host.context.get('subagents')) this.bindings.set(record.id, admission)
      this.host.store.afterCommit(() => { if (stopHeld(record)) void this.run(record.id).catch(() => {}) })
    })
    return record.id
  }
  private continuous(record: StopRecord): boolean {
    const binding = this.bindings.get(record.id)
    return record.instance === this.instance && !!binding && binding.jobs === this.host.context.get('jobs')
      && binding.children === this.host.context.get('subagents') && binding.agent === this.host.context.agents.get(record.sessionId as SessionId)
      && binding.session === binding.agent.session
  }
  private ownerCurrent(record: StopRecord): boolean {
    const ticket = this.host.store.tickets.get(record.ticketId), latest = ticket?.assignments.at(-1)
    return latest?.id === record.assignmentId || latest?.state === 'pending' && ticket?.assignments.at(-2)?.id === record.assignmentId
  }
  private draining(record: StopRecord): boolean {
    const agent = this.bindings.get(record.id)?.agent ?? this.host.context.agents.get(record.sessionId as SessionId)
    return !!agent && !!unsettledDrains.get(agent)?.size
  }
  private async drain(record: StopRecord): Promise<void> {
    const agent = this.bindings.get(record.id)?.agent, children = this.host.context.get('subagents') as Children | undefined
    if (!agent || !children) return
    const targets = record.sessions.filter(id => id !== record.sessionId && this.host.context.agents.get(id as SessionId))
    if (!targets.length) return
    if (!this.continuous(record) || !this.ownerCurrent(record)) throw new Error('Original owner changed')
    const work = children.drainChildren(agent, targets), pending = unsettledDrains.get(agent) ?? new Set<Promise<void>>()
    pending.add(work); unsettledDrains.set(agent, pending)
    void work.then(() => pending.delete(work), () => pending.delete(work))
    try { if (await until(work, undefined, 10000) === false) throw new Error('Original descendant control is unsettled') }
    finally {
      if (!record.ownTurn && this.continuous(record) && this.ownerCurrent(record)) {
        if (agent.status !== 'idle') cancelled.add(agent)
        agent.cancel({ kind: 'user' }, { keepInbox: record.keepInbox })
        await until(agent.whenIdle(), undefined, 10000)
      }
    }
  }
  private async inspect(record: StopRecord, operatorEvidence = false): Promise<{ sessions: string[]; jobs: string[]; busy: boolean }> {
    const ctx = this.host.context, service = ctx.get('jobs') as Jobs | undefined, children = ctx.get('subagents') as Children | undefined
    const sessions = new Set(record.sessions), queue = [...record.sessions], deadline = AbortSignal.timeout(4000)
    const visited = new Set<string>()
    while (queue.length) {
      const session = queue.shift()!
      if (visited.has(session)) continue
      if (visited.size >= 128) throw new Error('Incomplete descendant coverage')
      visited.add(session); sessions.add(session)
      if (children && record.scope !== 'jobs') {
        const found = await until(children.listChildren(session), deadline, 2000)
        if (found === false || found.length > 128) throw new Error('Incomplete descendant coverage')
        for (const child of found) { if (typeof child.id !== 'string') throw new Error('Invalid descendant'); queue.push(child.id) }
      }
    }
    if (sessions.size > 128) throw new Error('Incomplete descendant coverage')
    const targets = record.scope === 'descendants' ? [...sessions].filter(id => id !== record.sessionId) : record.scope === 'jobs' ? [record.sessionId] : [...sessions]
    const jobs = new Set<string>(); let busy = false
    for (const session of targets) {
      if (record.scope !== 'jobs' && ctx.agents.get(session as SessionId)?.status === 'running') busy = true
      const rows = service?.list(session) ?? []
      if (rows.length > 4096) throw new Error('Incomplete job coverage')
      for (const job of rows) if (job.owner === session && (record.scope !== 'jobs' || record.jobIds.includes(job.id))) {
        if (!terminal(job.status) || record.jobIds.includes(job.id)) jobs.add(job.id)
        if (active(job.status) || !terminal(job.status)) busy = true
      }
    }
    if (jobs.size > 256) throw new Error('Incomplete job coverage')
    if (!operatorEvidence && this.continuous(record) && record.jobIds.some(id => !jobs.has(id))) throw new Error('Original job evidence is missing')
    return { sessions: [...sessions].sort(), jobs: [...jobs].sort(), busy }
  }
  /** Reconcile known original identities only; this method never sends a cancellation. */
  private async observe(id: string, finishingControl = false): Promise<StopDetail> {
    let record = this.require(id)
    if (!stopHeld(record)) return this.detail(id)
    if (this.pending.has(id) && !finishingControl) return this.detail(id)
    try {
      const view = await this.inspect(record)
      if (!this.continuous(record)) {
        this.update(record, { state: 'unknown', reason: 'Original local registry continuity is unavailable; scoped operator evidence is required' }); return this.detail(id)
      }
      if (view.busy || this.draining(record)) {
        this.update(record, { state: 'unknown', reason: 'Original known work is still active' }); return this.detail(id)
      }
      const remote = this.host.remote(record)
      if (record.world !== null) {
        if (!remote || remote.world.status().binding !== record.world) throw new Error('Original world unavailable')
        if (await until(remote.world.refreshEffects(), undefined, 2000) === false || !remote.world.quiescent(record.ticketId)) throw new Error('Original receipts unsettled')
      } else if (remote) throw new Error('Execution world changed')
      const current = await this.inspect(record)
      if (current.busy || this.draining(record) || !this.continuous(record)) throw new Error('Stop evidence changed')
      this.host.authorizeObservation()
      this.update(record, { state: 'quiet', proof: record.world ? 'remote' : 'registry', settledAt: NOW(),
        reason: 'Original known Harness work is stopped', sessions: current.sessions,
        jobIds: record.scope === 'jobs' ? record.jobIds : [...new Set([...record.jobIds, ...current.jobs])].sort() })
      this.host.effects.kick()
      this.released(record)
    } catch { this.update(record, { state: 'unknown', reason: 'Original stop evidence is incomplete; no replacement work is admitted' }) }
    return this.detail(id)
  }
  /** Coalesce the original control worker; recovered dispatches are observation-only. */
  run(id: string): Promise<void> {
    const existing = this.pending.get(id); if (existing) return existing
    const operation = (async () => {
      let record = this.require(id)
      if (!stopHeld(record)) return
      if (!record.dispatched && record.state === 'prepared' && this.continuous(record) && this.ownerCurrent(record)) {
        try {
          const view = await this.inspect(record)
          if (!this.continuous(record) || !this.ownerCurrent(record)) throw new Error('Original owner changed')
          record = this.update(record, { state: 'observing', dispatched: true, sessions: view.sessions,
            jobIds: record.scope === 'jobs' ? record.jobIds : view.jobs, reason: 'Original cancellation was dispatched; termination is not yet confirmed' })
          if (record.state !== 'observing' || !this.continuous(record) || !this.ownerCurrent(record)) return
          const agent = this.bindings.get(id)?.agent
          if (record.scope === 'all' || record.scope === 'legacy') {
            if (!record.ownTurn) agent?.cancel({ kind: 'user' }, { keepInbox: record.keepInbox })
            await until(killJobs(this.host.context, record.sessionId, 'Original assignment stopping'), undefined, 11000)
            if (!this.continuous(record) || !this.ownerCurrent(record)) throw new Error('Original owner changed')
            await this.drain(record)
            if (!record.ownTurn && agent?.status !== 'idle') await until(agent!.whenIdle(), undefined, 10000)
          } else if (record.scope === 'descendants') {
            await this.drain(record)
          } else {
            const service = this.host.context.get('jobs') as Jobs | undefined
            const except = new Set((service?.list(record.sessionId) ?? []).filter(job => !record.jobIds.includes(job.id)).map(job => job.id))
            await killJobs(this.host.context, record.sessionId, 'Background duration limit reached', except)
          }
        } catch { this.update(record, { state: 'unknown', reason: 'Original cancellation outcome is unconfirmed' }) }
      }
      await this.observe(id, true)
    })().finally(() => { this.pending.delete(id) })
    this.pending.set(id, operation); return operation
  }
  async recheck(id: string, input?: { expectedRevision?: number; executionBindingHash: string; scopeHash: string }): Promise<StopDetail> {
    this.host.authorize(); const record = this.require(id)
    if (input && (record.executionBindingHash !== input.executionBindingHash || record.scopeHash !== input.scopeHash)) throw new WorkspaceError(409, 'Original stop scope changed')
    const prior = this.observations.get(id); if (prior) return prior
    const work = this.observe(id).finally(() => { this.observations.delete(id) })
    this.observations.set(id, work); return work
  }
  attestation(id: string, requestId: string): StopAttestationReceipt | null {
    this.require(id)
    const row = this.host.store.db.prepare('SELECT value FROM executor_stop_control WHERE id=? AND stop_id=?').get(requestId, id)
    return row ? StopAttestationReceiptSchema.parse(JSON.parse(String(row.value))) : null
  }
  attestations(id: string, cursor = '', limit = 50) {
    this.require(id)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor.length > 200) throw new WorkspaceError(400, 'Invalid receipt page')
    const rows = this.host.store.db.prepare('SELECT value FROM executor_stop_control WHERE stop_id=? AND id>? ORDER BY id LIMIT ?').all(id, cursor, limit + 1)
    const items = rows.map(row => StopAttestationReceiptSchema.parse(JSON.parse(String(row.value))))
    return { items: items.slice(0, limit), nextCursor: items.length > limit ? items[limit - 1]!.requestId : null }
  }
  async attest(id: string, input: unknown): Promise<{ receipt: StopAttestationReceipt; current: StopDetail }> {
    this.host.authorize(); const request = StopAttestationRequest.parse(input), record = this.require(id)
    const requestHash = stopDigest({ stopId: id, ticketId: record.ticketId, assignmentId: record.assignmentId, request })
    const found = this.host.store.db.prepare('SELECT value,fingerprint FROM executor_stop_control WHERE id=?').get(request.requestId)
    if (found) {
      if (found.fingerprint !== requestHash) throw new WorkspaceError(409, 'Attestation request identity differs')
      return { receipt: StopAttestationReceiptSchema.parse(JSON.parse(String(found.value))), current: this.detail(id) }
    }
    let receipt: StopAttestationReceipt = { version: 1, requestId: request.requestId, stopId: id, ticketId: record.ticketId, assignmentId: record.assignmentId,
      request, requestHash, phase: 'pending', acceptedAt: NOW(), settledAt: null, reason: 'Original operator evidence received; validation pending', observedRevision: record.revision }
    this.host.store.db.prepare('INSERT INTO executor_stop_control VALUES (?,?,?,?)').run(request.requestId, id, requestHash, JSON.stringify(receipt))
    try {
      if (record.revision !== request.expectedRevision || record.executionBindingHash !== request.executionBindingHash || record.scopeHash !== request.scopeHash
        || !this.detail(id).canAttest) throw new Error('Original stop evidence changed')
      const view = await this.inspect(record, true)
      this.host.authorize()
      if (view.busy || this.pending.has(id) || this.draining(record)) throw new Error('Original work remains active')
      this.host.store.atomic(() => {
        const current = this.require(id)
        if (current.revision !== record.revision || current.world !== null || current.state !== 'unknown') throw new Error('Stop evidence changed')
        const next = this.update(current, { state: 'quiet', proof: 'operator', settledAt: NOW(), attestationId: request.requestId,
          reason: 'Operator attested the original local stop; task outcome is not inferred' })
        receipt = { ...receipt, phase: 'accepted', settledAt: NOW(), reason: 'Original local stop attested', observedRevision: next.revision }
        this.host.store.db.prepare('UPDATE executor_stop_control SET value=? WHERE id=?').run(JSON.stringify(receipt), request.requestId)
      })
      this.host.effects.kick()
      this.released(record)
    } catch {
      receipt = { ...receipt, phase: 'refused', settledAt: NOW(), reason: 'Original stop could not be attested from current evidence', observedRevision: this.require(id).revision }
      this.host.store.db.prepare('UPDATE executor_stop_control SET value=? WHERE id=?').run(JSON.stringify(receipt), request.requestId)
    }
    return { receipt, current: this.detail(id) }
  }
  async idle(): Promise<void> { await Promise.allSettled([...this.pending.values(), ...this.observations.values()]) }
}
