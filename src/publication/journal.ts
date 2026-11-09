import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { privateCredential, privateDirectory, privateFile } from '../environments/endpoint-files.ts'
import { existsSync } from 'node:fs'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { sameOwner } from '../ownership/gate.ts'
import type { OwnershipStamp } from '../ownership/protocol.ts'
import { Publication, PublicationError, PublicationReceipt, type Destination } from './protocol.ts'

interface Stored { request: Publication; receipt: PublicationReceipt }
/** Independent single-writer publication journal. A restarted send becomes unknown, never a fresh send. */
export class PublicationJournal {
  readonly db: DatabaseSync
  readonly id: string
  private readonly release: () => void
  private readonly tokens: { admin: string; client: string }
  private closed = false
  constructor(directory: string, compromised: (error: Error) => void) {
    const root = privateDirectory(directory)
    this.release = lockSync(root, { stale: 30_000, onCompromised: compromised })
    let opened: DatabaseSync | undefined
    try {
      const token = (name: string) => {
        const path = join(root, name + '.token')
        if (!existsSync(path)) privateFile(path, randomBytes(32).toString('base64url'))
        return privateCredential(path)
      }
      this.tokens = { admin: token('admin'), client: token('client') }
      this.db = opened = new DatabaseSync(join(root, 'publication.sqlite'))
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS publication_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS publication_destination (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS publication_receipt (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL);`)
      if (!this.meta('id')) this.meta('id', randomUUID())
      this.id = this.meta('id')!
      for (const item of this.unsettled()) {
        item.receipt.phase = item.receipt.phase === 'accepted' ? 'cancelled' : 'unknown'
        item.receipt.problem = 'Publication service restarted before delivery was confirmed'; this.save(item)
      }
    } catch (error) { opened?.close(); this.release(); throw error }
  }
  meta(key: string): string | undefined
  meta(key: string, value: string): void
  meta(key: string, value?: string): string | undefined | void {
    if (value !== undefined) { this.db.prepare('INSERT INTO publication_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); return }
    const row = this.db.prepare('SELECT value FROM publication_meta WHERE key=?').get(key); return row ? String(row.value) : undefined
  }
  authenticate(header?: string): 'admin' | 'client' {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const hash = (value: string) => createHash('sha256').update(value).digest()
    for (const role of ['admin', 'client'] as const) if (timingSafeEqual(hash(token), hash(this.tokens[role]))) return role
    throw new PublicationError(401, 'unauthorized', 'Publication credential required')
  }
  bind(ownership: object, destinations: Destination[]): void {
    const binding = JSON.stringify(ownership), saved = this.meta('ownership')
    if (saved && saved !== binding) throw new PublicationError(409, 'ownership_changed', 'Publication ownership binding cannot be replaced')
    const existing = this.db.prepare('SELECT id,value FROM publication_destination').all()
    for (const row of existing) {
      const current = destinations.find(value => value.id === row.id)
      if (!current || fingerprint(current) !== fingerprint(JSON.parse(String(row.value))))
        throw new PublicationError(409, 'destination_changed', 'Persisted publication destinations cannot be removed or replaced; use a new destination identity')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.meta('ownership', binding)
      for (const destination of destinations) this.db.prepare('INSERT OR IGNORE INTO publication_destination VALUES (?,?)').run(destination.id, JSON.stringify(destination))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  get(id: string): Stored | undefined {
    const row = this.db.prepare('SELECT value FROM publication_receipt WHERE id=?').get(id)
    if (!row) return
    const item = JSON.parse(String(row.value)) as Stored
    return { request: Publication.parse(item.request), receipt: PublicationReceipt.parse(item.receipt) }
  }
  accept(request: Publication, ownership: OwnershipStamp): Stored {
    const old = this.get(request.id)
    if (old) {
      if (fingerprint(old.request) !== fingerprint(request)) throw new PublicationError(409, 'intent_changed', 'Publication ID already belongs to different content or destination')
      return old
    }
    if (Number(this.db.prepare('SELECT count(*) AS n FROM publication_receipt').get()!.n) >= 50_000)
      throw new PublicationError(409, 'capacity', 'Publication journal capacity reached')
    const at = timestamp(), item: Stored = { request, receipt: { id: request.id, destination: request.destination, destinationHash: request.destinationHash,
      ...(request.artifact ? { artifact: request.artifact } : { message: request.message }), hash: request.hash, bytes: Buffer.byteLength(request.text), ownership, phase: 'accepted', createdAt: at, updatedAt: at } }
    this.db.prepare('INSERT INTO publication_receipt VALUES (?,?,?)').run(request.id, fingerprint(request), JSON.stringify(item))
    return item
  }
  save(item: Stored): void {
    item.receipt.updatedAt = timestamp(); PublicationReceipt.parse(item.receipt)
    this.db.prepare('UPDATE publication_receipt SET value=? WHERE id=?').run(JSON.stringify(item), item.receipt.id)
  }
  list(offset = 0) {
    const items = this.db.prepare('SELECT value FROM publication_receipt ORDER BY rowid DESC LIMIT 101 OFFSET ?').all(offset)
      .map(row => PublicationReceipt.parse(JSON.parse(String(row.value)).receipt))
    return { items: items.slice(0, 100), nextOffset: items.length > 100 ? offset + 100 : null }
  }
  unsettled(): Stored[] {
    return this.db.prepare("SELECT id FROM publication_receipt WHERE json_extract(value,'$.receipt.phase') IN ('accepted','started','unknown')").all()
      .map(row => this.get(String(row.id))!)
  }
  fence(keep?: OwnershipStamp): void {
    if (this.closed) return
    for (const item of this.unsettled()) if (item.receipt.phase === 'accepted' && !(keep && sameOwner(keep, item.receipt.ownership))) {
      item.receipt.phase = 'cancelled'; item.receipt.problem = 'Ownership changed before publication dispatch'; this.save(item)
    }
  }
  close(): void { if (this.closed) return; this.closed = true; try { this.db.close() } finally { this.release() } }
}
