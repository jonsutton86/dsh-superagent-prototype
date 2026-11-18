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
import { CheckSelections, type CheckSelection, type EvidenceSeal } from '../verification/review-model.ts'
import type { VerificationReviews } from '../verification/reviews.ts'
import type { Verification } from '../verification/service.ts'
import { PullObservation, matchesPullEvidence, type PullBinding } from './pull-model.ts'

export const ApprovePublication = z.object({ requestId: PublicationId, revision: z.number().int().positive(), hash: Digest,
  destination: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), destinationHash: Digest, checks: CheckSelections.optional(), pullHash: Digest.optional() }).strict()
export type ApprovePublication = z.infer<typeof ApprovePublication>
export interface PublicationRecord {
  id: string; serviceId: string; artifactId: string; revision: number; hash: string; destination: string; destinationHash: string;
  createdAt: string; updatedAt: string; phase: 'pending' | 'held' | 'unknown' | 'observed'; receipt?: PublicationReceipt; problem?: string
  verification?: { checks: CheckSelection[]; reviewId: string; evidence?: EvidenceSeal[] }
  pull?: PullObservation
}
interface Stored extends PublicationRecord { intent: Publication; fingerprint: string; attempts: OwnershipStamp[];
  approval?: ApprovePublication; destinationSnapshot?: z.infer<typeof DestinationView> }
interface PublicationHost { store: Store; library: Library; ownership?: CoordinatorOwnership; connection?: PublicationConnection; lifetime: AbortSignal; roots(): string[];
  verification?: Verification; reviews?: VerificationReviews;
  preparationProblem?(ticketId: string, assignmentId?: string): string | undefined }
