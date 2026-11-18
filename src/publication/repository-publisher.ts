/** Two independently journaled external effects: immutable branch creation, then PR creation. */
import { sameOwner, type OwnershipGate, type OwnershipGuard } from '../ownership/gate.ts'
import type { OwnershipStamp } from '../ownership/protocol.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { freshSeal } from '../verification/reviews.ts'
import type { EvidenceSeal } from '../verification/review-model.ts'
import { PublicationError, type PublicationRpc } from './protocol.ts'
import { contentHash, DeliveryRefused } from './github.ts'
import { RepositoryBranch, RepositoryPull, RepositoryDestinationConfig, RepositoryReceipt, RepositoryTransferReceipt, type RepositoryPublication } from './repository-model.ts'
import { RepositoryJournal, repositoryUncertain, type RepositoryIntent } from './repository-journal.ts'
import { RepositoryProcessUnsettled, RepositoryPreparationError } from './repository-git.ts'
import { repositoryPullBody, type RepositoryAdapter, type PreparedRepositoryBranch } from './repository-provider.ts'

interface Host { gate(): OwnershipGate; signal: AbortSignal }
/** Owns the publisher's immutable branch/PR journal and fenced private imports. */
export class RepositoryPublisher {
  readonly destinations = new Map<string, RepositoryDestinationConfig>()
  private readonly working = new Set<string>()
  private readonly importing = new Set<string>()
  private readonly prepared = new Map<string, { value: PreparedRepositoryBranch; owner: OwnershipStamp; signal: AbortSignal }>()
  constructor(readonly journal: RepositoryJournal, destinations: RepositoryDestinationConfig[], private readonly host: Host, private readonly adapter?: RepositoryAdapter) {
    for (const input of destinations) { const value = RepositoryDestinationConfig.parse(input)
      if (this.destinations.has(value.id)) throw new Error('Repository destination IDs must be unique'); this.destinations.set(value.id, value) }
    if (destinations.length && !adapter) throw new Error('Repository destinations require a paired Harness subprocess publication adapter')
  }
  get busy() { return this.working.size > 0 }
  catalog() { return [...this.destinations.values()].map(({ credentialFile: _, ...value }) => ({ ...value, hash: fingerprint(value) })) }
  /** Read-only account/target proof; recovery checks the independent inventory around this call. */
  async checkDestination(id: string, hash: string, signal: AbortSignal): Promise<void> {
    const destination = this.destination(id, hash)
    if (!this.adapter) throw new PublicationError(409, 'configuration_unavailable', 'Repository provider cannot verify its configuration')
    try { await this.adapter.check(destination, signal) }
    catch { throw new PublicationError(409, 'configuration_unavailable', 'Repository account or destination configuration is unavailable') }
  }
  private destination(id: string, hash?: string) {
    const value = this.destinations.get(id)
    if (!value) throw new PublicationError(404, 'repository_destination_missing', 'Repository publication destination not found')
    const { credentialFile: _, ...metadata } = value
    if (hash && fingerprint(metadata) !== hash) throw new PublicationError(409, 'destination_changed', 'Repository destination changed')
    return value
  }
  private evidence(request: RepositoryPublication, value: RepositoryTransferReceipt, evidence: EvidenceSeal[]) {
    const ordered = [...evidence].sort((a, b) => a.selection.runId.localeCompare(b.selection.runId))
    if (fingerprint(ordered.map(seal => seal.selection)) !== fingerprint([...request.checks].sort((a, b) => a.runId.localeCompare(b.runId)))
      || ordered.some(seal => !freshSeal(seal) || fingerprint(seal.artifact) !== fingerprint(value.artifact)
        || seal.repository?.commit !== value.bundle.head || seal.repository.tree !== value.bundle.tree || seal.repository.contentTree !== value.bundle.tree
        || seal.repository.statusHash !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        || fingerprint(seal.execution) !== fingerprint(ordered[0]!.execution)))
      throw new PublicationError(409, 'repository_evidence_changed', 'Repository publication requires fresh checks of the exact clean captured commit and artifact')
  }
  private branchResult(value: unknown, destination: RepositoryDestinationConfig, item: RepositoryIntent) {
    const result = RepositoryBranch.parse(value)
    if (result.repository !== destination.repository || result.repositoryId !== destination.repositoryId
      || result.ref !== item.receipt.branch || result.sha !== item.receipt.bundle.head) throw new Error('Repository branch receipt differs from the original intent')
    return result
  }
  private pullResult(value: unknown, destination: RepositoryDestinationConfig, item: RepositoryIntent, transfer: RepositoryTransferReceipt, observing: boolean) {
    const result = RepositoryPull.parse(value); this.branchResult(result.head, destination, item)
    if (result.repositoryId !== destination.repositoryId || result.base.repository !== destination.repository || result.base.repositoryId !== destination.repositoryId
      || result.base.ref !== destination.baseRef || result.url !== `https://github.com/${destination.repository}/pull/${result.number}`
      || result.title !== item.request.title || result.bodyHash !== contentHash(repositoryPullBody(item.request, transfer))
      || !observing && (result.draft !== item.request.draft || result.state !== 'open' || result.merged)) throw new Error('Repository pull receipt differs from the original intent')
    return result
  }
  async rpc(principal: 'admin' | 'client', request: PublicationRpc, proof?: string): Promise<unknown> {
    switch (request.op) {
      case 'repository.destinations': return this.catalog()
      case 'repository.transfer.get': return this.journal.transfer(request.id)
      case 'repository.receipt.get': return this.journal.get(request.id).receipt
      case 'repository.receipt.cancel': return this.cancel(request.id, proof)
      case 'repository.receipt.resolve': {
        if (principal !== 'admin') throw new PublicationError(403, 'admin_required', 'Independent publication administrator required')
        const item = this.journal.get(request.id)
        if (this.working.has(item.request.id) || item.receipt.phase !== 'unknown') throw new PublicationError(409, 'not_unknown', 'Only an inactive unknown repository step can be reconciled')
        // Terminal reconciliation never grants permission to resend the uncertain step.
        item.receipt.phase = 'reconciled'; item.receipt.reconciliation = { at: timestamp(), note: request.note, evidence: request.evidence }
        delete item.receipt.problem; this.journal.save(item); return item.receipt
      }
      case 'repository.receipt.observe': return this.observe(request.id, request.pullNumber)
      case 'repository.prepare': return this.prepare(request.publication, proof)
      case 'repository.transfer.begin':
      case 'repository.transfer.chunk':
      case 'repository.transfer.finish':
      case 'repository.transfer.cancel': {
        const guard = await this.host.gate().authorize(proof); await this.host.gate().verify(guard); guard.signal.throwIfAborted(); this.host.signal.throwIfAborted()
        if (request.op === 'repository.transfer.begin') return this.journal.begin(request.transfer, guard.stamp)
        const original = this.journal.transfer(request.id)
        if (original.phase === 'receiving' && request.op !== 'repository.transfer.cancel' && !sameOwner(original.ownership, guard.stamp))
          throw new PublicationError(409, 'transfer_owner', 'Resume the original transfer before changing its chunks under a new owner')
        if (request.op === 'repository.transfer.chunk') return this.journal.chunk(request.id, request.offset, request.data, request.hash)
        if (request.op === 'repository.transfer.finish') return this.journal.finish(request.id)
        return this.journal.cancel(request.id, guard.stamp)
      }
      case 'repository.publish': return this.publish(request.publication, request.evidence, proof)
      default: throw new PublicationError(400, 'repository_operation', 'Unknown repository operation')
    }
  }
  private async cancel(id: string, proof?: string) {
    const guard = await this.host.gate().authorize(proof), item = this.journal.get(id)
    if (item.receipt.phase === 'cancelled') return item.receipt
    if (this.working.has(id) || repositoryUncertain(item.receipt.phase) || ['published', 'reconciled'].includes(item.receipt.phase))
      throw new PublicationError(409, 'repository_not_cancellable', 'Only inactive undispatched repository steps can be cancelled')
    this.working.add(id)
    try {
      const cached = this.prepared.get(id); this.prepared.delete(id); await cached?.value.close()
      await this.host.gate().verify(guard); guard.signal.throwIfAborted(); this.host.signal.throwIfAborted()
      item.receipt.ownership = guard.stamp; item.receipt.phase = 'cancelled'; delete item.receipt.problem; this.journal.save(item)
      return item.receipt
    } finally { this.working.delete(id) }
  }
  private async prepare(request: RepositoryPublication, proof?: string) {
    const guard = await this.host.gate().authorize(proof), destination = this.destination(request.destination, request.destinationHash)
    const item = this.journal.accept(request, guard.stamp), id = request.id
    if (this.working.has(id) || repositoryUncertain(item.receipt.phase) || ['published', 'cancelled', 'reconciled'].includes(item.receipt.phase)) return { receipt: item.receipt, prepared: false }
    if (item.receipt.branchResult) return { receipt: item.receipt, prepared: true }
    const cached = this.prepared.get(id)
    if (cached && sameOwner(cached.owner, guard.stamp) && !cached.signal.aborted) return { receipt: item.receipt, prepared: true }
    this.working.add(id)
    try {
      // Delete before awaiting cleanup so concurrent prepares cannot claim the same cache entry.
      for (const [key, entry] of this.prepared) if (key === id || entry.signal.aborted) { this.prepared.delete(key); await entry.value.close() }
      // Reserve capacity before asynchronous imports; completed and in-flight imports share the limit.
      if (this.prepared.size + this.importing.size >= 8) throw new PublicationError(409, 'import_capacity', 'Publisher already has eight pending or prepared repository imports')
      this.importing.add(id)
      await this.host.gate().verify(guard); guard.signal.throwIfAborted(); this.host.signal.throwIfAborted()
      item.receipt.ownership = guard.stamp; item.receipt.phase = 'preparing'; this.journal.save(item)
      const transfer = this.journal.transfer(request.transferId)
      const value = await this.adapter!.prepare(destination, transfer, this.journal.chunks(transfer), item.receipt.branch, AbortSignal.any([guard.signal, this.host.signal]))
      try { await this.host.gate().verify(guard); guard.signal.throwIfAborted(); this.host.signal.throwIfAborted() }
      catch (error) { await value.close(); throw error }
      this.prepared.set(id, { value, owner: guard.stamp, signal: guard.signal }); item.receipt.phase = 'held'; delete item.receipt.problem; this.journal.save(item)
      return { receipt: item.receipt, prepared: true }
    } catch (error) {
      item.receipt.phase = error instanceof RepositoryProcessUnsettled ? 'unknown' : 'held'
      item.receipt.problem = error instanceof RepositoryPreparationError || error instanceof PublicationError && error.code === 'import_capacity'
        ? error.message : 'Repository import did not become ready. Inspect the original receipt and publisher configuration.'; this.journal.save(item)
      return { receipt: item.receipt, prepared: false }
    } finally { this.importing.delete(id); this.working.delete(id) }
  }
  private async observe(id: string, number?: number) {
    const item = this.journal.get(id)
    if (this.working.has(id) || item.receipt.phase !== 'unknown') return item.receipt
    // Unsettled local import processes are not evidence that an external branch/PR was dispatched.
    if (!item.receipt.attempts.some(attempt => attempt.step === item.receipt.step)) return item.receipt
    const destination = this.destination(item.request.destination, item.request.destinationHash), transfer = this.journal.transfer(item.request.transferId)
    this.working.add(id)
    try {
      await this.adapter!.check(destination, this.host.signal)
      if (item.receipt.step === 'branch') {
        const result = await this.adapter!.branch(destination, item.receipt.branch, this.host.signal)
        if (result && result.sha === transfer.bundle.head) {
          item.receipt.branchResult = this.branchResult(result, destination, item); item.receipt.step = 'pull'; item.receipt.phase = 'held'
          item.receipt.problem = 'Original branch confirmed. Review and explicitly continue to create its PR.'; this.journal.save(item)
        }
      } else {
        const result = await this.adapter!.observePull(destination, item.request, transfer, item.receipt.branch, this.host.signal, number)
        if (result) { item.receipt.pullResult = this.pullResult(result, destination, item, transfer, true); item.receipt.phase = 'published'; delete item.receipt.problem; this.journal.save(item) }
      }
      return item.receipt
    } finally { this.working.delete(id) }
  }
  private async boundary(item: RepositoryIntent, transfer: RepositoryTransferReceipt, evidence: EvidenceSeal[], guard: OwnershipGuard, step: 'branch' | 'pull') {
    await this.host.gate().verify(guard); guard.signal.throwIfAborted(); this.host.signal.throwIfAborted()
    this.evidence(item.request, transfer, evidence)
    if (this.journal.get(item.request.id).receipt.phase !== (step === 'branch' ? 'preparing' : 'branch_ready')) throw new Error('Repository publication was held before dispatch')
    if (item.receipt.attempts.length >= 40) throw new PublicationError(409, 'attempt_capacity', 'Repository publication attempt history reached its bound')
    item.receipt.ownership = guard.stamp; item.receipt.step = step
    item.receipt.attempts.push({ step, at: timestamp(), ownership: guard.stamp, evidence: structuredClone(evidence) })
    item.receipt.phase = step === 'branch' ? 'branch_started' : 'pull_started'; this.journal.save(item)
  }
  private async publish(request: RepositoryPublication, evidence: EvidenceSeal[], proof?: string): Promise<RepositoryReceipt> {
    const guard = await this.host.gate().authorize(proof), destination = this.destination(request.destination, request.destinationHash)
    const transfer = this.journal.transfer(request.transferId)
    if (transfer.hash !== request.transferHash || transfer.phase !== 'ready') throw new PublicationError(409, 'transfer_changed', 'The reviewed repository transfer is not available')
    const item = this.journal.accept(request, guard.stamp), id = request.id
    if (this.working.has(id) || ['published', 'unknown', 'reconciled', 'cancelled'].includes(item.receipt.phase)) return item.receipt
    this.evidence(request, transfer, evidence)
    for (const _ of this.journal.chunks(transfer)) { /* verify again before preparing external work */ }
    this.working.add(id)
    let imported: PreparedRepositoryBranch | undefined
    const signal = AbortSignal.any([guard.signal, this.host.signal])
    try {
      item.receipt.ownership = guard.stamp; item.receipt.phase = 'preparing'; delete item.receipt.problem; this.journal.save(item)
      if (!item.receipt.branchResult) {
        const cached = this.prepared.get(id)
        if (!cached || !sameOwner(cached.owner, guard.stamp) || cached.signal.aborted) throw new Error('Prepare the private repository import before requesting fresh approval')
        imported = cached.value; this.prepared.delete(id)
        await this.adapter!.check(destination, signal)
        if (await this.adapter!.branch(destination, item.receipt.branch, signal)) throw new Error('Publication branch already exists')
        await this.boundary(item, transfer, evidence, guard, 'branch')
        item.receipt.branchResult = this.branchResult(await imported.push(signal), destination, item); item.receipt.step = 'pull'
      }
      item.receipt.phase = 'branch_ready'; this.journal.save(item)
      await this.adapter!.check(destination, signal)
      const branch = await this.adapter!.branch(destination, item.receipt.branch, signal)
      if (!branch || fingerprint(branch) !== fingerprint(item.receipt.branchResult)) throw new Error('Published branch changed before PR creation')
      await this.boundary(item, transfer, evidence, guard, 'pull')
      item.receipt.pullResult = this.pullResult(await this.adapter!.createPull(destination, request, transfer, item.receipt.branch, signal), destination, item, transfer, false)
      item.receipt.phase = 'published'; delete item.receipt.problem; this.journal.save(item)
    } catch (error) {
      const uncertain = repositoryUncertain(item.receipt.phase) && !(item.receipt.phase === 'pull_started' && error instanceof DeliveryRefused)
      item.receipt.phase = uncertain || error instanceof RepositoryProcessUnsettled ? 'unknown' : 'held'
      item.receipt.problem = item.receipt.phase === 'unknown' ? 'Repository step outcome is unknown. Observe its original receipt before any replacement.'
        : 'Repository publication held before the next external step. Inspect checks, destination and ownership, then explicitly continue.'
      this.journal.save(item)
    } finally { try { await imported?.close() } finally { this.working.delete(id) } }
    return item.receipt
  }
  async close() { await Promise.allSettled([...this.prepared.values()].map(item => item.value.close())); this.prepared.clear() }
}
