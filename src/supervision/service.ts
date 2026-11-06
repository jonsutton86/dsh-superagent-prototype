/** The main process exposes observations and a single bounded, transactional recovery command. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, type Engine, type Ticket } from '../core/index.ts'
import { ticketStage } from '../core/stage.ts'
import type { Store } from '../app/store.ts'
import type { Health } from '../sources/host.ts'
import { KV } from '../kv.ts'
import type { Intervention, InterventionResult, Observation, Snapshot } from './protocol.ts'

const { receipt: receipts, nudged } = KV.supervision

/** Supervision authority is deliberately narrower than the operator API: no stop, retry, policy edits or shell. */
export class Supervision {
  readonly instance = randomUUID()
  private readonly token: string
  constructor(private readonly host: {
    store: Store; engine: Pick<Engine, 'note'>; stateDir: string;
    configured(): boolean; health(): Record<string, Health>;
  }) {
    const file = join(host.stateDir, 'watchdog.token')
    try { writeFileSync(file, randomUUID() + randomUUID(), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    chmodSync(file, 0o600)
    this.token = readFileSync(file, 'utf8').trim()
    if (this.token.length < 32) throw new Error('watchdog.token must contain at least 32 characters')
  }
  authorized(header: string | undefined): boolean {
    const supplied = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '')
    const expected = Buffer.from(this.token)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
  private observe(ticket: Ticket): Observation {
    const assignment = latestAssignment(ticket), report = latestReport(ticket), stage = ticketStage(ticket)
    return {
      id: ticket.id, assignmentId: assignment?.id ?? null,
      revision: key(JSON.stringify(ticket)), title: ticket.title.slice(0, 500), scope: ticket.mandate.scope.slice(0, 2000),
      stage: `${stage.stage}${stage.stage === 'person' ? '/' + stage.action : ''}`, updatedAt: ticket.updatedAt,
      report: report ? { ...report, summary: report.summary.slice(0, 2000) } : null,
      canNudge: liveTicket(ticket) && assignment?.state === 'running' && stage.stage === 'working'
        && !this.host.store.get(nudged(assignment.id)),
    }
  }
  snapshot(offset = 0): Snapshot {
    const all = this.host.store.tickets.open(), page = all.slice(offset, offset + 100)
    return { instance: this.instance, at: new Date().toISOString(), configured: this.host.configured(),
      paused: this.host.store.settings().paused, version: key(JSON.stringify(all)), tickets: page.map(ticket => this.observe(ticket)),
      nextOffset: offset + page.length < all.length ? offset + page.length : null,
      health: Object.fromEntries(Object.entries(this.host.health()).map(([id, value]) => [id,
        { state: value.state, ...(value.detail ? { detail: value.detail.slice(0, 2000) } : {}) }])) }
  }
  intervene(request: Intervention): InterventionResult {
    const { store } = this.host
    return store.atomic(() => {
      const fingerprint = key(request.instance, request.ticketId, request.revision, request.action), previous = store.get(receipts(request.requestId))
      if (previous) return previous.fingerprint === fingerprint ? previous.result : { accepted: false, reason: 'request_id_conflict' }
      const refuse = (reason: string): InterventionResult => ({ accepted: false, reason })
      if (request.instance !== this.instance) return refuse('instance_changed')
      if (!this.host.configured() || store.settings().paused) return refuse('processing_paused')
      const ticket = store.tickets.get(request.ticketId)
      if (!ticket || !liveTicket(ticket)) return refuse('ticket_ended')
      const observation = this.observe(ticket)
      if (observation.revision !== request.revision) return refuse('observation_changed')
      if (!observation.canNudge || !observation.assignmentId) return refuse('intervention_not_allowed')
      // A context-only note keeps the mandate intact. Do not impersonate a human retry/stop or replay shell work.
      this.host.engine.note(ticket.id, 'The independent watchdog requests a factual progress report. State verified progress, '
        + 'remaining work and any blocker. Your existing mandate and tool permissions are unchanged; do not repeat completed effects.')
      const result = { accepted: true, reason: 'status_requested' }
      store.set(nudged(observation.assignmentId), request.requestId)
      store.set(receipts(request.requestId), { fingerprint, result })
      return result
    })
  }
}
