/** Retained coordinator authority and independent repository observations. No upload, approval, or provider write. */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { KV } from '../kv.ts'
import { sameOwner } from '../ownership/gate.ts'
import type { InventoryItem, InventoryReceipt, ReceiptRequest } from '../ownership/inventory.ts'
import { fingerprint } from '../remote/journal.ts'
import { RepositoryExportRecord } from '../publication/repository-export-model.ts'
import { WorkspaceRepositoryPublication } from '../publication/repository-runtime-model.ts'
import { observeRepositoryTransfer, observeRepositoryReceipt } from '../publication/repository-observation.ts'
import { repositoryUncertain } from '../publication/repository-journal.ts'
import { EvidenceSeal, ReviewRequest } from '../verification/review-model.ts'
import type { StoredCheckRun } from '../verification/contracts.ts'
import { matchesRecordedSeal } from '../verification/evidence.ts'
import { StateReader } from './reader.ts'

export interface RepositoryPublicationState {
  repositories: number; repositoryApprovals: number; repositoryTransfers: number; repositoryReceipts: number; repositoryUnresolved: number
}
const reviewSchema = z.looseObject({ ...ReviewRequest.shape,
  attempts: z.array(z.looseObject({ evidence: z.array(EvidenceSeal).max(32).optional() })).max(20) })
export function repositoryPublicationExpected(value: WorkspaceRepositoryPublication) {
  const dispatched = value.approvals.some(approval => approval.dispatched)
  return [
    { kind: 'repository-destination' as const, id: value.destination.id, requestHash: value.destination.hash },
    { kind: 'repository-transfer' as const, id: value.transfer.id, requestHash: fingerprint(value.transfer), attempts: value.owners,
      resultHash: value.transfer.bundle.sha256, absent: !value.transferReceipt && !value.receipt && !dispatched,
      ...(value.transferReceipt?.phase === 'cancelled' ? { phase: 'cancelled' } : {}) },
    { kind: 'repository-publication' as const, id: value.id, requestHash: fingerprint(value.publication), attempts: value.owners,
      absent: !value.receipt && !dispatched,
      ...(value.receipt && ['published', 'cancelled', 'reconciled'].includes(value.receipt.phase)
        ? { phase: value.receipt.phase, resultHash: fingerprint({ branch: value.receipt.branchResult ?? null, pull: value.receipt.pullResult ?? null }) } : {}) },
  ] as const satisfies readonly (Pick<InventoryItem, 'kind' | 'id' | 'requestHash'> & Record<string, unknown>)[]
}

/** verifyRepositoryExports must run first so source checks and bundle bytes already have a verified graph. */
export async function verifyRepositoryPublications(r: StateReader, settled: boolean): Promise<RepositoryPublicationState> {
  const result: RepositoryPublicationState = { repositories: 0, repositoryApprovals: 0, repositoryTransfers: 0, repositoryReceipts: 0, repositoryUnresolved: 0 }
  const setting = (key: string) => {
    const row = r.db.prepare('SELECT value FROM kv WHERE key=?').get(key)
    return row ? r.json(row.value, z.record(z.string(), z.unknown()), 'repository_publication_configuration') : undefined
  }
  const ownership = setting(KV.runtime.ownership), publisher = setting(KV.runtime.publication)
  for (const row of r.rows('workspace_repository_publication')) {
    await r.step(); const value = r.json(row.value, WorkspaceRepositoryPublication, 'repository_publication')
    if (++result.repositories > 10000) r.fail('limit', 'repository_publication_history')
    const source = r.parse(RepositoryExportRecord, r.core('repository_export', value.exportId), 'repository_publication_export')
    if (source.phase !== 'ready' || !source.bundle || !source.evidence) r.fail('reference', 'repository_publication_export')
    r.same([row.id, value.id, value.serviceId, value.exportFingerprint, value.fingerprint],
      [value.id, value.request.requestId, publisher?.serviceId, source.fingerprint, fingerprint({ exportId: value.exportId, request: value.request })], 'repository_publication_identity')
    const { hash, ...destination } = value.destination
    r.same(hash, fingerprint(destination), 'repository_publication_destination')
    r.same(value.transfer, { id: value.id, artifact: { id: source.artifactId, revision: source.request.revision, hash: source.request.hash },
      source: source.source.url, bundle: source.bundle }, 'repository_publication_transfer')
    const { requestId: _, ...request } = value.request
    r.same(value.publication, { ...request, id: value.id, transferId: value.transfer.id, transferHash: fingerprint(value.transfer), checks: source.request.checks }, 'repository_publication_request')
    r.same([value.publication.destination, value.publication.destinationHash], [value.destination.id, hash], 'repository_publication_destination_binding')
    const owners = new Set<string>()
    for (const owner of value.owners) {
      await r.step()
      if (!ownership || owner.coordinatorId !== ownership.coordinatorId || owners.has(fingerprint(owner))) r.fail('authority', 'repository_publication_owner')
      owners.add(fingerprint(owner))
    }
    const approvals = new Set<string>()
    for (const approval of value.approvals) {
      await r.step(); result.repositoryApprovals++
      if (approvals.has(approval.id) || !value.owners.some(owner => sameOwner(owner, approval.owner))) r.fail('authority', 'repository_publication_approval')
      approvals.add(approval.id)
      if (!approval.evidence) { if (approval.dispatched) r.fail('reference', 'repository_publication_dispatched_evidence'); continue }
      const review = r.parse(reviewSchema, r.core('verification_review', approval.id), 'repository_publication_review')
      r.same([review.id, review.purpose, review.target, review.checks],
        [approval.id, 'publication', fingerprint(value.publication), value.publication.checks], 'repository_publication_review')
      r.same(approval.evidence.map(seal => seal.selection), value.publication.checks, 'repository_publication_selections')
      if (!review.attempts.some(attempt => fingerprint(attempt.evidence ?? null) === fingerprint(approval.evidence))) r.fail('reference', 'repository_publication_review_attempt')
      for (const seal of approval.evidence) {
        await r.step()
        r.same([seal.artifact, seal.repository], [value.transfer.artifact, { commit: source.head, tree: source.tree, contentTree: source.tree,
          statusHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }], 'repository_publication_seal_binding')
        if (!matchesRecordedSeal(seal, r.core<StoredCheckRun>('verification_run', seal.selection.runId), r.core<StoredCheckRun>('verification_run', seal.capture.id)))
          r.fail('authority', 'repository_publication_seal')
      }
    }
    try {
      if (value.transferReceipt) { observeRepositoryTransfer(value, value.transferReceipt); result.repositoryTransfers++ }
      if (value.receipt) { observeRepositoryReceipt(value, value.receipt); result.repositoryReceipts++ }
    } catch { r.fail('authority', 'repository_publication_observation') }
    if (value.receipt && value.transferReceipt?.phase !== 'ready') r.fail('reference', 'repository_publication_observed_transfer')
    const unresolved = value.phase === 'unknown' || value.phase === 'preparing'
      || value.receipt && (repositoryUncertain(value.receipt.phase) || value.receipt.phase === 'preparing')
    if (unresolved) { result.repositoryUnresolved++; if (settled) r.fail('unsettled', 'repository_publication_receipt') }
    if (['published', 'reconciled'].includes(value.phase) && value.receipt?.phase !== value.phase
      || value.phase === 'cancelled' && (!value.cancelRequested && value.receipt?.phase !== 'cancelled'
        || value.receipt && value.receipt.phase !== 'cancelled')
      || value.receipt && ['published', 'cancelled', 'reconciled'].includes(value.receipt.phase) && value.phase !== value.receipt.phase)
      r.fail('conflict', 'repository_publication_phase')
  }
  return result
}

