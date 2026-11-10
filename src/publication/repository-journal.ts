/** Private publisher storage. Each external step is durable before dispatch; restart never repeats it. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { OwnershipStamp } from '../ownership/protocol.ts'
import { sameOwner } from '../ownership/gate.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { PublicationError } from './protocol.ts'
import { REPOSITORY_EXPORT_LIMITS as L } from './repository-export-model.ts'
import { RepositoryTransfer, RepositoryTransferReceipt, RepositoryPublication, RepositoryReceipt, type RepositoryDestination } from './repository-model.ts'

export interface RepositoryIntent { request: RepositoryPublication; receipt: RepositoryReceipt }
export const repositoryUncertain = (phase: RepositoryReceipt['phase']) => ['branch_started', 'pull_started', 'unknown'].includes(phase)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export class RepositoryJournal {
  constructor(readonly db: DatabaseSync, destinations: RepositoryDestination[]) {
    db.exec(`CREATE TABLE IF NOT EXISTS repository_destination (id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_transfer (id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_transfer_chunk (id TEXT NOT NULL,offset INTEGER NOT NULL,data BLOB NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(id,offset));
      CREATE TABLE IF NOT EXISTS repository_publication (id TEXT PRIMARY KEY,value TEXT NOT NULL);`)
    for (const row of db.prepare('SELECT id,value FROM repository_destination').all()) {
      const value = destinations.find(item => item.id === row.id)
      if (!value || fingerprint(value) !== fingerprint(JSON.parse(String(row.value)))) throw new PublicationError(409, 'destination_changed', 'Persisted repository destinations cannot be removed or replaced')
    }
    for (const value of destinations) db.prepare('INSERT OR IGNORE INTO repository_destination VALUES (?,?)').run(value.id, JSON.stringify(value))
    for (const row of db.prepare("SELECT id FROM repository_publication WHERE json_extract(value,'$.receipt.phase') IN ('preparing','branch_started','branch_ready','pull_started')").all()) {
      const item = this.get(String(row.id)); item.receipt.phase = repositoryUncertain(item.receipt.phase) ? 'unknown' : 'held'
      item.receipt.problem = 'Publisher restarted; observe the original step before continuing'; this.save(item)
    }
  }
  private atomic<T>(run: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = run(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error } }
  transfer(id: string): RepositoryTransferReceipt {
    const row = this.db.prepare('SELECT value FROM repository_transfer WHERE id=?').get(id)
    if (!row) throw new PublicationError(404, 'transfer_missing', 'Repository transfer not found')
    return RepositoryTransferReceipt.parse(JSON.parse(String(row.value)))
  }
  private saveTransfer(value: RepositoryTransferReceipt) {
    value.updatedAt = timestamp(); RepositoryTransferReceipt.parse(value)
    this.db.prepare('INSERT INTO repository_transfer VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value))
  }
  begin(request: RepositoryTransfer, ownership: OwnershipStamp): RepositoryTransferReceipt {
    const digest = fingerprint(request), prior = this.db.prepare('SELECT id FROM repository_transfer WHERE id=?').get(request.id)
    if (prior) {
      const value = this.transfer(request.id)
      if (value.hash !== digest) throw new PublicationError(409, 'transfer_changed', 'Transfer ID already belongs to another bundle')
      if (value.phase === 'receiving' && !sameOwner(value.ownership, ownership)) {
        if (value.owners.length >= 100) throw new PublicationError(409, 'transfer_owners', 'Transfer ownership history reached its bound')
        value.ownership = ownership; value.owners.push(ownership); this.saveTransfer(value)
      }
      return value
    }
    const capacity = this.db.prepare("SELECT count(*) AS history,coalesce(sum(CASE WHEN json_extract(value,'$.phase')='cancelled' THEN 0 ELSE json_extract(value,'$.bundle.bytes') END),0) AS bytes FROM repository_transfer").get()!
    if (Number(capacity.history) >= L.history || Number(capacity.bytes) + request.bundle.bytes > L.totalBytes) throw new PublicationError(409, 'transfer_capacity', 'Publisher bundle storage capacity reached')
    const at = timestamp(), value: RepositoryTransferReceipt = { ...request, hash: digest, ownership, owners: [ownership], phase: 'receiving', received: 0, createdAt: at, updatedAt: at }
    this.saveTransfer(value); return value
  }
  chunk(id: string, offset: number, data: string, digest: string): RepositoryTransferReceipt {
    const value = this.transfer(id), bytes = Buffer.from(data, 'base64')
    if (value.phase === 'cancelled' || bytes.toString('base64') !== data || !bytes.length || bytes.length > L.chunk || hash(bytes) !== digest || offset + bytes.length > value.bundle.bytes)
      throw new PublicationError(409, 'chunk_changed', 'Repository chunk differs from its declared range or hash')
    if (offset < value.received) {
      const row = this.db.prepare('SELECT hash,length(data) AS bytes FROM repository_transfer_chunk WHERE id=? AND offset=?').get(id, offset)
      if (!row || row.hash !== digest || row.bytes !== bytes.length) throw new PublicationError(409, 'chunk_changed', 'Original transfer range cannot be replaced')
      return value
    }
    if (offset !== value.received || value.phase !== 'receiving') throw new PublicationError(409, 'chunk_order', 'Continue at the original received offset')
    this.atomic(() => { this.db.prepare('INSERT INTO repository_transfer_chunk VALUES (?,?,?,?)').run(id, offset, bytes, digest); value.received += bytes.length; this.saveTransfer(value) })
    return value
  }
  *chunks(value: RepositoryTransferReceipt): Generator<Buffer> {
    if (value.phase === 'cancelled' || value.received !== value.bundle.bytes) throw new PublicationError(409, 'transfer_incomplete', 'Repository transfer is incomplete')
    const next = this.db.prepare(`SELECT offset,substr(data,1,${L.chunk + 1}) AS data,hash FROM repository_transfer_chunk WHERE id=? AND offset>=? ORDER BY offset LIMIT 1`)
    if (this.db.prepare('SELECT 1 FROM repository_transfer_chunk WHERE id=? AND offset<0 LIMIT 1').get(value.id)) throw new PublicationError(409, 'bundle_changed', 'Repository transfer bytes changed')
    let offset = 0; const digest = createHash('sha256')
    for (;;) {
      const row = next.get(value.id, offset); if (!row) break
      const bytes = Buffer.from(row.data as Uint8Array)
      if (row.offset !== offset || !bytes.length || bytes.length > L.chunk || offset + bytes.length > value.bundle.bytes || hash(bytes) !== row.hash)
        throw new PublicationError(409, 'bundle_changed', 'Repository transfer bytes changed')
      offset += bytes.length; digest.update(bytes); yield bytes
    }
    if (offset !== value.bundle.bytes || digest.digest('hex') !== value.bundle.sha256) throw new PublicationError(409, 'bundle_changed', 'Repository transfer digest changed')
  }
  finish(id: string) { const value = this.transfer(id); for (const _ of this.chunks(value)) { /* stream verification */ } if (value.phase !== 'ready') { value.phase = 'ready'; this.saveTransfer(value) } return value }
  cancel(id: string, ownership: OwnershipStamp) {
    const value = this.transfer(id)
    if (value.phase === 'cancelled') return value
    if (this.db.prepare("SELECT 1 FROM repository_publication WHERE json_extract(value,'$.request.transferId')=? LIMIT 1").get(id))
      throw new PublicationError(409, 'transfer_in_use', 'Published or attempted bundles remain attached to their original receipts')
    if (!sameOwner(value.ownership, ownership)) {
      if (value.owners.length >= 100) throw new PublicationError(409, 'transfer_owners', 'Transfer ownership history reached its bound')
      value.ownership = ownership; value.owners.push(ownership)
    }
    this.atomic(() => { value.phase = 'cancelled'; this.saveTransfer(value); this.db.prepare('DELETE FROM repository_transfer_chunk WHERE id=?').run(id) }); return value
  }
  get(id: string): RepositoryIntent {
    const row = this.db.prepare('SELECT value FROM repository_publication WHERE id=?').get(id)
    if (!row) throw new PublicationError(404, 'repository_receipt_missing', 'Repository publication receipt not found')
    const value = JSON.parse(String(row.value)); return { request: RepositoryPublication.parse(value.request), receipt: RepositoryReceipt.parse(value.receipt) }
  }
  accept(request: RepositoryPublication, ownership: OwnershipStamp): RepositoryIntent {
    if (this.db.prepare('SELECT id FROM repository_publication WHERE id=?').get(request.id)) {
      const item = this.get(request.id)
      if (fingerprint(item.request) !== fingerprint(request)) throw new PublicationError(409, 'intent_changed', 'Repository publication ID belongs to another approval')
      return item
    }
    if (Number(this.db.prepare('SELECT count(*) AS n FROM repository_publication').get()!.n) >= 10000) throw new PublicationError(409, 'repository_capacity', 'Repository publication journal capacity reached')
    const transfer = this.transfer(request.transferId)
    if (transfer.hash !== request.transferHash || transfer.phase !== 'ready') throw new PublicationError(409, 'transfer_changed', 'Approve the original completed repository transfer')
    const at = timestamp(), item: RepositoryIntent = { request, receipt: { id: request.id, requestHash: fingerprint(request), destination: request.destination,
      destinationHash: request.destinationHash, transferId: request.transferId, transferHash: request.transferHash, artifact: transfer.artifact, bundle: transfer.bundle,
      branch: 'agentic/' + request.id, ownership, phase: 'held', step: 'branch', createdAt: at, updatedAt: at, attempts: [] } }
    this.db.prepare('INSERT INTO repository_publication VALUES (?,?)').run(request.id, JSON.stringify(item)); return item
  }
  save(item: RepositoryIntent) { item.receipt.updatedAt = timestamp(); RepositoryReceipt.parse(item.receipt); this.db.prepare('UPDATE repository_publication SET value=? WHERE id=?').run(JSON.stringify(item), item.request.id) }
  unsettled() { return Number(this.db.prepare("SELECT count(*) AS n FROM repository_publication WHERE json_extract(value,'$.receipt.phase') IN ('branch_started','pull_started','unknown')").get()!.n) }
  fence(keep?: OwnershipStamp) {
    for (const row of this.db.prepare("SELECT id FROM repository_publication WHERE json_extract(value,'$.receipt.phase') IN ('preparing','branch_ready')").all()) {
      const item = this.get(String(row.id)); if (keep && sameOwner(keep, item.receipt.ownership)) continue
      item.receipt.phase = 'held'; item.receipt.problem = 'Ownership changed before the next repository step'; this.save(item)
    }
  }
}
