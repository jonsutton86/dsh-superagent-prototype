import { z } from 'zod'
import type { Store } from '../app/store.ts'
import type { Library } from '../workspace/library.ts'
import { KV } from '../kv.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { sameOwner } from '../ownership/gate.ts'
import { assertOwnership, assertOwnershipCredential } from '../ownership/runtime.ts'
import type { CoordinatorOwnership } from '../ownership/lease.ts'
import type { OwnershipStamp } from '../ownership/protocol.ts'
import { PublicationClient, type PublicationConnection } from './client.ts'
import { DestinationView, Digest, PublicationError, PublicationId, PublicationIdentity, PublicationReceipt, type Publication } from './protocol.ts'

export const ApprovePublication = z.object({ requestId: PublicationId, revision: z.number().int().positive(), hash: Digest,
  destination: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), destinationHash: Digest }).strict()
export type ApprovePublication = z.infer<typeof ApprovePublication>
export interface PublicationRecord {
  id: string; serviceId: string; artifactId: string; revision: number; hash: string; destination: string; destinationHash: string;
  createdAt: string; updatedAt: string; phase: 'pending' | 'unknown' | 'observed'; receipt?: PublicationReceipt; problem?: string
}
interface Stored extends PublicationRecord { intent: Publication; fingerprint: string; attempts: OwnershipStamp[] }
interface PublicationHost { store: Store; library: Library; ownership?: CoordinatorOwnership; connection?: PublicationConnection; lifetime: AbortSignal; roots(): string[] }
const view = ({ intent: _, fingerprint: __, attempts: ___, ...record }: Stored): PublicationRecord => record

