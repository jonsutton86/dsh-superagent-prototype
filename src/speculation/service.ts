import { key, latestAssignment, type Assignment, type Ticket } from '../core/index.ts'
import type { OutboundMessage } from '../core/ports.ts'
import type { Store, Receipt } from '../app/store.ts'
import { Later } from '../app/effects.ts'
import type { Usage } from '../usage/service.ts'
import { UsageError, type UsageCall } from '../usage/model.ts'
import { WorkspaceError } from '../workspace/model.ts'
import { SaveSpeculation, SpeculationCommand, ApproveSpeculationMessage, defaultSpeculation, type SpeculationConfiguration,
  type SpeculationRun, type SpeculationState, type SpeculationView, type SpeculationDimension } from './model.ts'

interface Host {
  store: Store; usage: Usage; authorized(ticket: Ticket): boolean; evidence(ticket: Ticket): string; paused(): boolean
  provider(ticket: Ticket): Promise<string>; halt(ticketId: string, reason: string, assignmentId: string): void
  quiet(run: SpeculationRun): Promise<string | undefined>; busy(ticketId: string): boolean; capacity(): number
  requestPass(): void; clock?: () => number
}
const fingerprint = (message: OutboundMessage) => key(JSON.stringify({ id: message.id, ticketId: message.ticketId, channel: message.channel, text: message.text, kind: message.kind }))