const view = ({ intent: _, fingerprint: __, attempts: ___, approval: ____, destinationSnapshot: _____, ...record }: Stored): PublicationRecord => record

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
    if (!this.client) return { configured: false, items: [] as z.infer<typeof DestinationView>[], artifactEvidence: false, pullReviews: false }
    const identity = PublicationIdentity.parse(await this.client.call({ op: 'identity' }, this.stopped.signal))
    assertOwnership(this.host.ownership, identity.ownership)
    const items = z.array(DestinationView).max(100).parse(await this.client.call({ op: 'destinations' }, this.stopped.signal))
    for (const { hash, ...value } of items) if (fingerprint(value) !== hash) throw new PublicationError(409, 'destination_changed', 'Publication destination digest is invalid')
    return { configured: true, items, artifactEvidence: identity.capabilities?.artifactEvidence === true, pullReviews: identity.capabilities?.pullReviews === true }
  }
  async inspectPull(destination: string, destinationHash: string): Promise<PullObservation> {
    this.authorize(); Digest.parse(destinationHash)
    const result = PullObservation.parse(await this.require().call({ op: 'pull.inspect', destination, destinationHash }, this.stopped.signal))
    this.authorize()
    if (result.destination !== destination || result.destinationHash !== destinationHash || result.hash !== fingerprint(result.binding))
      throw new PublicationError(409, 'pull_changed', 'PR observation does not belong to this destination')
    return result
  }
  list(artifactId?: string) {
    if (artifactId) PublicationId.parse(artifactId)
    const rows = artifactId ? this.host.store.db.prepare("SELECT value FROM workspace_publication WHERE json_extract(value,'$.artifactId')=? ORDER BY rowid DESC LIMIT 100").all(artifactId)
      : this.host.store.db.prepare('SELECT value FROM workspace_publication ORDER BY rowid DESC LIMIT 100').all()
    return { items: rows.map(row => view(JSON.parse(String(row.value)) as Stored)) }
  }
  private eligible(id: string, revision: number, hash: string) {
    const record = this.host.library.read(id)
    const problem = record.provenance.ticketId && this.host.preparationProblem?.(record.provenance.ticketId, record.provenance.assignmentId)
    if (problem) throw new PublicationError(409, 'artifact_changed', problem)
    if (record.kind !== 'artifact' || record.revision !== revision || record.hash !== hash || !record.text || record.archived || record.expired || record.superseded || record.conflicted || record.staleSources.length || record.freshness?.status !== 'current')
      throw new PublicationError(409, 'artifact_changed', 'Select a current, non-conflicting text artifact with a complete source check and review its exact content before publication')
    return record
  }
  private checks(artifactId: string, revision: number, hash: string, selections: readonly CheckSelection[], pull?: PullBinding): void {
    const artifact = this.eligible(artifactId, revision, hash)
    if (artifact.provenance.actor === 'worker' && !selections.length) throw new PublicationError(409, 'checks_required', 'Select successful host checks for this worker artifact before approval')
    if (pull && !selections.length) throw new PublicationError(409, 'checks_required', 'PR reviews require checks of the approved commit')
    if (selections.length && (!this.host.reviews || !this.host.verification)) throw new PublicationError(409, 'checks_unavailable', 'Artifact verification is unavailable')
    for (const selection of selections) {
      const binding = this.host.verification!.approval(selection.runId, selection)
      if (binding.artifact.id !== artifactId || binding.artifact.revision !== revision || binding.artifact.hash !== hash)
        throw new PublicationError(409, 'check_changed', 'Selected host check belongs to another artifact or revision')
      if (pull && !matchesPullEvidence(binding, pull)) throw new PublicationError(409, 'pull_evidence_required', 'Selected check does not match the PR commit and captured Git tree')
    }
  }
  private duplicate(item: Pick<Stored, 'id' | 'artifactId' | 'hash' | 'destinationHash' | 'pull'>): boolean {
    return !!this.host.store.db.prepare(`SELECT id FROM workspace_publication WHERE id!=? AND json_extract(value,'$.artifactId')=?
      AND json_extract(value,'$.hash')=? AND json_extract(value,'$.destinationHash')=?
      AND coalesce(json_extract(value,'$.receipt.phase'),CASE WHEN json_extract(value,'$.phase')='held' THEN 'not_delivered' ELSE 'unknown' END)
        NOT IN ('failed','cancelled','not_delivered')
      AND (json_extract(value,'$.receipt.phase') IS NOT 'sent' OR coalesce(json_extract(value,'$.pull.binding.head.sha'),'')=?)
      LIMIT 1`).get(item.id, item.artifactId, item.hash, item.destinationHash, item.pull?.binding.head.sha ?? '')
  }
  async publish(artifactId: string, input: unknown): Promise<PublicationRecord> {
    const request = ApprovePublication.parse(input), digest = fingerprint({ artifactId, ...request })
    const existing = this.host.store.db.prepare('SELECT value FROM workspace_publication WHERE id=?').get(request.requestId)
    if (existing) {
      const item = JSON.parse(String(existing.value)) as Stored
      if (item.fingerprint !== digest) throw new PublicationError(409, 'intent_changed', 'Publication request ID already belongs to another approval')
      return view(item)
    }
    this.authorize(); this.require(); this.checks(artifactId, request.revision, request.hash, request.checks ?? [])
    const catalog = await this.destinations(), destination = catalog.items.find(value => value.id === request.destination && value.hash === request.destinationHash)
    if (!destination) throw new PublicationError(409, 'destination_changed', 'Publication destination changed; refresh and review it')
    if (request.checks?.length && !catalog.artifactEvidence) throw new PublicationError(409, 'checks_unavailable', 'Update the independent publisher to support artifact evidence before publishing')
    let pull: PullObservation | undefined
    if (destination.kind === 'github-pr-review') {
      if (!catalog.pullReviews || !request.pullHash) throw new PublicationError(409, 'pull_required', 'Inspect the PR head and approve its exact commit before review submission')
      pull = await this.inspectPull(destination.id, destination.hash)
      if (pull.hash !== request.pullHash) throw new PublicationError(409, 'pull_changed', 'PR changed since inspection; review the current head')
      this.checks(artifactId, request.revision, request.hash, request.checks ?? [], pull.binding)
    } else if (request.pullHash) throw new PublicationError(409, 'unexpected_pull', 'This destination does not accept PR review bindings')
    const owner = this.authorize(); this.eligible(artifactId, request.revision, request.hash)
    const content = this.host.library.content(artifactId), text = Buffer.from(content.data, 'base64').toString('utf8')
    if (Buffer.byteLength(text) > destination.maxBytes) throw new PublicationError(413, 'content_too_large', 'Artifact exceeds the destination content limit')
    const at = timestamp(), item: Stored = { id: request.requestId, serviceId: this.require().config.serviceId, artifactId, revision: request.revision,
      hash: request.hash, destination: request.destination, destinationHash: request.destinationHash, createdAt: at, updatedAt: at, phase: 'pending', fingerprint: digest,
      ...(request.checks?.length ? { verification: { checks: request.checks, reviewId: request.requestId } } : {}),
      ...(pull ? { pull } : {}),
      approval: request, destinationSnapshot: destination, attempts: [owner], intent: { id: request.requestId, destination: request.destination, destinationHash: request.destinationHash, hash: request.hash, text,
        ...(pull ? { pull: pull.binding } : {}),
        artifact: { id: artifactId, revision: request.revision, hash: request.hash, basis: 'operator' } } }
    // Recheck after asynchronous discovery: concurrent duplicate approvals must never overwrite the first durable intent.
    const raced = this.host.store.db.prepare('SELECT value FROM workspace_publication WHERE id=?').get(item.id)
    if (raced) {
      const original = JSON.parse(String(raced.value)) as Stored
      if (original.fingerprint !== digest) throw new PublicationError(409, 'intent_changed', 'Concurrent publication approval differs')
      return view(original)
    }
    if (this.duplicate(item)) throw new PublicationError(409, 'already_published', 'This artifact already has a publication for that destination; inspect or recover the original receipt')
    this.save(item); return this.dispatch(item)
  }
  private observeReceipt(item: Stored, input: unknown): PublicationRecord {
    const receipt = PublicationReceipt.parse(input)
    if (receipt.id !== item.id || receipt.destination !== item.destination || receipt.destinationHash !== item.destinationHash || receipt.hash !== item.hash
      || !receipt.artifact || receipt.message || fingerprint(receipt.pull ?? null) !== fingerprint(item.intent.pull ?? null)
      || fingerprint(receipt.artifact) !== fingerprint(item.intent.artifact) || !item.attempts.some(owner => sameOwner(owner, receipt.ownership)))
      throw new PublicationError(409, 'receipt_changed', 'Publication receipt does not belong to this approved content, destination and ownership attempt')
    item.receipt = receipt; item.phase = 'observed'; delete item.problem; this.save(item); return view(item)
  }
  private dispatch(item: Stored): Promise<PublicationRecord> {
    const existing = this.pending.get(item.id); if (existing) return existing
    const operation = (async () => {
      let absent = false, sent = false
      try {
        // Observation comes before current-source gates. An old accepted effect must never be replaced by a fresh send.
        try { return this.observeReceipt(item, await this.require().call({ op: 'receipt.observe', id: item.id }, this.stopped.signal)) }
        catch (error) {
          if (!(error instanceof PublicationError) || error.status !== 404 || error.code !== 'receipt_missing' || item.receipt) throw error
          absent = true
        }
        this.authorize(); this.checks(item.artifactId, item.revision, item.hash, item.verification?.checks ?? [], item.intent.pull)
        if (item.pull && (await this.inspectPull(item.destination, item.destinationHash)).hash !== item.pull.hash)
          throw new PublicationError(409, 'pull_changed', 'PR changed; this approval cannot be retargeted to its new head')
        if (this.duplicate(item)) throw new PublicationError(409, 'already_published', 'Another approval exists for this artifact and destination; observe that receipt')
        if (item.verification) {
          const evidence = await this.host.reviews!.prepare({ id: item.verification.reviewId, purpose: 'publication', target: item.fingerprint, checks: item.verification.checks })
          this.authorize(); this.checks(item.artifactId, item.revision, item.hash, item.verification.checks, item.intent.pull)
          this.host.reviews!.assert(evidence, item.verification.checks)
          item.verification.evidence = evidence; item.intent.artifact = { id: item.artifactId, revision: item.revision, hash: item.hash, basis: 'checks', evidence }
        }
        if (this.duplicate(item)) throw new PublicationError(409, 'already_published', 'Another approval exists for this artifact and destination')
        const owner = this.authorize()
        if (!item.attempts.some(previous => sameOwner(previous, owner))) {
          if (item.attempts.length >= 100) throw new PublicationError(409, 'attempt_limit', 'Publication ownership attempt limit reached')
          item.attempts.push(owner)
        }
        item.phase = 'pending'; delete item.problem; this.save(item); sent = true
        return this.observeReceipt(item, await this.require().call({ op: 'publish', publication: item.intent }, this.stopped.signal))
      } catch (error) {
        item.phase = absent && !sent ? 'held' : 'unknown'
        item.problem = absent && !sent ? String(error).slice(0, 4000) : 'Publication acknowledgement is unavailable; observe this original request before any new dispatch'
        this.save(item); return view(item)
      }
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
    this.authorize(); return this.dispatch(this.item(id))
  }
  async stop(): Promise<void> { this.stopped.abort(); await Promise.allSettled([...this.pending.values()]) }
}