/** Operator-approved immutable artifact delivery with original-ID transport recovery and independent service receipts. */
export class Publications {
  private readonly client?: PublicationClient
  private readonly pending = new Map<string, Promise<PublicationRecord>>()
  private readonly stopped = new AbortController()
  constructor(private readonly host: PublicationHost) {
    const { store, connection, ownership } = host
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_publication (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_publication_artifact ON workspace_publication(json_extract(value,'$.artifactId'),json_extract(value,'$.destinationHash'));`)
    const saved = store.get(KV.runtime.publication)
    if (saved && (!connection || saved.serviceId !== connection.serviceId)) throw new Error('Persisted publication service binding cannot be removed or replaced')
    if (connection) {
      if (!ownership) throw new Error('Publication service requires coordinator ownership')
      assertOwnershipCredential({ ...ownership.config, credentialFile: connection.credentialFile }, host.roots())
      this.client = new PublicationClient(connection, ownership)
      store.set(KV.runtime.publication, { serviceId: connection.serviceId, credentialFile: connection.credentialFile })
    }
  }
  private require(): PublicationClient {
    if (!this.client) throw new PublicationError(409, 'not_configured', 'Configure an independent publication service on this coordinator')
    return this.client
  }
  private authorize(): OwnershipStamp {
    this.host.lifetime.throwIfAborted(); this.stopped.signal.throwIfAborted(); this.host.ownership?.proof()
    const owner = this.host.ownership?.status().owner
    if (!owner) throw new PublicationError(409, 'ownership_required', 'Publication requires live coordinator ownership')
    return owner
  }
  private item(id: string): Stored {
    PublicationId.parse(id)
    const row = this.host.store.db.prepare('SELECT value FROM workspace_publication WHERE id=?').get(id)
    if (!row) throw new PublicationError(404, 'publication_missing', 'Publication not found')
    return JSON.parse(String(row.value)) as Stored
  }
  private save(item: Stored): void {
    item.updatedAt = timestamp()
    this.host.store.db.prepare('INSERT INTO workspace_publication VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(item.id, JSON.stringify(item))
  }
  async destinations() {
    if (!this.client) return { configured: false, items: [] as z.infer<typeof DestinationView>[] }
    const identity = PublicationIdentity.parse(await this.client.call({ op: 'identity' }, this.stopped.signal))
    assertOwnership(this.host.ownership, identity.ownership)
    const items = z.array(DestinationView).max(100).parse(await this.client.call({ op: 'destinations' }, this.stopped.signal))
    for (const { hash, ...value } of items) if (fingerprint(value) !== hash) throw new PublicationError(409, 'destination_changed', 'Publication destination digest is invalid')
    return { configured: true, items }
  }
  list(artifactId?: string) {
    if (artifactId) PublicationId.parse(artifactId)
    const rows = artifactId ? this.host.store.db.prepare("SELECT value FROM workspace_publication WHERE json_extract(value,'$.artifactId')=? ORDER BY rowid DESC LIMIT 100").all(artifactId)
      : this.host.store.db.prepare('SELECT value FROM workspace_publication ORDER BY rowid DESC LIMIT 100').all()
    return { items: rows.map(row => view(JSON.parse(String(row.value)) as Stored)) }
  }
  private eligible(id: string, revision: number, hash: string) {
    const record = this.host.library.read(id)
    if (record.kind !== 'artifact' || record.revision !== revision || record.hash !== hash || !record.text || record.archived || record.expired || record.superseded || record.conflicted || record.staleSources.length)
      throw new PublicationError(409, 'artifact_changed', 'Select a current, non-conflicting text artifact and review its exact content before publication')
    return record
  }
  async publish(artifactId: string, input: unknown): Promise<PublicationRecord> {
    const request = ApprovePublication.parse(input), digest = fingerprint({ artifactId, ...request })
    const existing = this.host.store.db.prepare('SELECT value FROM workspace_publication WHERE id=?').get(request.requestId)
    if (existing) {
      const item = JSON.parse(String(existing.value)) as Stored
      if (item.fingerprint !== digest) throw new PublicationError(409, 'intent_changed', 'Publication request ID already belongs to another approval')
      return view(item)
    }
    this.authorize(); this.require(); this.eligible(artifactId, request.revision, request.hash)
    const catalog = await this.destinations(), destination = catalog.items.find(value => value.id === request.destination && value.hash === request.destinationHash)
    if (!destination) throw new PublicationError(409, 'destination_changed', 'Publication destination changed; refresh and review it')
    const owner = this.authorize(); this.eligible(artifactId, request.revision, request.hash)
    const content = this.host.library.content(artifactId), text = Buffer.from(content.data, 'base64').toString('utf8')
    if (Buffer.byteLength(text) > destination.maxBytes) throw new PublicationError(413, 'content_too_large', 'Artifact exceeds the destination content limit')
    const at = timestamp(), item: Stored = { id: request.requestId, serviceId: this.require().config.serviceId, artifactId, revision: request.revision,
      hash: request.hash, destination: request.destination, destinationHash: request.destinationHash, createdAt: at, updatedAt: at, phase: 'pending', fingerprint: digest,
      attempts: [owner], intent: { id: request.requestId, destination: request.destination, destinationHash: request.destinationHash, hash: request.hash, text,
        artifact: { id: artifactId, revision: request.revision, hash: request.hash } } }
    // Recheck after asynchronous discovery: concurrent duplicate approvals must never overwrite the first durable intent.
    const raced = this.host.store.db.prepare('SELECT value FROM workspace_publication WHERE id=?').get(item.id)
    if (raced) {
      const original = JSON.parse(String(raced.value)) as Stored
      if (original.fingerprint !== digest) throw new PublicationError(409, 'intent_changed', 'Concurrent publication approval differs')
      return view(original)
    }
    const duplicate = this.host.store.db.prepare(`SELECT id FROM workspace_publication WHERE json_extract(value,'$.artifactId')=?
      AND json_extract(value,'$.hash')=? AND json_extract(value,'$.destinationHash')=?
      AND coalesce(json_extract(value,'$.receipt.phase'),'unknown') NOT IN ('failed','cancelled','not_delivered') LIMIT 1`).get(artifactId, request.hash, request.destinationHash)
    if (duplicate) throw new PublicationError(409, 'already_published', 'This artifact already has a publication for that destination; inspect or recover the original receipt')
    this.save(item); return this.dispatch(item)
  }
  private observeReceipt(item: Stored, input: unknown): PublicationRecord {
    const receipt = PublicationReceipt.parse(input)
    if (receipt.id !== item.id || receipt.destination !== item.destination || receipt.destinationHash !== item.destinationHash || receipt.hash !== item.hash
      || fingerprint(receipt.artifact) !== fingerprint(item.intent.artifact) || !item.attempts.some(owner => sameOwner(owner, receipt.ownership)))
      throw new PublicationError(409, 'receipt_changed', 'Publication receipt does not belong to this approved content, destination and ownership attempt')
    item.receipt = receipt; item.phase = 'observed'; delete item.problem; this.save(item); return view(item)
  }
  private dispatch(item: Stored): Promise<PublicationRecord> {
    const existing = this.pending.get(item.id); if (existing) return existing
    const operation = (async () => {
      try { return this.observeReceipt(item, await this.require().call({ op: 'publish', publication: item.intent }, this.stopped.signal)) }
      catch { item.phase = 'unknown'; item.problem = 'Publication acknowledgement is unavailable; observe or retry this original request, never create a replacement'; this.save(item); return view(item) }
    })().finally(() => this.pending.delete(item.id))
    this.pending.set(item.id, operation); return operation
  }
  /** Only receipt observation is allowed after local ownership loss. Provider absence never proves non-delivery. */
  refresh(id: string): Promise<PublicationRecord> {
    if (this.pending.has(id)) return this.pending.get(id)!
    const item = this.item(id)
    const operation = (async () => {
      try { return this.observeReceipt(item, await this.require().call({ op: 'receipt.observe', id }, this.stopped.signal)) }
      catch { item.problem = 'Publication observation is unavailable; the original intent is retained'; this.save(item); return view(item) }
    })().finally(() => this.pending.delete(id))
    this.pending.set(id, operation); return operation
  }
  /** An explicit retry preserves the exact payload and ID. The independent journal prevents a second provider POST. */
  async retry(id: string): Promise<PublicationRecord> {
    const owner = this.authorize(), item = this.item(id)
    this.eligible(item.artifactId, item.revision, item.hash)
    if (!item.attempts.some(previous => sameOwner(previous, owner))) {
      if (item.attempts.length >= 100) throw new PublicationError(409, 'attempt_limit', 'Publication ownership attempt limit reached')
      item.attempts.push(owner); this.save(item)
    }
    return this.dispatch(item)
  }
  async stop(): Promise<void> { this.stopped.abort(); await Promise.allSettled([...this.pending.values()]) }
}
