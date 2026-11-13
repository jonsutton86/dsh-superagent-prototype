/** Persistent typed memory: scoped records, provenance events, dedup/upsert, FTS5 search and hard deletion. */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Store } from '../app/store.ts'
import type { AuditLog } from '../security/audit.ts'

export const MemoryKind = z.enum(['fact', 'preference', 'goal', 'decision', 'conversation', 'project', 'profile'])
export type MemoryKind = z.infer<typeof MemoryKind>
export const MemorySensitivity = z.enum(['normal', 'private'])
export type MemorySensitivity = z.infer<typeof MemorySensitivity>
const projectName = z.string().trim().min(1).max(100)
export const MemoryScope = z.object({
  type: z.enum(['personal', 'business', 'project']),
  project: projectName.optional(),
}).strict().superRefine((scope, ctx) => {
  if (scope.type === 'project' && !scope.project) ctx.addIssue({ code: 'custom', path: ['project'], message: 'is required for a project scope' })
  if (scope.type !== 'project' && scope.project) ctx.addIssue({ code: 'custom', path: ['project'], message: 'is only valid for a project scope' })
})
export type MemoryScope = z.infer<typeof MemoryScope>

export const scopeKey = (scope: MemoryScope): string => scope.type === 'project' ? `project:${scope.project}` : scope.type
export function parseScopeKey(key: string): MemoryScope {
  if (key === 'personal' || key === 'business') return { type: key }
  const project = key.startsWith('project:') ? key.slice('project:'.length) : ''
  return MemoryScope.parse({ type: 'project', project })
}

export const MemorySource = z.enum(['operator', 'agent', 'conversation', 'import', 'system'])
export const MemoryInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200).optional(),
  kind: MemoryKind,
  scope: MemoryScope,
  /** Stable key for upsert and display, such as a profile name, goal name or project. */
  subject: z.string().trim().max(200).default(''),
  content: z.string().trim().min(1).max(20_000),
  summary: z.string().trim().max(1000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  sensitivity: MemorySensitivity.default('normal'),
  source: MemorySource.default('operator'),
  sourceRef: z.string().trim().max(500).optional(),
}).strict()
export type MemoryInput = z.input<typeof MemoryInputSchema>

export interface MemoryProvenance { source: z.infer<typeof MemorySource>; at: string; actor?: string; ref?: string }
export interface MemoryRecord {
  id: string
  kind: MemoryKind
  scope: MemoryScope
  scopeKey: string
  subject: string
  content: string
  summary?: string
  tags: string[]
  sensitivity: MemorySensitivity
  provenance: MemoryProvenance
  revision: number
  createdAt: string
  updatedAt: string
  contentHash: string
}
export interface MemoryEvent { id: number; memory: string; scope: string; action: 'created' | 'updated' | 'deleted'; at: string; actor: string; detail: Record<string, unknown> }
export interface MemorySearch { q?: string; scope?: MemoryScope; kinds?: MemoryKind[]; limit?: number; cursor?: string }
export interface MemoryPage { items: MemoryRecord[]; nextCursor: string | null }

export const MEMORY_KINDS = MemoryKind.options
const UPSERT_KINDS = new Set<MemoryKind>(['profile', 'goal', 'preference', 'decision', 'project'])

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
const digest = (scope: string, kind: string, subject: string, content: string): string =>
  createHash('sha256').update([scope, kind, subject.toLowerCase(), normalize(content)].join('\u0000')).digest('hex')

