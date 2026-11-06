/** Independent SQLite incident journal, audit log and delivery receipts for the watchdog. */
import { chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { key } from '../core/index.ts'
import type { ObservationSet } from './client.ts'
import type { Assessment, InterventionResult, Observation } from './protocol.ts'

export interface Incident {
  id: string; revision: string; instance: string; observation: Observation; openedAt: number; cycleAt: number;
  updatedAt: number; closedAt?: number; attempts: number; delivery?: { id: string; at: number; sent: boolean };
  assessment?: Assessment; intervention?: InterventionResult;
}
export interface MonitorStatus { at: number; reachable: boolean; lastSuccess?: number; error?: string; modelError?: string;
  configured?: boolean; paused?: boolean; health?: ObservationSet['health'] }

/** Owns watchdog state only; transactions keep observations, diagnoses and delivery reservations consistent after restart. */
export class WatchdogJournal {
  private readonly db: DatabaseSync
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number
      if (version > 1) throw new Error(`Unsupported watchdog schema ${version}`)
      this.db.exec(`CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, closed INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS monitor (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, incident TEXT, data TEXT NOT NULL);
        PRAGMA user_version=1;`)
    } catch (error) { this.db.close(); throw error }
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = work(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private save(incident: Incident): void {
    this.db.prepare('INSERT OR REPLACE INTO incidents VALUES (?, ?, ?)').run(incident.id, incident.closedAt === undefined ? 0 : 1, JSON.stringify(incident))
  }
  private event(at: number, kind: string, incident: string | null, data: unknown): void {
    this.db.prepare('INSERT INTO audit (at, kind, incident, data) VALUES (?, ?, ?, ?)').run(at, kind, incident, JSON.stringify(data))
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
        const blocked = observation.stage === 'person/blocked' || observation.stage === 'person/failed'
        if (snapshot.paused || !snapshot.configured || (!working && !blocked)) continue
        const id = key(`watchdog:${observation.id}:${observation.assignmentId ?? 'queued'}`), previous = this.get(id)
        seen.add(id)
        if (previous && previous.closedAt === undefined && previous.observation.revision === observation.revision
          && previous.instance === snapshot.instance && now - previous.cycleAt < reviewEveryMs) continue
        const incident: Incident = { id, revision: randomUUID(), instance: snapshot.instance,
          observation, openedAt: previous?.closedAt === undefined ? previous?.openedAt ?? now : now,
          cycleAt: now, updatedAt: now, attempts: 0 }
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
      this.save(incident); this.event(now, 'delivery_reserved', id, incident.delivery)
      return incident
    })
  }
  delivered(id: string, deliveryId: string): void {
    const incident = this.get(id)
    if (incident?.delivery?.id !== deliveryId) return
    incident.delivery.sent = true; this.save(incident)
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
  close(): void { this.db.close() }
}
