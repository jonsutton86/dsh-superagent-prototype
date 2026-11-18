/** Immutable operator check versions; authority toggles govern new/active runs without rewriting historical evidence. */
import { randomUUID } from 'node:crypto'
import type { Store } from '../app/store.ts'
import { WorkspaceError } from '../workspace/model.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { CheckId, ConfigureCheck, CreateCheck, SaveCheck, type CheckRecord, type CheckVersion } from './contracts.ts'

/** Durable immutable command versions and operator authority, with exact-request recovery and bounded metadata. */
export class CheckDefinitions {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS verification_check (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verification_check_version (id TEXT, version INTEGER, value TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS verification_check_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL, request TEXT NOT NULL);`)
  }
  get(id: string): CheckRecord {
    CheckId.parse(id)
    const row = this.store.db.prepare('SELECT value FROM verification_check WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Verification check not found')
    return JSON.parse(String(row.value))
  }
  version(id: string, version: number): CheckVersion {
    CheckId.parse(id)
    const row = this.store.db.prepare('SELECT value FROM verification_check_version WHERE id=? AND version=?').get(id, version)
    if (!row) throw new WorkspaceError(404, 'Verification check version not found')
    const value = JSON.parse(String(row.value)) as CheckVersion
    if (value.id !== id || value.version !== version || value.hash !== fingerprint({ id, version, definition: value.definition }))
      throw new WorkspaceError(409, 'Check version integrity changed')
    return value
  }
  list(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new WorkspaceError(400, 'Invalid check page')
    const rows = this.store.db.prepare('SELECT value FROM verification_check ORDER BY rowid DESC LIMIT 31 OFFSET ?').all(offset)
    return { items: rows.slice(0, 30).map(row => JSON.parse(String(row.value)) as CheckRecord), nextOffset: rows.length > 30 ? offset + 30 : null }
  }
  private command(requestId: string, input: unknown, operation: () => CheckRecord): CheckRecord {
    const hash = fingerprint(input)
    return this.store.atomic(() => {
      const prior = this.store.db.prepare('SELECT fingerprint,value FROM verification_check_command WHERE id=?').get(requestId)
      if (prior) {
        if (prior.fingerprint !== hash) throw new WorkspaceError(409, 'Check request ID belongs to a different operation')
        return JSON.parse(String(prior.value)) as CheckRecord
      }
      const record = operation()
      this.store.db.prepare('INSERT INTO verification_check VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record))
      this.store.db.prepare('INSERT INTO verification_check_command VALUES (?,?,?,?)').run(requestId, hash, JSON.stringify(record), JSON.stringify(input))
      const bytes = this.store.db.prepare(`SELECT (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM verification_check)
        + (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM verification_check_version)
        + (SELECT coalesce(sum(length(CAST(value AS BLOB))+length(CAST(request AS BLOB))),0) FROM verification_check_command) AS n`).get()!.n
      if (Number(bytes) > 64 * 1024 * 1024) throw new WorkspaceError(409, 'Check registry metadata capacity reached')
      return record
    })
  }
  private saveVersion(id: string, version: number, definition: CheckRecord['definition']): CheckVersion {
    if (version > 1000) throw new WorkspaceError(409, 'Check version capacity reached; create a new check')
    const value = { id, version, definition, hash: fingerprint({ id, version, definition }), createdAt: timestamp() }
    this.store.db.prepare('INSERT INTO verification_check_version VALUES (?,?,?)').run(id, version, JSON.stringify(value))
    return value
  }
  create(input: unknown): CheckRecord {
    const request = CreateCheck.parse(input)
    return this.command(request.requestId, { op: 'create', ...request }, () => {
      if (Number(this.store.db.prepare('SELECT count(*) AS n FROM verification_check').get()!.n) >= 1000) throw new WorkspaceError(409, 'Check registry capacity reached')
      const version = this.saveVersion(randomUUID(), 1, request.definition)
      return { ...version, revision: 1, enabled: request.enabled, workers: request.workers, updatedAt: version.createdAt }
    })
  }
  update(id: string, input: unknown): CheckRecord {
    const request = SaveCheck.parse(input)
    return this.command(request.requestId, { op: 'update', id, ...request }, () => {
      const previous = this.get(id)
      if (previous.revision !== request.revision) throw new WorkspaceError(409, 'Check changed; refresh before saving')
      return { ...previous, ...this.saveVersion(id, previous.version + 1, request.definition), revision: previous.revision + 1, updatedAt: timestamp() }
    })
  }
  configure(id: string, input: unknown): CheckRecord {
    const request = ConfigureCheck.parse(input)
    return this.command(request.requestId, { op: 'configure', id, ...request }, () => {
      const previous = this.get(id)
      if (previous.revision !== request.revision) throw new WorkspaceError(409, 'Check changed; refresh before changing authority')
      return { ...previous, revision: previous.revision + 1, enabled: request.enabled, workers: request.workers, updatedAt: timestamp() }
    })
  }
}
