/** Bounded read-only inspection shared by product recovery graphs. Never initializes a product service. */
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

export const stateId = z.string().min(1).max(4096), stateAt = z.iso.datetime({ offset: true })
export const stateCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), statePositive = stateCount.min(1)
export const stateDigest = z.string().regex(/^[a-f0-9]{64}$/), stateKey = z.string().regex(/^[a-f0-9]{32}$/)
export const stateObject = z.record(z.string(), z.unknown())
/** Static relation labels keep saved prompts, commands, paths and credentials out of recovery errors. */
export class ProductStateError extends Error {
  constructor(readonly graph: string, readonly code: string, readonly relation: string) { super(`recovery_${graph}_${code}: ${relation}`) }
}
/** The caller holds exclusive state ownership; reads are charged even when the same record is referenced again. */
export class StateReader {
  readonly tables: Set<string>
  records = 0
  private bytes = 0
  private links = 0
  private readonly hash = createHash('sha256')
  constructor(readonly db: DatabaseSync, readonly signal: AbortSignal, readonly graph: string) {
    this.tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
  }
  fail(code: string, label: string): never { throw new ProductStateError(this.graph, code, label) }
  same(a: unknown, b: unknown, label: string): void { if (!isDeepStrictEqual(a, b)) this.fail('conflict', label) }
  parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success || !isDeepStrictEqual(parsed.data, value)) this.fail('shape', label)
    return value as T
  }
  charge(value: unknown, label: string): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value), size = Buffer.byteLength(text)
    if (++this.records > 250000 || size > 8 * 1024 * 1024 || (this.bytes += size) > 256 * 1024 * 1024) this.fail('limit', label)
    this.hash.update(JSON.stringify([label, text]) + '\n')
  }
  json<T>(raw: unknown, schema: z.ZodType<T>, label: string): T {
    this.charge(String(raw), label)
    let value: unknown; try { value = JSON.parse(String(raw)) } catch { this.fail('shape', label) }
    return this.parse(schema, value, label)
  }
  *rows(table: string) {
    if (!this.tables.has(table)) return
    for (const row of this.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).iterate()) { this.charge(row, table); yield row }
  }
  core<T>(table: string, identity: string): T {
    const row = this.tables.has(table) && this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(identity)
    if (!row) this.fail('reference', table)
    return this.json(row.value, stateObject, table) as T
  }
  needed<T>(map: Map<string, T>, identity: string, label: string): T { return map.get(identity) ?? this.fail('reference', label) }
  async step(): Promise<void> {
    this.signal.throwIfAborted()
    if (++this.links > 2_000_000) this.fail('limit', 'relations')
    if (this.links % 64 === 0) await setImmediate(undefined, { signal: this.signal })
  }
  digest(): string { this.signal.throwIfAborted(); return this.hash.digest('hex') }
}
