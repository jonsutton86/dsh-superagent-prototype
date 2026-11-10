/** Coordinator-owned repository intents; preparation is private, every external continuation needs fresh approval. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Store } from '../app/store.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { sameOwner } from '../ownership/gate.ts'
import { assertOwnership, assertOwnershipCredential } from '../ownership/runtime.ts'
import type { CoordinatorOwnership } from '../ownership/lease.ts'
import type { VerificationReviews } from '../verification/reviews.ts'
import type { RepositoryExports } from './repository-exports.ts'
import { PublicationClient, type PublicationConnection } from './client.ts'
import { PublicationError, PublicationId, PublicationIdentity } from './protocol.ts'
import { RepositoryDestinationView, RepositoryReceipt } from './repository-model.ts'
import { PrepareRepositoryPublication, ApproveRepositoryPublication, WorkspaceRepositoryPublication, type RepositoryPublicationView } from './repository-runtime-model.ts'
import { observeRepositoryTransfer, observeRepositoryReceipt } from './repository-observation.ts'

interface Host { store: Store; exports: RepositoryExports; reviews: VerificationReviews; ownership?: CoordinatorOwnership;
  connection?: PublicationConnection; lifetime: AbortSignal; roots(): string[]; authorize(): void }
const view = (item: WorkspaceRepositoryPublication): RepositoryPublicationView => ({ id: item.id, exportId: item.exportId, destination: item.destination,
  publication: item.publication, transfer: item.transfer, received: item.transferReceipt?.received ?? 0,
  phase: item.phase, cancelRequested: item.cancelRequested, createdAt: item.createdAt, updatedAt: item.updatedAt,
  ...(item.problem ? { problem: item.problem } : {}), ...(item.receipt ? { receipt: item.receipt } : {}),
  approvals: item.approvals.map(({ id, at, dispatched }) => ({ id, at, dispatched })) })
const missing = (error: unknown, code: string) => error instanceof PublicationError && error.status === 404 && error.code === code
const settled = (item: WorkspaceRepositoryPublication) => ['published', 'cancelled', 'reconciled'].includes(item.phase)

/** Retain original repository intent and review IDs through independent publisher response loss and restart. */
export class RepositoryPublications {
  private readonly client?: PublicationClient
  private readonly pending = new Map<string, Promise<RepositoryPublicationView>>()
  private readonly stopped = new AbortController()
  constructor(private readonly host: Host) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_repository_publication (id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_repository_publication_export ON workspace_repository_publication(json_extract(value,'$.exportId'));`)
    if (host.connection) {
      if (!host.ownership) throw new Error('Repository publication requires coordinator ownership')
      assertOwnershipCredential({ ...host.ownership.config, credentialFile: host.connection.credentialFile }, host.roots())
      this.client = new PublicationClient(host.connection, host.ownership)
    }
    for (const row of host.store.db.prepare('SELECT value FROM workspace_repository_publication').all()) {
      const item = WorkspaceRepositoryPublication.parse(JSON.parse(String(row.value)))
      if (!host.connection || item.serviceId !== host.connection.serviceId) throw new Error('Retained repository publication service cannot be removed or replaced')
      if (['ready', 'preparing'].includes(item.phase)) { item.phase = 'held'; item.problem = 'Preparation is private and must be confirmed again after restart. Original operation IDs are retained.'; this.save(item) }
    }
  }
  private require() {
    if (!this.client) throw new PublicationError(409, 'not_configured', 'Configure an independent repository publication service')
    return this.client
  }
  private authorize(cancelling = false) {
    this.host.lifetime.throwIfAborted(); this.stopped.signal.throwIfAborted(); if (!cancelling) this.host.authorize(); this.host.ownership?.proof()
    const owner = this.host.ownership?.status().owner
    if (!owner) throw new PublicationError(409, 'ownership_required', 'Repository publication requires live coordinator ownership')
    return owner
  }
  private own(item: WorkspaceRepositoryPublication, cancelling = false) {
    const owner = this.authorize(cancelling)
    if (!item.owners.some(prior => sameOwner(prior, owner))) {
      if (item.owners.length >= 100) throw new PublicationError(409, 'owner_capacity', 'Repository ownership history reached its bound')
      item.owners.push(owner)
    }
    this.save(item); return owner
  }
  private item(id: string) {
    PublicationId.parse(id)
    const row = this.host.store.db.prepare('SELECT value FROM workspace_repository_publication WHERE id=?').get(id)
    if (!row) throw new PublicationError(404, 'repository_publication_missing', 'Workspace repository publication not found')
    return WorkspaceRepositoryPublication.parse(JSON.parse(String(row.value)))
  }
  private save(item: WorkspaceRepositoryPublication) {
    item.updatedAt = timestamp(); WorkspaceRepositoryPublication.parse(item)
    this.host.store.db.prepare('INSERT INTO workspace_repository_publication VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(item.id, JSON.stringify(item))
  }
  get(id: string) { return view(this.item(id)) }
  list(exportId: string) {
    PublicationId.parse(exportId)
    return { items: this.host.store.db.prepare("SELECT value FROM workspace_repository_publication WHERE json_extract(value,'$.exportId')=? ORDER BY rowid DESC LIMIT 100")
      .all(exportId).map(row => view(WorkspaceRepositoryPublication.parse(JSON.parse(String(row.value))))) }
  }
  async destinations() {
    if (!this.client) return { configured: false, items: [] as z.infer<typeof RepositoryDestinationView>[] }
    const identity = PublicationIdentity.parse(await this.client.call({ op: 'identity' }, this.stopped.signal))
    assertOwnership(this.host.ownership, identity.ownership)
    const items = z.array(RepositoryDestinationView).max(100).parse(await this.client.call({ op: 'repository.destinations' }, this.stopped.signal))
    for (const { hash, ...value } of items) if (fingerprint(value) !== hash) throw new PublicationError(409, 'destination_changed', 'Repository destination digest is invalid')
    return { configured: true, items }
  }
  private current(item: WorkspaceRepositoryPublication) {
    const value = this.host.exports.publication(item.exportId, true)
    if (value.fingerprint !== item.exportFingerprint || fingerprint({ id: item.id, artifact: value.artifact, source: value.source, bundle: value.bundle }) !== fingerprint(item.transfer)
      || fingerprint(value.checks) !== fingerprint(item.publication.checks)) throw new PublicationError(409, 'export_changed', 'Retained repository export authority changed')
  }
  private duplicate(item: WorkspaceRepositoryPublication) {
    const rows = this.host.store.db.prepare("SELECT value FROM workspace_repository_publication WHERE id!=? AND json_extract(value,'$.publication.destinationHash')=? AND json_extract(value,'$.transfer.bundle.head')=?")
      .all(item.id, item.publication.destinationHash, item.transfer.bundle.head)
    if (rows.some(row => { const prior = WorkspaceRepositoryPublication.parse(JSON.parse(String(row.value)))
      return prior.phase !== 'cancelled' || !!prior.receipt?.attempts.length }))
      throw new PublicationError(409, 'repository_duplicate', 'This commit already has a publication for this destination; inspect its original receipt')
  }
  private work(id: string, operation: () => Promise<RepositoryPublicationView>) {
    const active = this.pending.get(id); if (active) return active
    // Start on the next microtask so the slot is reserved before any asynchronous work.
    const promise = Promise.resolve().then(operation).finally(() => this.pending.delete(id))
    this.pending.set(id, promise); return promise
  }
  async prepare(exportId: string, input: unknown): Promise<RepositoryPublicationView> {
    const request = PrepareRepositoryPublication.parse(input), digest = fingerprint({ exportId, request })
    const existing = this.host.store.db.prepare('SELECT value FROM workspace_repository_publication WHERE id=?').get(request.requestId)
    if (existing) {
      if (this.item(request.requestId).fingerprint !== digest) throw new PublicationError(409, 'intent_changed', 'Repository publication ID belongs to another intent')
      return this.retry(request.requestId)
    }
    this.authorize(); this.require()
    const destination = (await this.destinations()).items.find(item => item.id === request.destination && item.hash === request.destinationHash)
    if (!destination) throw new PublicationError(409, 'destination_changed', 'Refresh and review the exact repository destination')
    const owner = this.authorize(), source = this.host.exports.publication(exportId, true), at = timestamp()
    const transfer = { id: request.requestId, artifact: source.artifact, source: source.source, bundle: source.bundle }
    const item: WorkspaceRepositoryPublication = { id: request.requestId, serviceId: this.require().config.serviceId, exportId, exportFingerprint: source.fingerprint,
      fingerprint: digest, request, destination, transfer, publication: { id: request.requestId, destination: request.destination, destinationHash: request.destinationHash,
        transferId: transfer.id, transferHash: fingerprint(transfer), title: request.title, body: request.body, draft: request.draft, checks: source.checks },
      owners: [owner], approvals: [], phase: 'preparing', cancelRequested: false, createdAt: at, updatedAt: at }
    // Recheck after discovery, before persisting the first intent or touching the independent publisher.
    if (this.host.store.db.prepare('SELECT 1 FROM workspace_repository_publication WHERE id=?').get(item.id)) return this.prepare(exportId, request)
    this.duplicate(item)
    if (Number(this.host.store.db.prepare('SELECT count(*) AS n FROM workspace_repository_publication').get()!.n) >= 10000)
      throw new PublicationError(409, 'repository_capacity', 'Workspace repository publication history reached its bound')
    this.save(item); return this.retry(item.id)
  }
  private transfer(item: WorkspaceRepositoryPublication, input: unknown) {
    item.transferReceipt = observeRepositoryTransfer(item, input); this.save(item); return item.transferReceipt
  }
  private receipt(item: WorkspaceRepositoryPublication, input: unknown) {
    item.receipt = observeRepositoryReceipt(item, input)
    const phase = item.receipt.phase
    item.phase = ['branch_started', 'pull_started', 'unknown'].includes(phase) ? 'unknown'
      : phase === 'published' || phase === 'cancelled' || phase === 'reconciled' ? phase : 'held'
    item.problem = item.receipt.problem; this.save(item); return item.receipt
  }
  private async observe(item: WorkspaceRepositoryPublication) {
    try { this.transfer(item, await this.require().call({ op: 'repository.transfer.get', id: item.transfer.id }, this.stopped.signal)) }
    catch (error) { if (!missing(error, 'transfer_missing') || item.transferReceipt) throw error }
    try { this.receipt(item, await this.require().call({ op: 'repository.receipt.observe', id: item.id }, this.stopped.signal)); return true }
    catch (error) { if (!missing(error, 'repository_receipt_missing') || item.receipt || item.approvals.some(approval => approval.dispatched)) throw error; return false }
  }
  private async prepareOriginal(item: WorkspaceRepositoryPublication) {
    await this.observe(item)
    if (settled(item) || item.phase === 'unknown' || item.cancelRequested) return false
    this.current(item); this.duplicate(item); this.own(item)
    item.phase = 'preparing'; delete item.problem; this.save(item)
    let transfer = this.transfer(item, await this.require().call({ op: 'repository.transfer.begin', transfer: item.transfer }, this.stopped.signal))
    if (transfer.phase === 'cancelled') throw new PublicationError(409, 'transfer_cancelled', 'Original repository transfer was cancelled')
    let offset = 0
    for (const data of this.host.exports.download(item.exportId).chunks) {
      const end = offset + data.length
      if (offset < transfer.received && end > transfer.received) throw new PublicationError(409, 'transfer_changed', 'Publisher offset is outside an original chunk boundary')
      if (offset >= transfer.received) {
        this.own(item)
        transfer = this.transfer(item, await this.require().call({ op: 'repository.transfer.chunk', id: item.transfer.id, offset,
          data: data.toString('base64'), hash: createHash('sha256').update(data).digest('hex') }, this.stopped.signal))
        if (transfer.received !== end) throw new PublicationError(409, 'transfer_changed', 'Publisher did not acknowledge the original chunk boundary')
      }
      offset = end
    }
    this.own(item)
    this.transfer(item, await this.require().call({ op: 'repository.transfer.finish', id: item.transfer.id }, this.stopped.signal))
    this.current(item); this.own(item)
    const result = z.object({ receipt: RepositoryReceipt, prepared: z.boolean() }).strict().parse(
      await this.require().call({ op: 'repository.prepare', publication: item.publication }, this.stopped.signal))
    this.receipt(item, result.receipt)
    if (result.prepared && result.receipt.phase === 'held') { this.current(item); this.authorize(); item.phase = 'ready'; delete item.problem; this.save(item); return true }
    return false
  }
  retry(id: string) {
    this.authorize()
    return this.work(id, async () => {
      const item = this.item(id)
      try { await this.prepareOriginal(item) }
      catch { if (!settled(item) && item.phase !== 'unknown') item.phase = 'held'
        item.problem = 'Private preparation is unconfirmed. Inspect and retry this original intent; no replacement operation is created.'; this.save(item) }
      return view(item)
    })
  }
  publish(id: string, input: unknown) {
    const request = ApproveRepositoryPublication.parse(input); this.authorize()
    return this.work(id, async () => {
      const item = this.item(id)
      const original = item.approvals.find(approval => approval.id === request.requestId)
      // Lost response recovery only observes an approval that already crossed its dispatch boundary.
      if (original?.dispatched) return this.refreshOriginal(item)
      if (settled(item) || item.cancelRequested || item.phase === 'unknown') return view(item)
      if (!original && item.approvals.length >= 40) throw new PublicationError(409, 'approval_capacity', 'Repository approval history reached its bound')
      const approval = original ?? { id: request.requestId, at: timestamp(), owner: this.own(item), dispatched: false }
      if (!original) { item.approvals.push(approval); this.save(item) }
      try {
        if (!await this.prepareOriginal(item)) return view(item)
        approval.owner = this.own(item); this.save(item)
        const evidence = await this.host.reviews.prepare({ id: approval.id, purpose: 'publication', target: fingerprint(item.publication), checks: item.publication.checks })
        this.current(item); this.host.reviews.assert(evidence, item.publication.checks)
        const owner = this.own(item)
        if (!sameOwner(owner, approval.owner)) throw new PublicationError(409, 'owner_changed', 'Approval ownership changed')
        approval.evidence = evidence; approval.dispatched = true; item.phase = 'unknown'; this.save(item)
        this.receipt(item, await this.require().call({ op: 'repository.publish', publication: item.publication, evidence }, this.stopped.signal))
      } catch {
        item.phase = approval.dispatched ? 'unknown' : item.phase === 'unknown' ? 'unknown' : 'held'
        item.problem = approval.dispatched ? 'Publication response is unconfirmed. Observe this original approval; it will never be sent again automatically.'
          : 'Approval is held. Inspect the original source checks, private preparation and ownership before continuing.'; this.save(item)
      }
      return view(item)
    })
  }
  private async refreshOriginal(item: WorkspaceRepositoryPublication) {
    try { await this.observe(item) }
    catch { item.problem = 'Original publisher observations are unavailable or inconsistent. Retained IDs and uncertainty remain unchanged.'; this.save(item) }
    return view(item)
  }
  refresh(id: string) { return this.work(id, () => this.refreshOriginal(this.item(id))) }
  async cancel(id: string) {
    this.authorize(true)
    // Cancellation must not disappear into an already-running preparation/publish promise.
    // Earlier waiters may queue another operation when the first settles. Reserve cancellation
    // only after the entire live queue drains, with no asynchronous gap before work() takes the slot.
    while (this.pending.has(id)) await this.pending.get(id)!.catch(() => {})
    this.authorize(true)
    return this.work(id, async () => {
      const item = this.item(id)
      if (settled(item)) return view(item)
      item.cancelRequested = true; this.own(item, true)
      try {
        const exists = await this.observe(item)
        if (item.phase === 'unknown' || settled(item)) return view(item)
        this.own(item, true)
        if (exists) this.receipt(item, await this.require().call({ op: 'repository.receipt.cancel', id }, this.stopped.signal))
        else {
          if (item.transferReceipt) this.transfer(item, await this.require().call({ op: 'repository.transfer.cancel', id: item.transfer.id }, this.stopped.signal))
          item.phase = 'cancelled'; delete item.problem; this.save(item)
        }
      } catch { item.problem = 'Cancellation is unconfirmed. Observe the original operation; any existing branch is retained.'; this.save(item) }
      return view(item)
    })
  }
  async stop() { this.stopped.abort(); await Promise.allSettled([...this.pending.values()]) }
}
