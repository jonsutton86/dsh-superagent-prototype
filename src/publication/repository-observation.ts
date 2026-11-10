/** Validate independent observations against retained coordinator authority; never mint a new intent. */
import { fingerprint } from '../remote/journal.ts'
import { sameOwner } from '../ownership/gate.ts'
import { PublicationError } from './protocol.ts'
import { RepositoryTransferReceipt, RepositoryReceipt } from './repository-model.ts'
import type { WorkspaceRepositoryPublication } from './repository-runtime-model.ts'
import { repositoryPullBody } from './repository-provider.ts'
import { contentHash } from './github.ts'
import { freshSeal } from '../verification/reviews.ts'

const changed = (): never => { throw new PublicationError(409, 'repository_receipt_changed', 'Repository observation differs from its retained intent and approvals') }
export function observeRepositoryTransfer(item: WorkspaceRepositoryPublication, input: unknown): RepositoryTransferReceipt {
  const value = RepositoryTransferReceipt.parse(input)
  const { hash, ownership, owners, phase, received, createdAt: _, updatedAt: __, ...request } = value
  if (fingerprint(request) !== fingerprint(item.transfer) || hash !== fingerprint(item.transfer)
    || !item.owners.some(owner => sameOwner(owner, ownership)) || owners.some(owner => !item.owners.some(saved => sameOwner(owner, saved)))
    || !owners.some(owner => sameOwner(owner, ownership)) || received > item.transfer.bundle.bytes
    || phase === 'ready' && received !== item.transfer.bundle.bytes
    || item.transferReceipt && (received < item.transferReceipt.received
      || item.transferReceipt.phase === 'cancelled' && phase !== 'cancelled'
      || item.transferReceipt.phase === 'ready' && phase === 'receiving')) changed()
  return value
}
export function observeRepositoryReceipt(item: WorkspaceRepositoryPublication, input: unknown): RepositoryReceipt {
  const value = RepositoryReceipt.parse(input), request = item.publication, destination = item.destination
  if (item.transferReceipt?.phase !== 'ready'
    || value.id !== item.id || value.requestHash !== fingerprint(request) || value.destination !== destination.id || value.destinationHash !== destination.hash
    || value.transferId !== item.transfer.id || value.transferHash !== fingerprint(item.transfer)
    || fingerprint(value.artifact) !== fingerprint(item.transfer.artifact) || fingerprint(value.bundle) !== fingerprint(item.transfer.bundle)
    || value.branch !== 'agentic/' + item.id || !item.owners.some(owner => sameOwner(owner, value.ownership))) changed()
  const steps = new Set<string>()
  for (const attempt of value.attempts) {
    const key = fingerprint({ step: attempt.step, owner: attempt.ownership, evidence: attempt.evidence })
    if (steps.has(key) || attempt.evidence.some(seal => !freshSeal(seal, Date.parse(attempt.at)))) changed()
    steps.add(key)
    if (!item.approvals.some(approval => approval.dispatched && sameOwner(approval.owner, attempt.ownership)
      && fingerprint(approval.evidence) === fingerprint(attempt.evidence))) changed()
  }
  const branch = value.branchResult, pull = value.pullResult
  if (branch && (branch.repository !== destination.repository || branch.repositoryId !== destination.repositoryId || branch.ref !== value.branch || branch.sha !== value.bundle.head)) changed()
  if (pull && (!branch || fingerprint(pull.head) !== fingerprint(branch) || pull.repositoryId !== destination.repositoryId
    || pull.base.repository !== destination.repository || pull.base.repositoryId !== destination.repositoryId || pull.base.ref !== destination.baseRef
    || pull.url !== `https://github.com/${destination.repository}/pull/${pull.number}` || pull.title !== request.title
    || !item.transferReceipt || pull.bodyHash !== contentHash(repositoryPullBody(request, item.transferReceipt)))) changed()
  if ((value.phase === 'reconciled') !== !!value.reconciliation
    || value.phase === 'published' && !pull || value.step === 'pull' && !branch
    || branch && !value.attempts.some(attempt => attempt.step === 'branch') || pull && !value.attempts.some(attempt => attempt.step === 'pull')) changed()
  const prior = item.receipt
  if (prior && (value.attempts.length < prior.attempts.length
    || fingerprint(value.attempts.slice(0, prior.attempts.length)) !== fingerprint(prior.attempts)
    || prior.branchResult && fingerprint(value.branchResult) !== fingerprint(prior.branchResult)
    || prior.pullResult && fingerprint(value.pullResult) !== fingerprint(prior.pullResult)
    || ['published', 'cancelled', 'reconciled'].includes(prior.phase) && value.phase !== prior.phase)) changed()
  return value
}
