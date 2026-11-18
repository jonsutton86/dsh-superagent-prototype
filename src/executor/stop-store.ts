/** Canonical stop facts share the coordinator transaction and database with assignments and Effects. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Ticket } from '../core/index.ts'
import { StopRecordSchema, StopAttestationReceiptSchema, stopSummary, type StopRecord, type StopHoldSummary } from './stop-model.ts'

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
export const stopDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const stopExecutionDigest = (execution: StopRecord['execution'], world: string | null) => stopDigest({ execution, world })
export const stopScopeDigest = (record: Pick<StopRecord, 'id' | 'ticketId' | 'assignmentId' | 'sessionId' | 'scope' | 'executionBindingHash' | 'jobIds'>) =>
  stopDigest({ id: record.id, ticketId: record.ticketId, assignmentId: record.assignmentId, sessionId: record.sessionId,
    scope: record.scope, executionBindingHash: record.executionBindingHash, jobIds: record.scope === 'jobs' ? record.jobIds : [] })
export function saveStop(db: DatabaseSync, input: StopRecord): void {
  const record = StopRecordSchema.parse(input), value = JSON.stringify(record)
  if (Buffer.byteLength(value) > 256 * 1024) throw new Error('Stop record exceeds its bound')
  if (record.executionBindingHash !== stopExecutionDigest(record.execution, record.world) || record.scopeHash !== stopScopeDigest(record)) throw new Error('Original stop binding differs')
  const prior = readStop(db, record.id)
  if (prior) {
    const immutable = (item: StopRecord) => ({ id: item.id, ticketId: item.ticketId, assignmentId: item.assignmentId, sessionId: item.sessionId,
      createdAt: item.createdAt, instance: item.instance, scopeHash: item.scopeHash, executionBindingHash: item.executionBindingHash,
      legacy: item.legacy, ownTurn: item.ownTurn, keepInbox: item.keepInbox })
    if (stopDigest(immutable(prior)) !== stopDigest(immutable(record)) || prior.sessions.some(id => !record.sessions.includes(id))
      || prior.jobIds.some(id => !record.jobIds.includes(id))) throw new Error('Original stop identity cannot change')
  }
  db.prepare('INSERT INTO executor_stop(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, value)
}
/** Validate original authority on restore before effects or Sessions may run; diagnostics contain no request bodies. */
export function validateStopAuthority(db: DatabaseSync, tickets: ReadonlyMap<string, Ticket>, check: (bytes: number) => void): Map<string, StopRecord> {
  const records = new Map<string, StopRecord>()
  for (const row of db.prepare('SELECT id,value FROM executor_stop ORDER BY id').iterate()) {
    check(Buffer.byteLength(String(row.value)))
    const record = StopRecordSchema.parse(JSON.parse(String(row.value))), ticket = tickets.get(record.ticketId)
    const assignment = ticket?.assignments.find(item => item.id === record.assignmentId)
    if (record.id !== row.id || !assignment || record.executionBindingHash !== stopExecutionDigest(record.execution, record.world)
      || record.scopeHash !== stopScopeDigest(record) || stopDigest(record.execution) !== stopDigest(assignment.execution ?? null)) throw new Error('Invalid original stop authority')
    if (record.proof === 'undispatched' && (record.legacy || record.scope !== 'all' || record.dispatched || record.jobIds.length
      || !record.coverageConsumed && (assignment.startedAt || assignment.deliveredAt || assignment.report))) throw new Error('Invalid no-dispatch proof')
    records.set(record.id, record)
  }
  const accepted = new Map<string, string>()
  for (const row of db.prepare('SELECT * FROM executor_stop_control ORDER BY id').iterate()) {
    check(Buffer.byteLength(String(row.value)))
    const receipt = StopAttestationReceiptSchema.parse(JSON.parse(String(row.value))), stop = records.get(receipt.stopId)
    if (!stop || row.id !== receipt.requestId || row.stop_id !== receipt.stopId || row.fingerprint !== receipt.requestHash
      || receipt.ticketId !== stop.ticketId || receipt.assignmentId !== stop.assignmentId
      || receipt.requestHash !== stopDigest({ stopId: stop.id, ticketId: stop.ticketId, assignmentId: stop.assignmentId, request: receipt.request })
      || receipt.observedRevision > stop.revision) throw new Error('Invalid original stop receipt')
    if (receipt.phase === 'accepted') {
      if (stop.attestationId !== receipt.requestId || stop.proof !== 'operator' || stop.world !== null || !stop.execution || stop.state !== 'quiet'
        || receipt.request.scopeHash !== stop.scopeHash || receipt.request.executionBindingHash !== stop.executionBindingHash
        || accepted.has(stop.id)) throw new Error('Invalid accepted stop receipt')
      accepted.set(stop.id, receipt.requestId)
    }
  }
  for (const stop of records.values()) if (stop.attestationId && accepted.get(stop.id) !== stop.attestationId) throw new Error('Missing original stop receipt')
  return records
}
export function readStop(db: DatabaseSync, id: string): StopRecord | undefined {
  const row = db.prepare('SELECT value FROM executor_stop WHERE id=?').get(id)
  return row ? StopRecordSchema.parse(JSON.parse(String(row.value))) : undefined
}
/** Indexed read only; no Session load, remote probe, or control dispatch. */
export function stopHolds(store: { db: DatabaseSync }, ticketId: string): StopHoldSummary[] {
  return store.db.prepare("SELECT value FROM executor_stop WHERE ticket=? AND state NOT IN ('quiet','dormant') ORDER BY id LIMIT 100").all(ticketId)
    .map(row => stopSummary(StopRecordSchema.parse(JSON.parse(String(row.value)))))
}
/** Create the schema before services start; legacy coverage is unknown, never a historical cancellation receipt. */
export function initializeStopStore(db: DatabaseSync, previousVersion?: number): void {
  if (previousVersion === 13 && (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_stop'").get()
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_stop_control'").get())) throw new Error('Missing original stop authority')
  db.exec(`CREATE TABLE IF NOT EXISTS executor_stop (id TEXT PRIMARY KEY,value TEXT NOT NULL,
    ticket TEXT GENERATED ALWAYS AS (json_extract(value,'$.ticketId')),
    assignment TEXT GENERATED ALWAYS AS (json_extract(value,'$.assignmentId')),
    state TEXT GENERATED ALWAYS AS (json_extract(value,'$.state')),
    revision INTEGER GENERATED ALWAYS AS (json_extract(value,'$.revision')));
    CREATE INDEX IF NOT EXISTS executor_stop_ticket ON executor_stop(ticket,state,id);
    CREATE INDEX IF NOT EXISTS executor_stop_assignment ON executor_stop(assignment,state,id);
    CREATE TABLE IF NOT EXISTS executor_stop_control(id TEXT PRIMARY KEY,stop_id TEXT NOT NULL,fingerprint TEXT NOT NULL,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS executor_stop_control_stop ON executor_stop_control(stop_id,id);`)
  if (previousVersion === undefined || previousVersion >= 13) return
  const createdAt = new Date().toISOString()
  for (const row of db.prepare('SELECT value FROM ticket ORDER BY id').iterate()) {
    const ticket = JSON.parse(String(row.value)) as Ticket, latest = ticket.assignments.at(-1)
    if (!latest) continue
    const assignment = latest.state === 'pending' && ticket.assignments.length > 1 ? ticket.assignments.at(-2)! : latest
    const id = stopDigest(['legacy-stop-coverage', ticket.id, assignment.id]), execution = assignment.execution ?? null
    const world = execution?.environment?.world ?? null
    if (readStop(db, id)) continue
    const record: StopRecord = { version: 1, id, ticketId: ticket.id, assignmentId: assignment.id, sessionId: 'worker-' + ticket.id,
      revision: 1, scope: 'legacy', state: ticket.ended ? 'dormant' : 'unknown',
      reason: 'Legacy Session work has no recorded stop proof; original producer assignment is unknown', execution, world,
      executionBindingHash: stopExecutionDigest(execution, world), scopeHash: '', createdAt, instance: null, legacy: true, keepInbox: true,
      ownTurn: false, jobIds: [], sessions: ['worker-' + ticket.id], dispatched: false, coverageConsumed: false, proof: null, settledAt: null, attestationId: null }
    record.scopeHash = stopScopeDigest(record); saveStop(db, record)
  }
}
