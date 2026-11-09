import { fingerprint, timestamp } from '../remote/journal.ts'
import { OwnershipGate, sameOwner, type OwnershipFloor, type ResourceOwnershipConfig } from '../ownership/gate.ts'
import { PublicationJournal } from './journal.ts'
import { Destination, DestinationConfig, PublicationError, PublicationRpc, type PublicationIdentity, type PublicationReceipt } from './protocol.ts'
import { contentHash, DeliveryRefused, type PublicationAdapter } from './github.ts'
import { PublicationProviders } from './providers.ts'

export interface PublicationServiceConfig { stateDir: string; ownership: ResourceOwnershipConfig; destinations: DestinationConfig[] }
/** Independently fenced publication host. Unknown outcomes block ownership handoff until actual observation or administrator reconciliation. */
export class PublicationService {
  readonly journal: PublicationJournal
  readonly gate: OwnershipGate
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
    return { protocol: 1, id: this.journal.id, ownership: { authorityId, coordinatorId, resourceId } }
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
      case 'destinations': return [...this.destinations.values()].map(({ credentialFile: _, ...value }) => ({ ...value, hash: fingerprint(value) }))
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
          const exists = this.journal.get(publication.id), item = this.journal.accept(publication, guard.stamp)
          if (exists) return item.receipt
          this.working.add(item.receipt.id)
          try {
            const signal = AbortSignal.any([guard.signal, this.lifetime.signal])
            const prepared = await this.adapter.prepare(destination, publication, signal)
            await this.gate.verify(guard); signal.throwIfAborted()
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