/** Owns durable speculative allocations and promotion; all execution remains in the existing Engine, Effects and Harness. */
export class Speculation {
  private checking?: Promise<void>
  private closed = false
  private readonly halted = new Set<string>()
  constructor(private readonly host: Host) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS speculation_configuration (revision INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS speculation_run (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, assignment TEXT NOT NULL UNIQUE, value TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS speculation_run_ticket ON speculation_run(ticket);
      CREATE TABLE IF NOT EXISTS speculation_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS speculation_message (id TEXT PRIMARY KEY, run TEXT NOT NULL, fingerprint TEXT NOT NULL, note TEXT NOT NULL);`)
    if (!host.store.db.prepare('PRAGMA table_info(speculation_command)').all().some(row => row.name === 'request'))
      host.store.db.exec('ALTER TABLE speculation_command ADD COLUMN request TEXT')
    if (!host.store.db.prepare('SELECT 1 FROM speculation_configuration LIMIT 1').get())
      host.store.db.prepare('INSERT INTO speculation_configuration VALUES (0,?)').run(JSON.stringify({ revision: 0, at: this.now(), policy: defaultSpeculation }))
    // A restart is not evidence that local processes or provider calls stopped.
    host.store.db.prepare(`UPDATE speculation_run SET value=json_set(value,'$.recovered',json('true'))
      WHERE value ->> '$.admittedAt' IS NOT NULL AND value ->> '$.releasedAt' IS NULL`).run()
    for (const ticket of host.store.tickets.active().filter(ticket => ticket.mandate.strength === 'inferred')) {
      const assignment = latestAssignment(ticket)
      if (!assignment || this.current(ticket)) continue
      this.queued(ticket, assignment)
      const run = this.current(ticket)!
      run.state = 'cancelled'; run.recovered = true; run.admittedAt = this.now(); run.allowance = this.configuration().policy.run
      run.execution = ticket.execution
      run.problem = 'Preparation predates the reservation ledger; reconcile its processes before retrying'
      this.changed(run)
      // Older calls lack assignment ownership. Conservatively charge all unallocated calls of this ticket.
      host.store.db.prepare("UPDATE usage_call SET value=json_set(value,'$.owner.speculationId',?) WHERE value ->> '$.owner.ticketId'=? AND value ->> '$.owner.speculationId' IS NULL")
        .run(run.id, ticket.id)
    }
  }
  private at(): number { return this.host.clock?.() ?? Date.now() }
  private now(): string { return new Date(this.at()).toISOString() }
  private save(run: SpeculationRun): void {
    this.host.store.db.prepare('INSERT INTO speculation_run(id,ticket,assignment,value) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(run.id, run.ticketId, run.assignmentId, JSON.stringify(run))
  }
  private changed(run: SpeculationRun): void { run.revision++; this.save(run) }
  private all(): SpeculationRun[] {
    return this.host.store.db.prepare('SELECT value FROM speculation_run ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as SpeculationRun)
  }
  private require(id: string): SpeculationRun {
    const row = this.host.store.db.prepare('SELECT value FROM speculation_run WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Speculative preparation not found')
    return JSON.parse(String(row.value)) as SpeculationRun
  }
  private current(ticket: Ticket): SpeculationRun | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM speculation_run WHERE assignment=?').get(latestAssignment(ticket)?.id ?? '')
    return row ? JSON.parse(String(row.value)) as SpeculationRun : undefined
  }
  configuration(revision?: number): SpeculationConfiguration {
    const row = revision === undefined ? this.host.store.db.prepare('SELECT value FROM speculation_configuration ORDER BY revision DESC LIMIT 1').get()
      : this.host.store.db.prepare('SELECT value FROM speculation_configuration WHERE revision=?').get(revision)
    if (!row) throw new WorkspaceError(404, 'Speculation configuration not found')
    return JSON.parse(String(row.value)) as SpeculationConfiguration
  }
  private command<T>(id: string, input: unknown, apply: () => T): T {
    return this.host.store.atomic(() => {
      const digest = key(JSON.stringify(input)), previous = this.host.store.db.prepare('SELECT * FROM speculation_command WHERE id=?').get(id)
      if (previous) {
        if (previous.fingerprint !== digest) throw new WorkspaceError(409, 'This request ID was already used for another operation')
        return JSON.parse(String(previous.result)) as T
      }
      const value = apply()
      this.host.store.db.prepare('INSERT INTO speculation_command(id,fingerprint,result,request) VALUES (?,?,?,?)').run(id, digest, JSON.stringify(value), JSON.stringify(input))
      return value
    })
  }
  configure(input: unknown): SpeculationConfiguration {
    const request = SaveSpeculation.parse(input)
    const result = this.command(request.requestId, { operation: 'configure', ...request }, () => {
      const previous = this.configuration()
      if (previous.revision !== request.revision) throw new WorkspaceError(409, 'Speculation policy changed; reload before editing')
      const value = { revision: previous.revision + 1, at: this.now(), policy: request.policy }
      this.host.store.db.prepare('INSERT INTO speculation_configuration VALUES (?,?)').run(value.revision, JSON.stringify(value)); return value
    })
    this.host.requestPass(); return result
  }
  page(offset = 0, limit = 30): SpeculationState {
    const rows = this.host.store.db.prepare('SELECT value FROM speculation_run ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit + 1, offset)
    return { configuration: this.configuration(), items: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as SpeculationRun), nextOffset: rows.length > limit ? offset + limit : null }
  }
  get(id: string): SpeculationView {
    const run = this.require(id)
    const messages = this.host.store.db.prepare("SELECT value FROM outbox WHERE value ->> '$.ticketId'=? ORDER BY rowid DESC LIMIT 100").all(run.ticketId)
      .map(row => JSON.parse(String(row.value)) as Receipt)
      .map(message => ({ id: message.id, text: message.text, channel: message.channel, fingerprint: fingerprint(message), status: message.status,
        approved: !!this.host.store.db.prepare('SELECT id FROM speculation_message WHERE id=? AND run=? AND fingerprint=?').get(message.id, id, fingerprint(message)) }))
    return { ...run, usage: this.host.usage.speculation(id), messages }
  }
  /** Runs inside Engine's assignment transaction, before its queued launch can execute. */
  queued(ticket: Ticket, assignment: Assignment): void {
    if (ticket.mandate.strength !== 'inferred') {
      this.host.store.afterCommit(() => this.preempt()); return
    }
    if (this.host.store.db.prepare('SELECT id FROM speculation_run WHERE assignment=?').get(assignment.id)) return
    if (Number(this.host.store.db.prepare('SELECT count(*) AS n FROM speculation_run').get()!.n) >= 10000)
      throw new WorkspaceError(409, 'Speculative preparation history capacity reached')
    const configuration = this.configuration(), policy = configuration.policy, createdAt = this.now()
    this.save({ id: key('speculation', ticket.id, assignment.id), ticketId: ticket.id, assignmentId: assignment.id, revision: 1,
      title: ticket.title, owner: `${ticket.mandate.actor.source}:${ticket.mandate.actor.id}`, environment: ticket.execution?.environment?.environmentId ?? 'local',
      createdAt, expiresAt: new Date(Date.parse(createdAt) + policy.ttlMinutes * 60000).toISOString(), queuedPolicyRevision: configuration.revision, state: 'proposed', providers: [] })
  }
  held(): string[] { return [...new Set(this.all().filter(run => run.admittedAt && !run.releasedAt).map(run => run.ticketId))] }
  private explicitDemand(): Ticket[] {
    return this.host.store.tickets.open().filter(ticket => ticket.mandate.strength === 'explicit'
      && (latestAssignment(ticket)?.state === 'pending' || this.host.busy(ticket.id)))
  }
  private preempt(): void {
    if (this.closed) return
    const explicit = this.explicitDemand(), held = this.all().filter(run => run.admittedAt && !run.releasedAt)
    let excess = held.length + explicit.length - this.host.capacity()
    for (const run of held.filter(run => run.state === 'admitted')) {
      if (excess-- <= 0) break
      this.terminate(run, 'cancelled', 'Preempted for explicit work; saved preparation is retained. Retry after capacity is available.')
    }
  }
  private terminate(run: SpeculationRun, state: 'expired' | 'cancelled', reason: string): void {
    this.host.store.atomic(() => {
      run.state = state; run.problem = reason; this.changed(run)
      if (!run.releasedAt) this.host.store.afterCommit(() => this.halt(run, reason))
    })
  }
  private halt(run: SpeculationRun, reason: string): void {
    this.halted.add(run.id); this.host.halt(run.ticketId, reason, run.assignmentId)
  }
  private currentTicket(run: SpeculationRun): Ticket | undefined {
    const ticket = this.host.store.tickets.get(run.ticketId)
    return ticket && latestAssignment(ticket)?.id === run.assignmentId ? ticket : undefined
  }
  /** Tool and inference guards recheck expiry/authority synchronously, independently of the periodic pass. */
  problem(ticket: Ticket): string | undefined {
    if (ticket.mandate.strength !== 'inferred') return
    if (this.closed) return 'Speculative execution stopped'
    if (ticket.ended || ['ready', 'failed', 'blocked', 'dropped'].includes(latestAssignment(ticket)?.report?.state ?? ''))
      return 'Speculative preparation has reported its result and cannot start further work'
    const run = this.current(ticket)
    if (!run || run.state !== 'admitted' || run.releasedAt || run.recovered) return 'Speculative preparation is not admitted for this assignment'
    if (this.host.paused() || !this.configuration().policy.enabled || !this.host.authorized(ticket)) return 'Speculative preparation authority is unavailable'
    if (run.expiresAt <= this.now() || (run.deadline && run.deadline <= this.now())) return 'Speculative preparation expired'
    return
  }
  private today(): string { return `${this.now().slice(0, 10)}T00:00:00.000Z` }
  private charge(run: SpeculationRun, provider?: string) {
    const today = this.today(), total = this.host.usage.speculation(run.id, undefined, provider), daily = this.host.usage.speculation(run.id, today, provider)
    const held = !!run.admittedAt && !run.releasedAt, allowance = held ? run.allowance : undefined
    const end = Date.parse(run.releasedAt ?? this.now()), start = Date.parse(run.admittedAt ?? this.now())
    const elapsed = Math.max(0, Math.ceil((end - start) / 1000)), seconds = Math.max(0, Math.ceil((end - Math.max(start, Date.parse(today))) / 1000))
    return { concurrent: held ? 1 : 0, runs: run.admittedAt && run.admittedAt >= today ? 1 : 0,
      calls: daily.calls + Math.max(0, (allowance?.calls ?? 0) - total.calls),
      tokens: daily.tokens + daily.reservedTokens + Math.max(0, (allowance?.tokens ?? 0) - total.tokens - total.reservedTokens),
      cost: daily.cost + daily.reservedCost + Math.max(0, (allowance?.cost ?? 0) - total.cost - total.reservedCost),
      seconds: seconds + Math.max(0, (allowance?.seconds ?? 0) - elapsed), unknownCost: daily.unknownCost || held && total.unknownCost ? 1 : 0 }
  }
  private capacity(run: SpeculationRun, provider: string, providerOnly = false): void {
    const policy = this.configuration().policy, limits = run.allowance ?? policy.run
    if (this.all().some(item => item.admittedAt && !item.releasedAt && !item.providers.length))
      throw new Later('A legacy preparation has an unknown provider reservation; reconcile it before admission')
    for (const dimension of (providerOnly ? ['provider'] : ['workspace', 'owner', 'environment', 'provider']) as SpeculationDimension[]) {
      const quota = policy.limits[dimension], matching = this.all().filter(item => item.id !== run.id && item.admittedAt
        && (dimension === 'workspace' || dimension === 'provider' ? dimension === 'workspace' || item.providers.includes(provider) : item[dimension] === run[dimension]))
      const totals = matching.reduce((sum, item) => {
        const charge = this.charge(item, dimension === 'provider' ? provider : undefined)
        for (const metric of Object.keys(sum) as (keyof typeof sum)[]) sum[metric] += charge[metric]
        return sum
      }, { concurrent: 0, runs: 0, calls: 0, tokens: 0, cost: 0, seconds: 0, unknownCost: 0 })
      if (totals.concurrent + 1 > quota.concurrent || totals.runs + 1 > quota.runs
        || totals.calls + limits.calls > quota.calls || totals.tokens + limits.tokens > quota.tokens || totals.seconds + limits.seconds > quota.seconds
        || quota.cost !== undefined && (limits.cost === undefined || totals.unknownCost || totals.cost + limits.cost > quota.cost))
        throw new Later(`Speculation ${dimension} allowance is unavailable; active and uncertain reservations remain charged`)
    }
  }
  /** Reserve owner/environment/provider/concurrency/time/usage before workspace preparation or model execution. */
  async admit(ticket: Ticket, assignment: Assignment): Promise<void> {
    if (ticket.mandate.strength !== 'inferred') {
      this.preempt()
      const explicitBusy = this.explicitDemand().filter(item => item.id !== ticket.id && this.host.busy(item.id)).length
      if (this.held().length + explicitBusy >= this.host.capacity()) throw new Later('Explicit work waits for speculative execution to become quiescent')
      return
    }
    this.queued(ticket, assignment)
    let run = this.current(ticket)!
    if (run.state === 'admitted') {
      const problem = this.problem(ticket); if (problem) throw new Later(problem)
      return
    }
    if (run.state !== 'proposed') throw new Later(run.problem ?? 'This speculative preparation cannot execute; retry the task to propose another assignment')
    const provider = await this.host.provider(ticket)
    if (this.closed) throw new Later('Speculative admission stopped')
    this.host.store.atomic(() => {
      if (this.closed) throw new Later('Speculative admission stopped')
      run = this.require(run.id)
      const current = this.currentTicket(run), policy = this.configuration()
      if (!current || current.ended || !policy.policy.enabled || this.host.paused() || !this.host.authorized(current)) throw new Later('Speculative preparation authority is unavailable')
      if (run.expiresAt <= this.now()) throw new Later('Speculative preparation expired')
      if (run.state === 'admitted') return
      if (run.state !== 'proposed') throw new Later('Speculative preparation changed while resolving its provider')
      if (this.explicitDemand().length + this.held().length >= this.host.capacity()) throw new Later('Speculation waits for spare execution capacity')
      this.capacity(run, provider)
      run.state = 'admitted'; run.providers = [provider]; run.policyRevision = policy.revision; run.allowance = policy.policy.run
      run.execution = current.execution
      run.admittedAt = this.now(); run.deadline = new Date(Date.parse(run.admittedAt) + run.allowance.seconds * 1000).toISOString(); delete run.problem
      this.changed(run)
    })
  }
  /** Called by Usage.begin inside its transaction; provider changes reserve capacity before any new stream is dispatched. */
  admitCall(call: UsageCall): string | undefined {
    const ticket = call.owner.ticketId && this.host.store.tickets.get(call.owner.ticketId)
    if (!ticket || ticket.mandate.strength !== 'inferred') return
    const problem = this.problem(ticket), run = this.current(ticket)
    if (problem || !run || run.assignmentId !== call.owner.assignmentId) throw new UsageError(409, problem ?? 'Speculative assignment changed before model dispatch')
    const total = this.host.usage.speculation(run.id), limit = run.allowance!
    if (total.calls + 1 > limit.calls || call.reservedTokens === undefined || total.unknownTokens || total.tokens + total.reservedTokens + call.reservedTokens > limit.tokens
      || limit.cost !== undefined && (call.reservedCost === undefined || total.unknownCost || total.cost + total.reservedCost + call.reservedCost > limit.cost))
      throw new UsageError(409, 'Speculative model allowance exhausted or cannot reserve the declared context ceiling')
    if (!run.providers.includes(call.provider)) {
      try { this.capacity(run, call.provider, true) } catch (error) { throw new UsageError(409, error instanceof Error ? error.message : 'Provider allowance is unavailable') }
      run.providers.push(call.provider); this.changed(run)
    }
    return run.id
  }
  private unresolved(id: string): boolean {
    return !!this.host.store.db.prepare("SELECT 1 FROM usage_call WHERE value ->> '$.owner.speculationId'=? AND phase IN ('pending','unknown') LIMIT 1").get(id)
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return this.checking ??= this.inspect().finally(() => { this.checking = undefined })
  }
  private async inspect(): Promise<void> {
    this.preempt()
    const due = this.host.store.db.prepare(`SELECT id FROM speculation_run WHERE (value ->> '$.admittedAt' IS NOT NULL AND value ->> '$.releasedAt' IS NULL)
      OR value ->> '$.state' IN ('proposed','admitted','ready','promoted') ORDER BY checked,rowid LIMIT 16`).all()
    for (const original of due) {
      if (this.closed) return
      let run = this.require(String(original.id)), ticket = this.currentTicket(run)
      this.host.store.db.prepare('UPDATE speculation_run SET checked=? WHERE id=?').run(this.at(), run.id)
      if (['proposed', 'admitted', 'ready', 'promoted'].includes(run.state)) {
        if (run.expiresAt <= this.now() || run.state === 'admitted' && run.deadline! <= this.now())
          this.terminate(run, 'expired', 'Speculative preparation reached its time or promotion deadline')
        else if (!ticket || !this.configuration().policy.enabled || !this.host.authorized(ticket))
          this.terminate(run, 'cancelled', 'Speculative authorization changed or the assignment was replaced')
        else if (run.state === 'admitted') {
          const report = latestAssignment(ticket)?.report
          if (report?.state === 'ready') {
            run.state = 'ready'; run.report = report.summary; this.changed(run)
            this.halt(run, 'Preparation is ready for operator promotion')
          } else if (ticket.ended || report?.state === 'failed' || report?.state === 'blocked')
            this.terminate(run, 'cancelled', report?.summary ?? 'Speculative preparation ended without a ready result')
        }
      }
      run = this.require(run.id)
      if (!run.admittedAt || run.releasedAt || run.state === 'admitted' && !run.recovered) continue
      if (run.recovered && !this.halted.has(run.id)) this.halt(run, 'Recovered speculative preparation awaits quiescence and usage reconciliation')
      const proof = await this.host.quiet(run)
      if (this.closed || !proof || this.unresolved(run.id)) continue
      this.host.store.atomic(() => {
        const current = this.require(run.id)
        if (current.revision !== run.revision) return
        current.releasedAt = this.now(); current.releaseEvidence = proof; delete current.recovered
        ticket = this.currentTicket(current)
        if (current.state === 'ready' && ticket) current.evidence = this.host.evidence(ticket)
        // A recovered allocation is closed, never restarted with a freshly invented allowance.
        if (current.state === 'admitted') { current.state = 'cancelled'; current.problem = 'Recovered preparation reconciled; retry with a new allocation to continue' }
        this.changed(current)
      })
    }
  }
  review(id: string, input: unknown): SpeculationView {
    const request = SpeculationCommand.parse(input)
    this.command(request.requestId, { operation: 'review', id, ...request }, () => {
      const run = this.require(id)
      if (run.revision !== request.revision) throw new WorkspaceError(409, 'Speculative preparation changed; reload before reviewing')
      if (request.command === 'promote') {
        const ticket = this.currentTicket(run)
        if (run.state !== 'ready' || !run.releasedAt || !run.evidence || request.evidence !== run.evidence || !ticket
          || !this.configuration().policy.enabled || this.host.evidence(ticket) !== run.evidence || !this.host.authorized(ticket) || run.expiresAt <= this.now())
          throw new WorkspaceError(409, 'Promotion requires current, quiescent, unexpired evidence and current source authority')
        run.state = 'promoted'; run.review = { at: this.now(), note: request.note }; this.changed(run)
      } else if (request.command === 'cancel') {
        this.terminate(run, 'cancelled', request.note)
      } else {
        if (!run.recovered || run.releasedAt) throw new WorkspaceError(409, 'Only unresolved recovered preparation accepts a local-process attestation')
        run.attestation = { at: this.now(), note: request.note }; this.changed(run)
      }
      return id
    })
    this.host.requestPass(); return this.get(id)
  }
  publicationProblem(ticketId: string, assignmentId?: string): string | undefined {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || ticket.mandate.strength !== 'inferred') return
    const run = this.current(ticket)
    if (!run || assignmentId && assignmentId !== run.assignmentId || run.state !== 'promoted' || !run.releasedAt || !run.evidence
      || this.closed || !this.configuration().policy.enabled || run.expiresAt <= this.now() || !this.host.authorized(ticket) || this.host.evidence(ticket) !== run.evidence)
      return 'Speculative results require current, unexpired operator promotion before external publication'
  }
  messageProblem(message: OutboundMessage): string | undefined {
    const ticket = message.ticketId && this.host.store.tickets.get(message.ticketId)
    if (!ticket || ticket.mandate.strength !== 'inferred') return
    const problem = this.publicationProblem(ticket.id)
    if (problem) return problem
    const run = this.current(ticket)!
    if (!this.host.store.db.prepare('SELECT id FROM speculation_message WHERE id=? AND run=? AND fingerprint=?').get(message.id, run.id, fingerprint(message)))
      return 'This speculative message needs a separate operator publication approval'
  }
  approveMessage(id: string, input: unknown): SpeculationView {
    const request = ApproveSpeculationMessage.parse(input)
    this.command(request.requestId, { operation: 'message', id, ...request }, () => {
      const run = this.require(id), message = this.host.store.receipts.get(request.receiptId)
      if (run.revision !== request.revision || !message || message.status !== 'pending' || message.ticketId !== run.ticketId || fingerprint(message) !== request.fingerprint)
        throw new WorkspaceError(409, 'Preparation or message changed; reload before approving')
      const problem = this.publicationProblem(run.ticketId, run.assignmentId)
      if (problem) throw new WorkspaceError(409, problem)
      this.host.store.db.prepare('INSERT INTO speculation_message VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET run=excluded.run,fingerprint=excluded.fingerprint,note=excluded.note')
        .run(message.id, run.id, request.fingerprint, request.note)
      return id
    })
    this.host.requestPass(); return this.get(id)
  }
  async close(): Promise<void> { this.closed = true; await this.checking }
}
