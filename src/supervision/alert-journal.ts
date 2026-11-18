/** Alert intents and receipts share the independent watchdog database and its single-writer lock. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ALERT_LIMIT, ALERT_TERMINAL_DAYS, alertDestinationHash, alertHash, alertView,
  type AlertCandidate, type AlertList, type AlertPhase, type AlertRecord, type AlertRoute, type AlertView } from './alert-protocol.ts'
import { WatchdogOperatorError } from './protocol.ts'

interface Source {
  active: boolean; epoch: number; revision: string; at: number;
  reservations: Record<string, { destination: string; revision: string; at: number }>;
}
const terminal = new Set<AlertPhase>(['accepted', 'rejected', 'cancelled'])

/** Transactions preserve the dispatch boundary, deduplication floor, evidence and original delivery identity together. */
export class AlertJournal {
  constructor(private readonly db: DatabaseSync, private readonly audit: (at: number, kind: string, incident: string | null, data: unknown) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS alert_receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL, route TEXT NOT NULL, phase TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS alert_subject ON alert_receipts(subject, route);
      CREATE TABLE IF NOT EXISTS alert_sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO alert_state VALUES (1, 0);`)
    // A durable dispatch with no settled receipt is ambiguous after any watchdog restart.
    this.atomic(() => {
      for (const row of db.prepare("SELECT data FROM alert_receipts WHERE phase='sending'").all()) {
        const receipt = JSON.parse(String(row.data)) as AlertRecord
        this.save({ ...receipt, phase: 'unknown', reason: 'watchdog_restarted_after_dispatch' }, receipt.updatedAt)
      }
    })
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = work(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private save(value: AlertRecord, now: number): AlertRecord {
    const result = { ...value, updatedAt: now }
    this.db.prepare(`INSERT INTO alert_receipts (id, subject, route, phase, updated, data) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, updated=excluded.updated, data=excluded.data`)
      .run(result.id, result.subjectId, result.routeId, result.phase, now, JSON.stringify(result))
    this.db.prepare('UPDATE alert_state SET revision=revision+1 WHERE id=1').run()
    this.audit(now, `alert_${result.phase}`, result.incidentId ?? null, alertView(result))
    return result
  }
  get(id: string): AlertRecord | undefined {
    const row = this.db.prepare('SELECT data FROM alert_receipts WHERE id=?').get(id)
    return row ? JSON.parse(String(row.data)) as AlertRecord : undefined
  }
  private source(id: string): Source | undefined {
    const row = this.db.prepare('SELECT data FROM alert_sources WHERE id=?').get(id)
    return row ? JSON.parse(String(row.data)) as Source : undefined
  }
  private saveSource(id: string, value: Source): void {
    this.db.prepare('INSERT INTO alert_sources VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(value))
  }
  size(): number { return Number(this.db.prepare('SELECT count(*) AS total FROM alert_receipts').get()!.total) }
  private sourceSize(): number { return Number(this.db.prepare('SELECT count(*) AS total FROM alert_sources').get()!.total) }
  private reservationSize(): number {
    return Number(this.db.prepare("SELECT count(*) AS total FROM alert_sources, json_each(alert_sources.data, '$.reservations')").get()!.total)
  }
  pending(): AlertRecord[] {
    return this.db.prepare("SELECT data FROM alert_receipts WHERE phase='prepared' AND json_extract(data, '$.reason') IS NULL ORDER BY seq LIMIT 8")
      .all().map(row => JSON.parse(String(row.data)))
  }
  /** Selection is deterministic host policy. Changing model text cannot select destinations or authorize recovery. */
  sync(candidates: AlertCandidate[], routes: AlertRoute[], now: number): void {
    this.atomic(() => {
      const current = new Set(candidates.map(candidate => candidate.subjectId))
      for (const row of this.db.prepare('SELECT id, data FROM alert_sources').all()) {
        const source = JSON.parse(String(row.data)) as Source
        if (source.active && !current.has(String(row.id))) this.saveSource(String(row.id), { ...source, active: false, at: now })
      }
      for (const candidate of candidates) {
        const previous = this.source(candidate.subjectId)
        // Disabled routing creates no alert metadata. Deduplication floors have their own hard bounds as receipts expire.
        if (!previous && (!routes.length || this.size() >= ALERT_LIMIT || this.sourceSize() >= ALERT_LIMIT || this.reservationSize() >= ALERT_LIMIT)) continue
        const epoch = (previous?.epoch ?? 0) + (previous?.active ? 0 : 1)
        const source: Source = { active: true, epoch, at: now, revision: alertHash([epoch, candidate.evidenceKey]),
          reservations: previous?.reservations ?? {} }
        this.saveSource(candidate.subjectId, source)
        for (const route of routes) {
          const destination = alertDestinationHash(route)
          const reserved = Object.hasOwn(source.reservations, route.id) ? source.reservations[route.id] : undefined
          const unsettled = this.db.prepare("SELECT 1 FROM alert_receipts WHERE subject=? AND route=? AND phase IN ('prepared','sending','unknown') LIMIT 1")
            .get(candidate.subjectId, route.id)
          if (unsettled || (reserved?.destination === destination && (reserved.revision === source.revision || now - reserved.at < route.cooldownMs))) continue
          if (this.size() >= ALERT_LIMIT || (!reserved && this.reservationSize() >= ALERT_LIMIT)) break
          const payload = { subjectId: candidate.subjectId, ...(candidate.incidentId ? { incidentId: candidate.incidentId } : {}),
            evidenceRevision: source.revision, title: candidate.title, finding: candidate.finding, evidence: candidate.evidence,
            observedAt: candidate.observedAt, trust: 'untrusted-observation' as const }
          this.save({ id: randomUUID(), routeId: route.id, routeName: route.name, subjectId: candidate.subjectId,
            ...(candidate.incidentId ? { incidentId: candidate.incidentId } : {}), evidenceRevision: source.revision,
            title: payload.title, finding: payload.finding, createdAt: now, updatedAt: now, phase: 'prepared',
            destinationHash: destination, payloadHash: alertHash(payload), payload }, now)
          source.reservations[route.id] = { destination, revision: source.revision, at: now }
          this.saveSource(candidate.subjectId, source)
        }
        // Preserve bounded deduplication floors through disabled/re-enabled routes, including after receipt retention.
      }
      for (const row of this.db.prepare("SELECT data FROM alert_receipts WHERE phase='prepared'").all()) {
        const record = JSON.parse(String(row.data)) as AlertRecord, source = this.source(record.subjectId)
        const route = routes.find(route => route.id === record.routeId)
        if (!source?.active || source.revision !== record.evidenceRevision || !route || alertDestinationHash(route) !== record.destinationHash)
          this.save({ ...record, phase: 'cancelled', reason: !route || alertDestinationHash(route) !== record.destinationHash
            ? 'destination_configuration_changed' : 'evidence_changed_or_acknowledged' }, now)
      }
      const obsolete = this.db.prepare("SELECT id FROM alert_receipts WHERE phase IN ('accepted','rejected','cancelled') AND updated < ? ORDER BY seq LIMIT 100")
        .all(now - ALERT_TERMINAL_DAYS * 86400000)
      for (const row of obsolete) this.db.prepare('DELETE FROM alert_receipts WHERE id=?').run(row.id!)
      if (obsolete.length) this.db.prepare('UPDATE alert_state SET revision=revision+1 WHERE id=1').run()
      this.db.prepare(`DELETE FROM alert_sources WHERE id IN (SELECT id FROM alert_sources
        WHERE json_extract(data, '$.active')=0 AND json_extract(data, '$.at') < ?
        AND NOT EXISTS (SELECT 1 FROM alert_receipts WHERE subject=alert_sources.id) LIMIT 100)`)
        .run(now - ALERT_TERMINAL_DAYS * 86400000)
    })
  }
  /** Persist before I/O; only prepared work with unchanged evidence and route can cross this boundary. */
  dispatch(id: string, destination: string, now: number): AlertRecord {
    return this.atomic(() => {
      const receipt = this.require(id), source = this.source(receipt.subjectId)
      if (receipt.phase !== 'prepared') throw new WatchdogOperatorError(409, 'alert_already_dispatched_or_settled')
      if (receipt.destinationHash !== destination) throw new WatchdogOperatorError(409, 'alert_destination_changed')
      if (!source?.active || source.revision !== receipt.evidenceRevision) throw new WatchdogOperatorError(409, 'alert_evidence_changed')
      return this.save({ ...receipt, phase: 'sending', dispatchedAt: now, reason: undefined }, now)
    })
  }
  require(id: string): AlertRecord {
    const value = this.get(id)
    if (!value) throw new WatchdogOperatorError(404, 'alert_not_found')
    return value
  }
  outcome(id: string, phase: 'unknown' | 'accepted' | 'rejected', reason: string, now: number): AlertRecord {
    return this.atomic(() => {
      const previous = this.require(id)
      if (terminal.has(previous.phase)) return previous
      if (!['sending', 'unknown'].includes(previous.phase)) throw new WatchdogOperatorError(409, 'alert_not_dispatched')
      return this.save({ ...previous, phase, reason }, now)
    })
  }
  preparedError(id: string, reason: string, now: number): AlertRecord {
    return this.atomic(() => {
      const previous = this.require(id)
      return previous.phase === 'prepared' && previous.reason !== reason ? this.save({ ...previous, reason }, now) : previous
    })
  }
  cancel(id: string, now: number): AlertView {
    return this.atomic(() => {
      const previous = this.require(id)
      if (previous.phase === 'cancelled') return alertView(previous)
      if (previous.phase !== 'prepared') throw new WatchdogOperatorError(409, 'dispatched_alert_cannot_be_cancelled')
      return alertView(this.save({ ...previous, phase: 'cancelled', reason: 'operator_cancelled_before_dispatch' }, now))
    })
  }
  list(routes: AlertRoute[], encoded?: string): AlertList {
    const revision = Number(this.db.prepare('SELECT revision FROM alert_state WHERE id=1').get()!.revision)
    let before = Number.MAX_SAFE_INTEGER
    if (encoded) {
      let cursor: unknown
      try { if (encoded.length > 200) throw new Error(); cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) }
      catch { throw new WatchdogOperatorError(400, 'invalid_cursor') }
      if (!Array.isArray(cursor) || cursor.length !== 2 || !cursor.every(Number.isSafeInteger) || cursor[0] < 0 || cursor[1] < 1)
        throw new WatchdogOperatorError(400, 'invalid_cursor')
      if (cursor[0] !== revision) throw new WatchdogOperatorError(409, 'alerts_changed_refresh')
      before = cursor[1]
    }
    const rows = this.db.prepare('SELECT seq, data FROM alert_receipts WHERE seq < ? ORDER BY seq DESC LIMIT 51').all(before)
    return { routes: routes.map(route => ({ id: route.id, name: route.name })), capacity: { used: this.size(), limit: ALERT_LIMIT,
      sourcesUsed: this.sourceSize(), sourcesLimit: ALERT_LIMIT, reservationsUsed: this.reservationSize(), reservationsLimit: ALERT_LIMIT },
      items: rows.slice(0, 50).map(row => alertView(JSON.parse(String(row.data)))),
      cursor: rows.length > 50 ? Buffer.from(JSON.stringify([revision, Number(rows[49]!.seq)])).toString('base64url') : null }
  }
}
