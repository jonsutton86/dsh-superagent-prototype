/** Append-only operator audit trail with a hash chain and secret redaction; no update or delete path. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Store } from '../app/store.ts'

export type AuditOutcome = 'allowed' | 'denied' | 'completed' | 'failed'
export interface AuditInput { actor: string; action: string; resource: string; outcome: AuditOutcome; detail?: Record<string, unknown> }
export interface AuditRecord extends AuditInput { seq: number; at: string; detail: Record<string, unknown>; prev: string; hash: string }

const SECRET = /(secret|token|password|passwd|authorization|api[-_]?key|credential|cookie)/i
const MAX_DEPTH = 6, MAX_ITEMS = 50, MAX_TEXT = 2000

/** Removes secret-shaped values and bounds nested detail before it can be persisted or shown. */
export function redactDetail(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value
  if (value === undefined) return undefined
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(item => redactDetail(item, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS))
      result[key] = SECRET.test(key) ? '[redacted]' : redactDetail(item, depth + 1)
    return result
  }
  return String(value).slice(0, MAX_TEXT)
}

/** Deterministic JSON, so the chain hash does not depend on object key insertion order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort()
    .map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

const digest = (prev: string, body: unknown): string => createHash('sha256').update(prev).update(stable(body)).digest('hex')

/** Creates the audit table beside the existing Store tables; additive, so no data-shape migration is needed. */
export function initializeAuditStore(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, resource TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_event_at ON audit_event(at);`)
}

/** Host-owned audit log. Callers append facts; there is no update or delete API. */
export class AuditLog {
  constructor(private readonly store: Pick<Store, 'db' | 'atomic'>, private readonly now: () => string = () => new Date().toISOString()) {}

  append(input: AuditInput): AuditRecord {
    if (!input.actor.trim() || !input.action.trim() || !input.resource.trim()) throw new Error('Audit entries require an actor, action and resource')
    return this.store.atomic(() => {
      const last = this.store.db.prepare('SELECT seq, hash FROM audit_event ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined
      const seq = Number(last?.seq ?? 0) + 1, prev = last?.hash ?? ''
      const at = this.now(), detail = (redactDetail(input.detail ?? {}) ?? {}) as Record<string, unknown>
      const body = { seq, at, actor: input.actor, action: input.action, resource: input.resource, outcome: input.outcome, detail, prev }
      const hash = digest(prev, { seq, at, actor: body.actor, action: body.action, resource: body.resource, outcome: body.outcome, detail })
      this.store.db.prepare('INSERT INTO audit_event (seq, at, actor, action, resource, outcome, detail, prev, hash) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(seq, at, body.actor, body.action, body.resource, body.outcome, JSON.stringify(detail), prev, hash)
      return { seq, at, actor: body.actor, action: body.action, resource: body.resource, outcome: input.outcome as AuditOutcome,
        detail, prev, hash }
    })
  }

  list(limit = 50, cursor?: number): { items: AuditRecord[]; nextCursor: number | null } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
      throw new Error('Invalid audit page')
    const rows = (cursor === undefined
      ? this.store.db.prepare('SELECT * FROM audit_event ORDER BY seq DESC LIMIT ?').all(limit + 1)
      : this.store.db.prepare('SELECT * FROM audit_event WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(cursor, limit + 1)) as unknown as {
        seq: number; at: string; actor: string; action: string; resource: string; outcome: AuditOutcome; detail: string; prev: string; hash: string }[]
    const items = rows.slice(0, limit).map(row => ({ seq: Number(row.seq), at: row.at, actor: row.actor, action: row.action, resource: row.resource,
      outcome: row.outcome, detail: JSON.parse(row.detail) as Record<string, unknown>, prev: row.prev, hash: row.hash }))
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.seq : null }
  }

  /** Recomputes every link and hash; false means the persisted history was edited or truncated. */
  verify(): boolean {
    let prev = ''
    for (const row of this.store.db.prepare('SELECT * FROM audit_event ORDER BY seq').iterate() as Iterable<{
      seq: number; at: string; actor: string; action: string; resource: string; outcome: AuditOutcome; detail: string; prev: string; hash: string }>) {
      if (row.prev !== prev) return false
      const detail = JSON.parse(row.detail) as Record<string, unknown>
      if (row.hash !== digest(prev, { seq: Number(row.seq), at: row.at, actor: row.actor, action: row.action, resource: row.resource, outcome: row.outcome, detail }))
        return false
      prev = row.hash
    }
    return true
  }
}
