import { fingerprint, timestamp } from '../remote/journal.ts'
import { OwnershipGate, sameOwner, type OwnershipFloor, type ResourceOwnershipConfig } from '../ownership/gate.ts'
import { PublicationJournal } from './journal.ts'
import { ConversationPage, Destination, DestinationConfig, ExternalReceipt, Publication, PublicationError, PublicationRpc, type PublicationIdentity, PublicationReceipt,
  PublicationConfigurationObservation } from './protocol.ts'
import { contentHash, DeliveryRefused, type PublicationAdapter } from './github.ts'
import { PublicationProviders } from './providers.ts'
import { ResourceInventory } from '../ownership/inventory.ts'
import { freshSeal } from '../verification/reviews.ts'
import { PullBinding, PullObservation, matchesPullEvidence } from './pull-model.ts'

export interface PublicationServiceConfig { stateDir: string; ownership: ResourceOwnershipConfig; destinations: DestinationConfig[] }
/** Independently fenced publication host. Unknown outcomes block ownership handoff until actual observation or administrator reconciliation. */
export class PublicationService {
  readonly journal: PublicationJournal
  readonly gate: OwnershipGate
  private readonly inventory: ResourceInventory
  private readonly destinations = new Map<string, DestinationConfig>()
  private readonly lifetime = new AbortController()
  private calls = 0
  private readonly working = new Set<string>()
  private readonly pending = new Set<Promise<unknown>>()
  private stopping?: Promise<void>
  constructor(readonly config: PublicationServiceConfig, private readonly adapter: PublicationAdapter = new PublicationProviders()) {
    this.journal = new PublicationJournal(config.stateDir, error => this.lifetime.abort(error))
    try {
      for (const input of config.destinations) {
        const value = DestinationConfig.parse(input)
        if (this.destinations.has(value.id)) throw new Error('Publication destination IDs must be unique')
        this.destinations.set(value.id, value)
      }
      if (!this.destinations.size || this.destinations.size > 100) throw new Error('Configure 1–100 publication destinations')
      const { authorityId, coordinatorId, resourceId } = config.ownership
      this.journal.bind({ authorityId, coordinatorId, resourceId }, [...this.destinations.values()].map(({ credentialFile: _, ...value }) => Destination.parse(value)))
      this.inventory = new ResourceInventory(this.journal.db, [
        { kind: 'destination', table: 'publication_destination', project: value => ({ kind: 'destination', id: value.id,
          requestHash: fingerprint(value), phase: 'configured', settled: true }) },
        { kind: 'publication', table: 'publication_receipt', project: ({ request, receipt }) => ({ kind: 'publication', id: receipt.id,
          requestHash: fingerprint(Publication.parse(request)), phase: receipt.phase, settled: !['accepted', 'started', 'unknown'].includes(receipt.phase),
          ownership: receipt.ownership, resultHash: fingerprint(receipt.external ? ExternalReceipt.parse(receipt.external) : null) }),
          observe: ({ receipt }) => PublicationReceipt.parse(receipt) },
      ])
      this.gate = new OwnershipGate(config.ownership, {
        floor: () => { const value = this.journal.meta('floor'); return value ? JSON.parse(value) as OwnershipFloor : undefined },
        remember: value => this.journal.meta('floor', JSON.stringify(value)), fence: keep => this.journal.fence(keep),
        quiescent: keep => !this.lifetime.signal.aborted && this.calls === 0 && !this.working.size && !this.journal.unsettled().some(item =>
          !(keep && item.receipt.phase === 'accepted' && sameOwner(keep, item.receipt.ownership))),
      })
    } catch (error) { this.journal.close(); throw error }
  }
  start(report: (error: unknown) => void = () => {}): void { this.gate.start(report) }
  identity(): PublicationIdentity {
    const { authorityId, coordinatorId, resourceId } = this.config.ownership
    return { protocol: 1, id: this.journal.id, capabilities: { artifactEvidence: true, pullReviews: true }, ownership: { authorityId, coordinatorId, resourceId } }
  }
  private destination(id: string) {
    const value = this.destinations.get(id)
    if (!value) throw new PublicationError(404, 'destination_missing', 'Publication destination not found')
    return value
  }
  private item(id: string) {
    const value = this.journal.get(id)
    if (!value) throw new PublicationError(404, 'receipt_missing', 'Publication receipt not found')
    return value
  }
  rpc(principal: 'admin' | 'client', input: unknown, proof?: string): Promise<unknown> {
    this.lifetime.signal.throwIfAborted()
    const pending = this.dispatch(principal, PublicationRpc.parse(input), proof)
    this.pending.add(pending); void pending.finally(() => this.pending.delete(pending)).catch(() => {})
    return pending
  }
  private async dispatch(principal: 'admin' | 'client', request: PublicationRpc, proof?: string): Promise<unknown> {
    switch (request.op) {
      case 'identity': return this.identity()
      case 'recovery.destination': {
        if (principal !== 'client') throw new PublicationError(403, 'client_required', 'The coordinator publication credential is required')
        const destination = this.destination(request.destination), { credentialFile: _, ...metadata } = destination
        if (fingerprint(metadata) !== request.destinationHash) throw new PublicationError(409, 'destination_changed', 'Publication destination changed')
        const validate = () => {
          this.lifetime.signal.throwIfAborted(); this.inventory.assertRevision(request.revision)
          if (this.calls || this.working.size || this.journal.unsettled().length) throw new PublicationError(409, 'recovery_busy', 'Publication service must be quiescent for recovery')
        }
        validate()
        if (!this.adapter.check) throw new PublicationError(409, 'configuration_unavailable', 'Publication provider cannot verify its configuration')
        try { await this.adapter.check(destination, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)])) }
        catch { throw new PublicationError(409, 'configuration_unavailable', 'Publication account or destination configuration is unavailable') }
        validate()
        const { id, ownership } = this.identity()
        return PublicationConfigurationObservation.parse({ revision: request.revision, identity: { id, kind: 'publication', ...ownership },
          destination: request.destination, destinationHash: request.destinationHash, account: true, target: true, quiescent: true })
      }
      case 'recovery.inventory':
      case 'recovery.receipt': {
        if (principal !== 'admin') throw new PublicationError(403, 'admin_required', 'Independent publication administrator required')
        const { id, ownership } = this.identity()
        const identity = { id, kind: 'publication' as const, ...ownership }, quiescent = this.calls === 0 && !this.working.size && !this.journal.unsettled().length
        return request.op === 'recovery.inventory' ? this.inventory.page(request, identity, quiescent) : this.inventory.receipt(request, identity, quiescent)
      }
      case 'destinations': return [...this.destinations.values()].map(({ credentialFile: _, ...value }) => ({ ...value, hash: fingerprint(value) }))
      case 'pull.inspect': {
        const guard = await this.gate.authorize(proof), destination = this.destination(request.destination), { credentialFile: _, ...metadata } = destination
        if (fingerprint(metadata) !== request.destinationHash) throw new PublicationError(409, 'destination_changed', 'PR review destination changed')
        if (destination.kind !== 'github-pr-review' || !this.adapter.inspectPull) throw new PublicationError(409, 'pull_unavailable', 'This destination cannot inspect PR heads')
        this.calls++
        try {
          const binding = PullBinding.parse(await this.adapter.inspectPull(destination, AbortSignal.any([guard.signal, this.lifetime.signal])))
          await this.gate.verify(guard)
          return PullObservation.parse({ destination: request.destination, destinationHash: request.destinationHash, binding, hash: fingerprint(binding), observedAt: timestamp() })
        } finally { this.calls-- }
      }
      case 'conversation.read': {
        const guard = await this.gate.authorize(proof), destination = this.destination(request.destination), { credentialFile: _, ...metadata } = destination
        if (fingerprint(metadata) !== request.destinationHash) throw new PublicationError(409, 'destination_changed', 'Conversation destination changed')
        if (!this.adapter.read) throw new PublicationError(409, 'reader_unavailable', 'This provider cannot read conversations')
        this.calls++
        try {
          const page = ConversationPage.parse(await this.adapter.read(destination, request, AbortSignal.any([guard.signal, this.lifetime.signal])))
          await this.gate.verify(guard)
          return page
        } finally { this.calls-- }
      }
      case 'receipt.get': return this.item(request.id).receipt
      case 'receipt.list': return this.journal.list(request.offset)
      case 'receipt.resolve': {
        if (principal !== 'admin') throw new PublicationError(403, 'admin_required', 'Independent publication administrator required')
        const item = this.item(request.id)
        if (this.working.has(request.id) || item.receipt.phase !== 'unknown') throw new PublicationError(409, 'not_unknown', 'Only an inactive unknown publication can be reconciled')
        item.receipt.phase = 'not_delivered'; item.receipt.reconciliation = { at: timestamp(), note: request.note, evidence: request.evidence }
        delete item.receipt.problem; this.journal.save(item); return item.receipt
      }
      case 'receipt.observe': {
        const item = this.item(request.id)
        if (this.working.has(request.id)) return item.receipt
        if (item.receipt.phase !== 'unknown') return item.receipt
        this.working.add(request.id)
        try {
          const external = await this.adapter.observe(this.destination(item.request.destination), item.request, this.lifetime.signal, request.externalId)
          if (external) { item.receipt.phase = 'sent'; item.receipt.external = external; delete item.receipt.problem; this.journal.save(item) }
          return item.receipt
        } finally { this.working.delete(request.id) }
      }
      case 'publish': {
        const guard = await this.gate.authorize(proof)
        this.calls++
        try {
          const publication = request.publication, destination = this.destination(publication.destination), { credentialFile: _, ...publicDestination } = destination
          if (fingerprint(publicDestination) !== publication.destinationHash || contentHash(publication.text) !== publication.hash || publication.artifact && publication.artifact.hash !== publication.hash)
            throw new PublicationError(409, 'content_changed', 'Publication content or destination differs from its approved digest')
          if (Buffer.byteLength(publication.text) > destination.maxBytes) throw new PublicationError(413, 'content_too_large', 'Artifact exceeds this destination content limit')
          // An accepted original receipt remains observable even after its freshness window expires.
          const exists = this.journal.get(publication.id)
          if (exists) return this.journal.accept(publication, guard.stamp).receipt
          const assertEvidence = () => {
            const artifact = publication.artifact
            if (destination.kind === 'github-pr-review') {
              if (!publication.pull || !artifact || artifact.basis !== 'checks' || !artifact.evidence?.length
                || artifact.evidence.some(seal => !matchesPullEvidence(seal, publication.pull!)))
                throw new PublicationError(409, 'pull_evidence_required', 'PR reviews require host checks of the exact approved commit and captured Git tree')
            } else if (publication.pull) throw new PublicationError(409, 'unexpected_pull', 'This destination does not accept PR review bindings')
            if (!artifact?.evidence) return
            if (new Set(artifact.evidence.map(seal => seal.selection.runId)).size !== artifact.evidence.length || artifact.evidence.some(seal =>
              seal.artifact.id !== artifact.id || seal.artifact.revision !== artifact.revision || seal.artifact.hash !== artifact.hash || !freshSeal(seal)))
              throw new PublicationError(409, 'evidence_changed', 'Artifact check evidence is mismatched or expired before dispatch')
          }
          assertEvidence()
          const item = this.journal.accept(publication, guard.stamp)
          this.working.add(item.receipt.id)
          try {
            const signal = AbortSignal.any([guard.signal, this.lifetime.signal])
            const prepared = await this.adapter.prepare(destination, publication, signal)
            await prepared.verify?.(signal)
            await this.gate.verify(guard); signal.throwIfAborted()
            assertEvidence()
            if (this.item(item.receipt.id).receipt.phase !== 'accepted') throw new Error('Publication was fenced before dispatch')
            item.receipt.phase = 'started'; this.journal.save(item)
            item.receipt.external = await prepared.send(signal)
            item.receipt.phase = 'sent'; delete item.receipt.problem
          } catch (error) {
            const started = item.receipt.phase === 'started'
            item.receipt.phase = started ? error instanceof DeliveryRefused ? 'failed' : 'unknown' : guard.signal.aborted ? 'cancelled' : 'failed'
            item.receipt.problem = started ? item.receipt.phase === 'failed' ? 'Provider explicitly refused publication' : 'Provider outcome is unknown; observe the original receipt before any replacement'
              : 'Publication stopped before external dispatch; inspect destination configuration and ownership'
          } finally { this.journal.save(item); this.working.delete(item.receipt.id) }
          return item.receipt
        } finally { this.calls-- }
      }
    }
  }
  close(): Promise<void> {
    return this.stopping ??= (async () => { this.lifetime.abort(); this.gate.close(); await Promise.allSettled([...this.pending]); this.journal.close() })()
  }
}