type ReadReceipt = (resource: string, kind: ReceiptRequest['kind'], id: string, hash: string, missingAllowed: boolean) => Promise<z.infer<typeof InventoryReceipt> | undefined>
/** Called only after an exhaustive audit, using that exact inventory revision; missing private work remains held. */
export async function reconcileRepositoryPublications(db: DatabaseSync, read: ReadReceipt, signal: AbortSignal): Promise<number> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_repository_publication'").get()) return 0
  let applied = 0
  for (const row of db.prepare('SELECT value FROM workspace_repository_publication ORDER BY rowid').iterate()) {
    signal.throwIfAborted(); const value = WorkspaceRepositoryPublication.parse(JSON.parse(String(row.value)))
    const expected = repositoryPublicationExpected(value), transfer = expected[1]!, publication = expected[2]!
    const observedTransfer = await read(value.serviceId, 'repository-transfer', value.transfer.id, fingerprint(value.transfer), !!transfer.absent)
    if (observedTransfer) {
      const receipt = observeRepositoryTransfer(value, observedTransfer.observation)
      if (observedTransfer.item.phase !== receipt.phase || observedTransfer.item.resultHash !== receipt.bundle.sha256
        || !observedTransfer.item.ownership || !sameOwner(observedTransfer.item.ownership, receipt.ownership)) throw new Error('Repository transfer observation differs from audited inventory')
      value.transferReceipt = receipt
    } else if (!transfer.absent) throw new Error('Original repository transfer receipt is missing')
    const observedPublication = await read(value.serviceId, 'repository-publication', value.id, fingerprint(value.publication), !!publication.absent)
    if (observedPublication) {
      const receipt = observeRepositoryReceipt(value, observedPublication.observation)
      if (value.transferReceipt?.phase !== 'ready' || observedPublication.item.phase !== receipt.phase || repositoryUncertain(receipt.phase) || receipt.phase === 'preparing'
        || observedPublication.item.resultHash !== fingerprint({ branch: receipt.branchResult ?? null, pull: receipt.pullResult ?? null })
        || !observedPublication.item.ownership || !sameOwner(observedPublication.item.ownership, receipt.ownership)) throw new Error('Repository publication observation differs from audited inventory')
      value.receipt = receipt
      value.phase = ['published', 'cancelled', 'reconciled'].includes(receipt.phase) ? receipt.phase as 'published' | 'cancelled' | 'reconciled' : 'held'
      value.problem = receipt.problem
    } else {
      if (!publication.absent) throw new Error('Original repository publication receipt is missing')
      if (value.phase !== 'cancelled') value.phase = 'held'
      value.problem = 'Private repository preparation remains unconfirmed. Resume the retained intent explicitly; no publication approval was replayed.'
    }
    value.updatedAt = new Date().toISOString()
    db.prepare('UPDATE workspace_repository_publication SET value=? WHERE id=?').run(JSON.stringify(WorkspaceRepositoryPublication.parse(value)), value.id)
    applied++
  }
  return applied
}
