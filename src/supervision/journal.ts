/** Independent SQLite incident journal, audit log and delivery receipts for the watchdog. */
import { chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { key } from '../core/index.ts'
import { AlertJournal } from './alert-journal.ts'
import type { ObservationSet } from './client.ts'
import type { Assessment, InterventionResult, Observation } from './protocol.ts'
import { ACK_WINDOW_MS, AcknowledgeSchema, WatchdogOperatorError, type Acknowledge, type Acknowledgement,
  type AcknowledgementReceipt, type IncidentFilter, type Page, type RetentionPolicy } from './protocol.ts'

export interface Incident {
  id: string; revision: string; instance: string; observation: Observation; openedAt: number; cycleAt: number;
  updatedAt: number; closedAt?: number; attempts: number; delivery?: { id: string; at: number; sent: boolean };
  assessment?: Assessment; intervention?: InterventionResult;
  viewRevision?: string; acknowledgement?: Acknowledgement;
}
export interface IncidentView extends Incident { viewRevision: string; acknowledged: boolean }
export interface AuditEntry { seq: number; at: number; kind: string; incident: string | null; data: unknown }
const cursorSchema = z.object({ kind: z.enum(['incidents', 'audit']), filter: z.string().max(200),
  before: z.number().int().positive(), through: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  floor: z.number().int().nonnegative() }).strict()
type Cursor = z.infer<typeof cursorSchema>
const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString('base64url')
export interface MonitorStatus { at: number; reachable: boolean; lastSuccess?: number; error?: string; modelError?: string;
  configured?: boolean; paused?: boolean; health?: ObservationSet['health'] }

/** Owns watchdog state only; transactions keep observations, diagnoses and delivery reservations consistent after restart. */
export class WatchdogJournal {
  private readonly db: DatabaseSync
  readonly alerts: AlertJournal
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number
      if (version > 3) throw new Error(`Unsupported watchdog schema ${version}`)
      this.db.exec(`CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, closed INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS monitor (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, incident TEXT, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operator_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
          seq INTEGER NOT NULL, floor INTEGER NOT NULL, prunedAt INTEGER NOT NULL);
        INSERT OR IGNORE INTO operator_state SELECT 1, 0, coalesce(max(seq), 0), 0, 0 FROM audit;
        CREATE TABLE IF NOT EXISTS acknowledgements (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS acknowledgements_expiry ON acknowledgements(expires);
        CREATE INDEX IF NOT EXISTS audit_incident ON audit(incident, seq);
        CREATE INDEX IF NOT EXISTS incident_closed ON incidents(closed);
        PRAGMA user_version=3;`)
      this.alerts = new AlertJournal(this.db, (at, kind, incident, data) => this.event(at, kind, incident, data))
    } catch (error) { this.db.close(); throw error }
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = work(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private save(incident: Incident, evidenceChanged = true): void {
    if (evidenceChanged) incident.viewRevision = randomUUID()
    this.db.prepare('INSERT INTO incidents VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET closed=excluded.closed, data=excluded.data')
      .run(incident.id, incident.closedAt === undefined ? 0 : 1, JSON.stringify(incident))
    this.db.prepare('UPDATE operator_state SET revision=revision+1 WHERE id=1').run()
  }
  private event(at: number, kind: string, incident: string | null, data: unknown): void {
    const seq = this.db.prepare('UPDATE operator_state SET seq=seq+1 WHERE id=1 RETURNING seq').get()!.seq as number
    this.db.prepare('INSERT INTO audit (seq, at, kind, incident, data) VALUES (?, ?, ?, ?, ?)').run(seq, at, kind, incident, JSON.stringify(data))
  }
  get(id: string): Incident | undefined {
    const row = this.db.prepare('SELECT data FROM incidents WHERE id=?').get(id)
    return row ? JSON.parse(row.data as string) as Incident : undefined
  }
  open(): Incident[] {
    return this.db.prepare('SELECT data FROM incidents WHERE closed=0 ORDER BY rowid').all().map(row => JSON.parse(row.data as string) as Incident)
  }
  status(): MonitorStatus | undefined {
    const row = this.db.prepare('SELECT data FROM monitor WHERE id=1').get()
    return row ? JSON.parse(row.data as string) as MonitorStatus : undefined
  }
  private monitor(value: MonitorStatus): void {
    const previous = this.status()
    value.modelError = previous?.modelError
    if (previous?.reachable !== value.reachable || previous?.error !== value.error)
      this.event(value.at, 'monitor', null, value)
    this.db.prepare('INSERT OR REPLACE INTO monitor VALUES (1, ?)').run(JSON.stringify(value))
  }
  unavailable(now: number, error: string): void {
    this.atomic(() => this.monitor({ at: now, reachable: false, lastSuccess: this.status()?.lastSuccess, error: error.slice(0, 2000) }))
  }
  modelError(error?: string): void {
    const status = this.status()
    if (!status) return
    status.modelError = error?.slice(0, 2000)
    this.db.prepare('INSERT OR REPLACE INTO monitor VALUES (1, ?)').run(JSON.stringify(status))
  }
  reconcile(snapshot: ObservationSet, now: number, staleMs: number, reviewEveryMs: number): void {
    this.atomic(() => {
      this.monitor({ at: now, reachable: true, lastSuccess: now, configured: snapshot.configured, paused: snapshot.paused, health: snapshot.health })
      const seen = new Set<string>()
      for (const observation of snapshot.tickets) {
        const working = observation.stage === 'working' && now - Date.parse(observation.updatedAt) >= staleMs
        const blocked = observation.stage === 'person/blocked' || observation.stage === 'person/failed' || observation.stage === 'person/answer'
        if (snapshot.paused || !snapshot.configured || (!working && !blocked)) continue
        const id = key(`watchdog:${observation.id}:${observation.assignmentId ?? 'queued'}`), previous = this.get(id)
        seen.add(id)
        if (previous && previous.closedAt === undefined && previous.observation.revision === observation.revision
          && previous.instance === snapshot.instance && now - previous.cycleAt < reviewEveryMs) continue
        const incident: Incident = { id, revision: randomUUID(), instance: snapshot.instance,
          observation, openedAt: previous?.closedAt === undefined ? previous?.openedAt ?? now : now,
          cycleAt: now, updatedAt: now, attempts: 0, ...(previous?.acknowledgement ? { acknowledgement: previous.acknowledgement } : {}) }
        this.save(incident); this.event(now, 'observed', id, incident)
      }
      for (const incident of this.open()) if (!seen.has(incident.id)) {
        incident.closedAt = now; incident.updatedAt = now; this.save(incident)
        this.event(now, 'resolved', incident.id, { reason: snapshot.paused ? 'processing_paused' : 'observation_no_longer_stalled' })
      }
    })
  }
  /** Reserve before sending, and reuse the same delivery id after a crash or a lost acknowledgement. */
  reserve(id: string, now: number, retryMs: number): Incident | undefined {
    return this.atomic(() => {
      const incident = this.get(id)
      if (!incident || incident.closedAt !== undefined || incident.assessment) return
      if (incident.delivery && !incident.delivery.sent) return incident
      if (incident.attempts >= 3 || (incident.delivery && now - incident.delivery.at < retryMs)) return
      incident.attempts++
      incident.delivery = { id: key(`${id}:${incident.revision}:${incident.attempts}`), at: now, sent: false }
      this.save(incident, incident.attempts === 3); this.event(now, 'delivery_reserved', id, incident.delivery)
      return incident
    })
  }
  delivered(id: string, deliveryId: string): void {
    this.atomic(() => {
      const incident = this.get(id)
      if (incident?.delivery?.id !== deliveryId || incident.delivery.sent) return
      incident.delivery.sent = true; this.save(incident, false)
    })
  }
  assess(assessment: Assessment, now: number): { accepted: boolean; reason: string } {
    return this.atomic(() => {
      const incident = this.get(assessment.incidentId)
      if (!incident || incident.closedAt !== undefined || incident.revision !== assessment.incidentRevision)
        return { accepted: false, reason: 'incident_changed' }
      if (incident.assessment) return { accepted: false, reason: 'already_assessed' }
      incident.assessment = assessment; incident.updatedAt = now; this.save(incident)
      this.event(now, 'assessed', incident.id, assessment)
      return { accepted: true, reason: 'assessment_recorded' }
    })
  }
  intervention(id: string, revision: string, result: InterventionResult, now: number): void {
    this.atomic(() => {
      const incident = this.get(id)
      this.event(now, 'intervention', id, { revision, result })
      if (incident?.revision !== revision) return
      incident.intervention = result; incident.updatedAt = now; this.save(incident)
    })
  }
  recent(limit = 100) {
    return this.db.prepare('SELECT seq, at, kind, incident, data FROM audit ORDER BY seq DESC LIMIT ?').all(Math.min(200, Math.max(1, limit)))
      .map(row => ({ seq: row.seq as number, at: row.at as number, kind: row.kind as string, incident: row.incident as string | null,
        data: JSON.parse(row.data as string) as unknown }))
  }
  private operatorState() {
    return this.db.prepare('SELECT revision, seq, floor, prunedAt FROM operator_state WHERE id=1').get()! as
      { revision: number; seq: number; floor: number; prunedAt: number }
  }
  view(incident: Incident): IncidentView {
    const viewRevision = incident.viewRevision ?? incident.revision
    return { ...incident, viewRevision, acknowledged: incident.acknowledgement?.revision === viewRevision }
  }
  counts() {
    const rows = this.db.prepare(`SELECT closed, count(*) AS total FROM incidents GROUP BY closed`).all()
    const open = Number(rows.find(row => row.closed === 0)?.total ?? 0), closed = Number(rows.find(row => row.closed === 1)?.total ?? 0)
    const acknowledged = Number(this.db.prepare(`SELECT count(*) AS total FROM incidents WHERE closed=0
      AND data ->> '$.acknowledgement.revision' = coalesce(data ->> '$.viewRevision', data ->> '$.revision')`).get()!.total)
    return { open, closed, unacknowledged: open - acknowledged,
      audit: Number(this.db.prepare('SELECT count(*) AS total FROM audit').get()!.total), prunedAt: this.operatorState().prunedAt }
  }
  private cursor(kind: Cursor['kind'], filter: string, encoded?: string): Cursor {
    const state = this.operatorState()
    if (!encoded) return { kind, filter, before: Number.MAX_SAFE_INTEGER, through: state.seq, revision: state.revision, floor: state.floor }
    let cursor: Cursor
    try { if (encoded.length > 1024) throw new Error(); cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))) }
    catch { throw new WatchdogOperatorError(400, 'invalid_cursor') }
    if (cursor.kind !== kind || cursor.filter !== filter || cursor.through > state.seq) throw new WatchdogOperatorError(400, 'invalid_cursor')
    if (kind === 'incidents' && cursor.revision !== state.revision) throw new WatchdogOperatorError(409, 'incidents_changed_refresh')
    if (kind === 'audit' && cursor.floor !== state.floor) throw new WatchdogOperatorError(410, 'history_expired_refresh')
    return cursor
  }
  incidents(filter: IncidentFilter, encoded?: string, limit = 50): Page<IncidentView> {
    const cursor = this.cursor('incidents', filter, encoded), size = Math.min(100, Math.max(1, limit))
    const condition = filter === 'all' ? '1' : filter === 'closed' ? 'closed=1' : filter === 'open' ? 'closed=0'
      : `closed=0 AND coalesce(data ->> '$.acknowledgement.revision', '') != coalesce(data ->> '$.viewRevision', data ->> '$.revision')`
    const rows = this.db.prepare(`SELECT rowid AS position, data FROM incidents WHERE ${condition} AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
      .all(cursor.before, size + 1)
    return { items: rows.slice(0, size).map(row => this.view(JSON.parse(row.data as string))), cursor: rows.length > size
      ? encodeCursor({ ...cursor, before: Number(rows[size - 1]!.position) }) : null }
  }
  history(incident = '', encoded?: string, limit = 50): Page<AuditEntry> {
    const cursor = this.cursor('audit', incident, encoded), size = Math.min(100, Math.max(1, limit))
    const rows = this.db.prepare(`SELECT seq, at, kind, incident, data FROM audit WHERE seq <= ? AND seq < ?
      AND (? = '' OR incident = ?) ORDER BY seq DESC LIMIT ?`).all(cursor.through, cursor.before, incident, incident, size + 1)
    return { items: rows.slice(0, size).map(row => ({ seq: Number(row.seq), at: Number(row.at), kind: String(row.kind),
      incident: row.incident as string | null, data: JSON.parse(row.data as string) as unknown })), cursor: rows.length > size
      ? encodeCursor({ ...cursor, before: Number(rows[size - 1]!.seq) }) : null }
  }
  acknowledge(input: Acknowledge, now: number): AcknowledgementReceipt {
    const request = AcknowledgeSchema.parse(input), serialized = JSON.stringify(request)
    return this.atomic(() => {
      const previous = this.db.prepare('SELECT request, result FROM acknowledgements WHERE id=?').get(request.requestId)
      if (previous) {
        if (previous.request !== serialized) throw new WatchdogOperatorError(409, 'request_id_conflict')
        return JSON.parse(previous.result as string) as AcknowledgementReceipt
      }
      const issued = Number(request.requestId.slice(3, 16))
      // Cleanup's durable clock floor prevents a clock rollback from making an already-pruned request valid again.
      if (issued > now + 60_000 || Math.max(now, this.operatorState().prunedAt) - issued > ACK_WINDOW_MS)
        throw new WatchdogOperatorError(410, 'acknowledgement_request_expired')
      const incident = this.get(request.incidentId)
      if (!incident) throw new WatchdogOperatorError(404, 'incident_not_found')
      if (incident.closedAt !== undefined || this.view(incident).viewRevision !== request.revision)
        throw new WatchdogOperatorError(409, 'incident_changed_refresh')
      const acknowledgement: Acknowledgement = { requestId: request.requestId, revision: request.revision, at: now,
        actor: 'local-operator', note: request.note }
      incident.acknowledgement = acknowledgement; this.save(incident, false)
      const result = { incidentId: incident.id, acknowledgement }
      this.db.prepare('INSERT INTO acknowledgements VALUES (?, ?, ?, ?)')
        .run(request.requestId, issued + ACK_WINDOW_MS, serialized, JSON.stringify(result))
      this.event(now, 'acknowledged', incident.id, acknowledgement)
      return result
    })
  }
  /** Bounded housekeeping never removes active incidents; acknowledgement replay expires before its receipt is removed. */
  maintain(now: number, policy: RetentionPolicy): { incidents: number; audit: number; receipts: number } {
    return this.atomic(() => {
      if (now - this.operatorState().prunedAt < 60_000) return { incidents: 0, audit: 0, receipts: 0 }
      const day = 86400000, batch = 1000
      const closed = this.db.prepare(`SELECT id FROM incidents WHERE closed=1 AND
        (data ->> '$.closedAt' < ? OR rowid NOT IN (SELECT rowid FROM incidents WHERE closed=1 ORDER BY data ->> '$.closedAt' DESC, rowid DESC LIMIT ?))
        ORDER BY data ->> '$.closedAt', rowid LIMIT ?`).all(now - policy.closedDays * day, policy.maxClosed, batch)
      for (const row of closed) this.db.prepare('DELETE FROM incidents WHERE id=? AND closed=1').run(row.id!)
      const audit = this.db.prepare(`SELECT seq FROM audit WHERE at < ? OR seq NOT IN
        (SELECT seq FROM audit ORDER BY seq DESC LIMIT ?) ORDER BY seq LIMIT ?`).all(now - policy.auditDays * day, policy.maxAudit, batch)
      for (const row of audit) this.db.prepare('DELETE FROM audit WHERE seq=?').run(row.seq!)
      const receipts = this.db.prepare('DELETE FROM acknowledgements WHERE id IN (SELECT id FROM acknowledgements WHERE expires < ? ORDER BY expires LIMIT ?)')
        .run(now, batch).changes as number
      this.db.prepare('UPDATE operator_state SET prunedAt=?, floor=max(floor, ?), revision=revision+? WHERE id=1')
        .run(now, audit.length ? Number(audit.at(-1)!.seq) : 0, closed.length ? 1 : 0)
      if (closed.length || audit.length || receipts) this.event(now, 'retention', null, { incidents: closed.length, audit: audit.length, receipts })
      return { incidents: closed.length, audit: audit.length, receipts }
    })
  }
  close(): void { this.db.close() }
}
