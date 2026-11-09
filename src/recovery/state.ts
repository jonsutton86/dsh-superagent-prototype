import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { KV } from '../kv.ts'

const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const maintenance = new Set<string>([KV.recovery.hold, KV.recovery.reservation, KV.recovery.audit, KV.recovery.preparation])

/** Compare logical SQLite state, including row order and schema, without depending on WAL layout or loading all rows. */
export function recoveryStateDigest(db: DatabaseSync, signal?: AbortSignal): string {
  const hash = createHash('sha256')
  const append = (value: unknown) => hash.update(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { integer: String(item) }
    : item instanceof Uint8Array ? { blob: Buffer.from(item).toString('base64') } : item) + '\n')
  const tables = db.prepare('PRAGMA table_list').all()
  for (const definition of db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').iterate()) {
    signal?.throwIfAborted()
    append(definition)
    if (definition.type !== 'table') continue
    const table = String(definition.name), withoutRowid = tables.find(item => item.name === table)?.wr === 1
    const columns = db.prepare(`PRAGMA table_info(${identifier(table)})`).all().map(item => identifier(String(item.name)))
    const rows = db.prepare(withoutRowid ? `SELECT * FROM ${identifier(table)} ORDER BY ${columns.join(',')}`
      : `SELECT rowid AS __restore_rowid,* FROM ${identifier(table)} ORDER BY rowid`)
    rows.setReadBigInts(true)
    for (const row of rows.iterate()) { signal?.throwIfAborted(); if (table !== 'kv' || !maintenance.has(String(row.key))) append(row) }
  }
  return hash.digest('hex')
}
