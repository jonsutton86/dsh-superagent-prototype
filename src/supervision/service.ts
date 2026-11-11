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
import { ExecutionEvidenceSchema, unavailableExecutionEvidence, type ExecutionEvidence } from './execution-evidence.ts'
import { heldTicketIds, stopHold } from '../executor/stop-view.ts'

const { receipt: receipts, nudged } = KV.supervision
const FRAME_TTL_MS = 15_000, MAX_FRAMES = 2, MAX_TICKETS = 10_000, MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_PAGE_BYTES = 1_048_576
type Frame = { snapshot: Snapshot; expires: number }

/** Missing/expired bounded transport frames never become partial successful observations. */
export class SupervisionSnapshotError extends Error {
  constructor(readonly status: 400 | 410 | 503, readonly code: string) { super(code) }
}

/** Supervision authority is deliberately narrower than the operator API: no stop, retry, policy edits or shell. */
export class Supervision {
  readonly instance = randomUUID()
  private readonly token: string
  private readonly frames = new Map<string, Frame>()
  constructor(private readonly host: {
    store: Store; engine: Pick<Engine, 'note'>; stateDir: string;
    configured(): boolean; health(): Record<string, Health>;
    executionEvidence?(ticket: Ticket): ExecutionEvidence;
  }, private readonly now = Date.now) {
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
    const hold = stopHold(this.host.store, ticket)
    // Stop progress and operator receipts change evidence, never replenish the task's assessment allowance.
    const episodeRevision = key(JSON.stringify(ticket))
    let execution: ExecutionEvidence | undefined
    if (this.host.executionEvidence) {
      try {
        execution = ExecutionEvidenceSchema.parse(this.host.executionEvidence(ticket))
        if (execution.assignmentId !== (assignment?.id ?? null) || execution.session.id !== `worker-${ticket.id}`)
          execution = unavailableExecutionEvidence(`worker-${ticket.id}`, assignment?.id ?? null)
      }
      catch { execution = unavailableExecutionEvidence(`worker-${ticket.id}`, assignment?.id ?? null) }
    }
    return {
      id: ticket.id, assignmentId: assignment?.id ?? null,
      episodeRevision, revision: execution || hold ? key(JSON.stringify({ episodeRevision, execution, stopHold: hold })) : episodeRevision,
      ...(hold ? { stopHold: hold } : {}),
      ...(execution ? { execution } : {}), title: ticket.title.slice(0, 500), scope: ticket.mandate.scope.slice(0, 2000),
      stage: `${stage.stage}${stage.stage === 'person' ? '/' + stage.action : ''}`, updatedAt: ticket.updatedAt,
      report: report ? { ...report, summary: report.summary.slice(0, 2000) } : null,
      question: ticket.attention?.question.slice(0, 2000) ?? null,
      canNudge: !hold && liveTicket(ticket) && assignment?.state === 'running' && stage.stage === 'working'
        && !this.host.store.get(nudged(assignment.id)),
    }
  }
  snapshot(offset = 0, version?: string): Snapshot {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_TICKETS || offset % 100 !== 0)
      throw new SupervisionSnapshotError(400, 'invalid_supervision_offset')
    if (version !== undefined && !/^[0-9a-f-]{36}$/.test(version))
      throw new SupervisionSnapshotError(400, 'invalid_supervision_frame')
    const now = this.now()
    for (const [id, frame] of this.frames) if (frame.expires <= now) this.frames.delete(id)
    let frame: Frame | undefined
    if (version) {
      frame = this.frames.get(version)
      if (!frame) throw new SupervisionSnapshotError(410, 'supervision_frame_expired')
    } else {
      if (offset !== 0) throw new SupervisionSnapshotError(400, 'supervision_frame_required')
      const open = this.host.store.tickets.open()
      if (open.length > MAX_TICKETS) throw new SupervisionSnapshotError(503, 'supervision_snapshot_capacity')
      const selected = new Map(open.map(ticket => [ticket.id, ticket]))
      const held = heldTicketIds(this.host.store, MAX_TICKETS + 1)
      if (selected.size > MAX_TICKETS || held.length > MAX_TICKETS) throw new SupervisionSnapshotError(503, 'supervision_snapshot_capacity')
      for (const id of held) {
        const ticket = this.host.store.tickets.get(id)
        if (!ticket) throw new SupervisionSnapshotError(503, 'supervision_stop_reference_missing')
        selected.set(id, ticket)
        if (selected.size > MAX_TICKETS) throw new SupervisionSnapshotError(503, 'supervision_snapshot_capacity')
      }
      const all = [...selected.values()]
      if (all.length > MAX_TICKETS) throw new SupervisionSnapshotError(503, 'supervision_snapshot_capacity')
      const tickets = all.map(ticket => this.observe(ticket))
      const snapshot: Snapshot = { instance: this.instance, at: new Date(now).toISOString(), configured: this.host.configured(),
        paused: this.host.store.settings().paused, version: randomUUID(), tickets, total: tickets.length, nextOffset: null,
        health: Object.fromEntries(Object.entries(this.host.health()).map(([id, value]) => [id,
          { state: value.state, ...(value.detail ? { detail: value.detail.slice(0, 2000) } : {}) }])) }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_FRAME_BYTES)
        throw new SupervisionSnapshotError(503, 'supervision_snapshot_capacity')
      // Validate every page before publishing a frame; an oversized later page cannot masquerade as a complete view.
      for (let start = 0; start < Math.max(1, tickets.length); start += 100) {
        if (Buffer.byteLength(JSON.stringify({ ...snapshot, tickets: tickets.slice(start, start + 100), nextOffset: start + 100 })) > MAX_PAGE_BYTES)
          throw new SupervisionSnapshotError(503, 'supervision_snapshot_capacity')
      }
      frame = { snapshot, expires: now + FRAME_TTL_MS }
      while (this.frames.size >= MAX_FRAMES) this.frames.delete(this.frames.keys().next().value!)
      this.frames.set(snapshot.version, frame)
    }
    const snapshot = frame.snapshot, tickets = snapshot.tickets.slice(offset, offset + 100)
    if (offset > 0 && tickets.length === 0) throw new SupervisionSnapshotError(400, 'invalid_supervision_offset')
    // A transport frame is ephemeral evidence, never mutation authority. Detach it from callers before returning.
    return structuredClone({ ...snapshot, tickets, nextOffset: offset + tickets.length < snapshot.tickets.length ? offset + tickets.length : null })
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
