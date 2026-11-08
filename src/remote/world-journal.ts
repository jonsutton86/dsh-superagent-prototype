import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { fingerprint } from './journal.ts'
import { RemoteError, type RemoteGrant, type RevocationReceipt } from './protocol.ts'

export interface WorldRecord {
  endpointId: string; grant: RemoteGrant; phase: 'active' | 'revoking' | 'revoked'
  revocation?: { requestId: string; reason: string; receipt?: RevocationReceipt }
}

/** Authority identity excludes a renewable lease and revision, but includes the root, owner, permissions and generation. */
export const worldBinding = (endpointId: string, grant: RemoteGrant): string => fingerprint({ endpointId, id: grant.id, epoch: grant.epoch,
  owner: grant.owner, workspace: grant.workspace, root: grant.root, rootIdentity: grant.rootIdentity, operations: [...grant.operations].sort() })

/** Single-writer coordinator journal: immutable world binding and a revocation intent committed before network I/O. */
export class WorldJournal {
  private readonly db: DatabaseSync
  private readonly release: () => void
  private closed = false
  constructor(directory: string, compromised: (error: Error) => void) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700)
    this.release = lockSync(directory, { stale: 30_000, onCompromised: compromised })
    let opened: DatabaseSync | undefined
    try {
      this.db = opened = new DatabaseSync(join(directory, 'world.sqlite'))
      chmodSync(join(directory, 'world.sqlite'), 0o600)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS execution_world (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`)
    } catch (error) { opened?.close(); this.release(); throw error }
  }
  read(): WorldRecord | undefined {
    const row = this.db.prepare('SELECT value FROM execution_world WHERE id=1').get()
    return row ? JSON.parse(String(row.value)) as WorldRecord : undefined
  }
  bind(endpointId: string, grant: RemoteGrant): WorldRecord {
    const existing = this.read()
    if (existing) {
      if (worldBinding(existing.endpointId, existing.grant) !== worldBinding(endpointId, grant))
        throw new RemoteError(409, 'world_changed', 'This state directory belongs to another execution world; existing sessions must not inherit a replacement grant')
      return existing
    }
    const record: WorldRecord = { endpointId, grant, phase: 'active' }
    this.write(record)
    return record
  }
  revoke(requestId: string, reason: string): WorldRecord {
    const record = this.read()!
    if (record.revocation) {
      if (record.revocation.requestId !== requestId || record.revocation.reason !== reason)
        throw new RemoteError(409, 'revocation_pending', 'Replay the saved revocation request; this execution world cannot be re-enabled')
      return record
    }
    record.phase = 'revoking'; record.revocation = { requestId, reason }; this.write(record)
    return record
  }
  acknowledge(receipt: RevocationReceipt): void {
    const record = this.read()!
    if (!record.revocation || receipt.grantId !== record.grant.id || receipt.epoch !== record.grant.epoch)
      throw new Error('Revocation receipt does not match this execution world')
    record.phase = 'revoked'; record.revocation.receipt = receipt; this.write(record)
  }
  private write(record: WorldRecord): void {
    this.db.prepare('INSERT INTO execution_world VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(record))
  }
  close(): void { if (this.closed) return; this.closed = true; this.db.close(); this.release() }
}
