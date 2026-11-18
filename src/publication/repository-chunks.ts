/** Shared byte-integrity checks, without merging the coordinator and publisher's independent stores. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { REPOSITORY_EXPORT_LIMITS as L, type RepositoryBundle } from './repository-export-model.ts'

export function* repositoryChunks(db: DatabaseSync, table: 'repository_export_chunk' | 'repository_transfer_chunk', id: string,
  bundle: RepositoryBundle, invalid: (kind: 'range' | 'digest') => never): Generator<Buffer> {
  // Table identifiers are fixed internal choices; the identifier and byte range stay parameterized.
  if (!['repository_export_chunk', 'repository_transfer_chunk'].includes(table)) throw new Error('Unknown repository chunk store')
  if (db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND offset<0 LIMIT 1`).get(id)) invalid('range')
  const next = db.prepare(`SELECT offset,substr(data,1,${L.chunk + 1}) AS data,hash FROM ${table} WHERE id=? AND offset>=? ORDER BY offset LIMIT 1`)
  let offset = 0; const digest = createHash('sha256')
  for (;;) {
    const row = next.get(id, offset); if (!row) break
    if (!(row.data instanceof Uint8Array)) invalid('range')
    const bytes = Buffer.from(row.data as Uint8Array)
    if (row.offset !== offset || !bytes.length || bytes.length > L.chunk || offset + bytes.length > bundle.bytes
      || createHash('sha256').update(bytes).digest('hex') !== row.hash) invalid('range')
    offset += bytes.length; digest.update(bytes); yield bytes
  }
  if (offset !== bundle.bytes || digest.digest('hex') !== bundle.sha256) invalid('digest')
}