/** Creates memory tables beside the existing Store tables; additive, so no data-shape migration is needed. */
export function initializeMemoryStore(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_record (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
      subject_key TEXT NOT NULL, value TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS memory_identity ON memory_record(scope, kind, subject_key, content_hash);
    CREATE INDEX IF NOT EXISTS memory_scope_time ON memory_record(scope, updated_at);
    CREATE TABLE IF NOT EXISTS memory_event (id INTEGER PRIMARY KEY AUTOINCREMENT, memory TEXT NOT NULL, scope TEXT NOT NULL,
      action TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_event_memory ON memory_event(memory, id);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory UNINDEXED, content, subject, tags);`)
}

/** Deny-by-default scope grants. `*` allows every local scope; `project:*` allows every project; exact keys otherwise. */
export class MemoryAccess {
  private readonly grants: readonly string[]
  constructor(grants: readonly string[]) { this.grants = grants }
  static owner(): MemoryAccess { return new MemoryAccess(['*']) }
  allows(scope: string): boolean {
    return this.grants.some(grant => grant === '*' || grant === scope || grant === 'project:*' && scope.startsWith('project:'))
  }
  /** SQL predicate over a `scope` column plus its bindings, or undefined when no scope is granted. */
  filter(column = 'scope'): { sql: string; params: string[] } | undefined {
    if (this.grants.includes('*')) return { sql: '1=1', params: [] }
    const exact = this.grants.filter(grant => grant !== 'project:*')
    const parts: string[] = [], params: string[] = []
    if (exact.length) { parts.push(`${column} IN (${exact.map(() => '?').join(',')})`); params.push(...exact) }
    if (this.grants.includes('project:*')) parts.push(`${column} LIKE 'project:%'`)
    return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : undefined
  }
}

/** Typed memory failure carrying the HTTP status the management route maps without leaking record existence. */
export class MemoryError extends Error { constructor(readonly status: 400 | 403 | 404, message: string) { super(message) } }

/** Store-backed memory. Every read is scope-filtered; deletion is real, with an append-only event retained. */
export class Memory {
  constructor(private readonly host: { store: Pick<Store, 'db' | 'atomic'>; audit?: Pick<AuditLog, 'append'> },
    private readonly now: () => string = () => new Date().toISOString()) {}

  private parse(value: string): MemoryRecord { return JSON.parse(value) as MemoryRecord }
  private requireAccess(access: MemoryAccess, scope: string): void {
    if (!access.allows(scope)) throw new MemoryError(403, 'This memory scope is not authorized')
  }

  get(access: MemoryAccess, id: string): MemoryRecord | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM memory_record WHERE id=?').get(id) as { value: string } | undefined
    if (!row) return undefined
    const record = this.parse(row.value)
    return access.allows(record.scopeKey) ? record : undefined
  }

  events(access: MemoryAccess, id: string): MemoryEvent[] {
    const rows = this.host.store.db.prepare('SELECT * FROM memory_event WHERE memory=? ORDER BY id').all(id) as unknown as {
      id: number; memory: string; scope: string; action: MemoryEvent['action']; at: string; actor: string; detail: string }[]
    return rows.filter(row => access.allows(row.scope)).map(row => ({ id: Number(row.id), memory: row.memory, scope: row.scope,
      action: row.action, at: row.at, actor: row.actor, detail: JSON.parse(row.detail) as Record<string, unknown> }))
  }

  /** Deduplicates identical facts; for profile/goal/preference/decision/project with a subject it upserts the current one. */
  save(access: MemoryAccess, input: MemoryInput, actor = 'operator'): { record: MemoryRecord; created: boolean } {
    const value = MemoryInputSchema.parse(input), key = scopeKey(value.scope)
    this.requireAccess(access, key)
    const subject = value.subject.trim(), subjectKey = subject.toLowerCase(), contentHash = digest(key, value.kind, subject, value.content)
    const at = this.now()
    return this.host.store.atomic(() => {
      const exact = this.host.store.db.prepare('SELECT value FROM memory_record WHERE scope=? AND kind=? AND subject_key=? AND content_hash=?')
        .get(key, value.kind, subjectKey, contentHash) as { value: string } | undefined
      if (exact) return { record: this.parse(exact.value), created: false }
      const existing = subject && UPSERT_KINDS.has(value.kind)
        ? this.host.store.db.prepare('SELECT id, value FROM memory_record WHERE scope=? AND kind=? AND subject_key=? ORDER BY updated_at DESC LIMIT 1')
          .get(key, value.kind, subjectKey) as { id: string; value: string } | undefined
        : undefined
      const prior = existing ? this.parse(existing.value) : undefined
      const record: MemoryRecord = {
        id: prior?.id ?? randomUUID(), kind: value.kind, scope: value.scope, scopeKey: key, subject,
        content: value.content, ...(value.summary ? { summary: value.summary } : {}), tags: [...new Set(value.tags)],
        sensitivity: value.sensitivity, provenance: { source: value.source, at, actor, ...(value.sourceRef ? { ref: value.sourceRef } : {}) },
        revision: (prior?.revision ?? 0) + 1, createdAt: prior?.createdAt ?? at, updatedAt: at, contentHash,
      }
      this.host.store.db.prepare(`INSERT INTO memory_record (id, scope, kind, subject_key, value, content_hash, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, content_hash=excluded.content_hash, updated_at=excluded.updated_at`)
        .run(record.id, key, value.kind, subjectKey, JSON.stringify(record), contentHash, record.createdAt, at)
      this.host.store.db.prepare('DELETE FROM memory_fts WHERE memory=?').run(record.id)
      this.host.store.db.prepare('INSERT INTO memory_fts (memory, content, subject, tags) VALUES (?,?,?,?)')
        .run(record.id, record.content, record.summary ?? record.subject, record.tags.join(' '))
      this.event(record.id, key, prior ? 'updated' : 'created', actor, { kind: record.kind, revision: record.revision })
      this.host.audit?.append({ actor, action: prior ? 'memory.update' : 'memory.create', resource: record.id, outcome: 'completed',
        detail: { kind: record.kind, scope: key, revision: record.revision } })
      return { record, created: !prior }
    })
  }

  /** FTS5 search (quoted tokens) with a LIKE fallback for query-syntax edge cases; always scope-filtered. */
  search(access: MemoryAccess, input: MemorySearch = {}): MemoryPage {
    const limit = Math.min(50, Math.max(1, input.limit ?? 20))
    const grant = access.filter('m.scope')
    if (!grant) return { items: [], nextCursor: null }
    const where: string[] = [grant.sql], params: string[] = [...grant.params]
    if (input.scope) { where.push('m.scope = ?'); params.push(scopeKey(input.scope)) }
    if (input.kinds?.length) { where.push(`m.kind IN (${input.kinds.map(() => '?').join(',')})`); params.push(...input.kinds) }
    if (input.cursor) {
      const separator = input.cursor.indexOf('|')
      const updatedAt = input.cursor.slice(0, separator), id = input.cursor.slice(separator + 1)
      where.push('(m.updated_at < ? OR (m.updated_at = ? AND m.id < ?))'); params.push(updatedAt, updatedAt, id)
    }
    const q = input.q ? normalize(input.q) : ''
    const sql = q
      ? `SELECT m.value, m.updated_at, m.id FROM memory_fts JOIN memory_record m ON m.id = memory_fts.memory
         WHERE memory_fts MATCH ? AND ${where.join(' AND ')} ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`
      : `SELECT m.value, m.updated_at, m.id FROM memory_record m WHERE ${where.join(' AND ')} ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`
    const binds = q ? [quoteQuery(q), ...params, limit + 1] : [...params, limit + 1]
    let rows: { value: string; updated_at: string; id: string }[]
    try { rows = this.host.store.db.prepare(sql).all(...binds) as unknown as typeof rows }
    catch {
      if (!q) throw new MemoryError(400, 'Memory search is unavailable')
      const fallback = `SELECT m.value, m.updated_at, m.id FROM memory_record m WHERE ${where.join(' AND ')}
        AND (m.value LIKE ? OR m.value LIKE ?) ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`
      rows = this.host.store.db.prepare(fallback).all(...params, `%${q}%`, `%${q}%`, limit + 1) as unknown as typeof rows
    }
    const items = rows.slice(0, limit).map(row => this.parse(row.value))
    return { items, nextCursor: rows.length > limit ? `${rows[limit - 1]!.updated_at}|${rows[limit - 1]!.id}` : null }
  }

  /** Hard deletion: the record and its search index are removed; the append-only event records that it existed. */
  delete(access: MemoryAccess, id: string, actor = 'operator'): boolean {
    const record = this.get(access, id)
    if (!record) return false
    return this.host.store.atomic(() => {
      this.host.store.db.prepare('DELETE FROM memory_record WHERE id=?').run(id)
      this.host.store.db.prepare('DELETE FROM memory_fts WHERE memory=?').run(id)
      this.event(id, record.scopeKey, 'deleted', actor, { kind: record.kind, subject: record.subject })
      this.host.audit?.append({ actor, action: 'memory.delete', resource: id, outcome: 'completed', detail: { kind: record.kind, scope: record.scopeKey } })
      return true
    })
  }

  private event(memory: string, scope: string, action: MemoryEvent['action'], actor: string, detail: Record<string, unknown>): void {
    this.host.store.db.prepare('INSERT INTO memory_event (memory, scope, action, at, actor, detail) VALUES (?,?,?,?,?,?)')
      .run(memory, scope, action, this.now(), actor, JSON.stringify(detail))
  }
}

/** Quotes every token for FTS5 so operators in the query cannot change the search's structure. */
function quoteQuery(query: string): string {
  return query.split(/\s+/).filter(Boolean).map(token => `"${token.replace(/"/g, '""')}"`).join(' ')
}
