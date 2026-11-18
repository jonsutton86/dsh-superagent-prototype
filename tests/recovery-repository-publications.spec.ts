import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { repositoryWorkspaceFixture } from './fixtures/repository-workspace.ts'
import { verifyPublicationState } from '../src/recovery/publications.ts'
import { repositoryPublicationExpected, reconcileRepositoryPublications } from '../src/recovery/repository-publications.ts'
import { WorkspaceRepositoryPublication } from '../src/publication/repository-runtime-model.ts'
import { InventoryPage, InventoryReceipt, type ReceiptRequest } from '../src/ownership/inventory.ts'
import { PublicationClient } from '../src/publication/client.ts'
import { PublicationError } from '../src/publication/protocol.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import { controlConfigurationChecks } from '../src/recovery/control.ts'
import type { RecoveryIntent } from '../src/recovery/ownership.ts'
import { repositoryRecoveryFixture } from './fixtures/repository-recovery.ts'
import { auditCheckpointReceipts } from '../src/recovery/audit.ts'
import { prepareCheckpointReceipts } from '../src/recovery/prepare.ts'
import { verifyReceiptImage } from '../src/recovery/image.ts'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { KV } from '../src/kv.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const signal = () => new AbortController().signal
type Fixture = Awaited<ReturnType<typeof repositoryWorkspaceFixture>>
const saved = (h: Fixture) => WorkspaceRepositoryPublication.parse(JSON.parse(String(h.runtime.store.db.prepare('SELECT value FROM workspace_repository_publication WHERE id=?').get(h.prepareRequest.requestId)!.value)))
const verify = (h: Fixture, settled = false) => verifyPublicationState(h.runtime.store.db, signal(), settled)
const change = (h: Fixture, edit: (value: WorkspaceRepositoryPublication) => void) => {
  const value = saved(h); edit(value)
  h.runtime.store.db.prepare('UPDATE workspace_repository_publication SET value=? WHERE id=?').run(JSON.stringify(value), value.id)
}
async function reader(h: Fixture) {
  const page = InventoryPage.parse(await h.publisher.admin.call({ op: 'recovery.inventory', offset: 0 }))
  const read = async (resource: string, kind: ReceiptRequest['kind'], id: string, hash: string, missingAllowed: boolean) => {
    expect(resource).toBe(h.publisher.connection.serviceId)
    try {
      const result = InventoryReceipt.parse(await h.publisher.admin.call({ op: 'recovery.receipt', revision: page.revision, kind, id }))
      expect(result).toMatchObject({ revision: page.revision, quiescent: true, item: { requestHash: hash, settled: true } })
      return result
    } catch (error) {
      if (missingAllowed && error instanceof PublicationError && error.status === 404 && error.code === 'receipt_missing') return undefined
      throw error
    }
  }
  return { page, read }
}

it('applies a lost repository response from the original audited receipt without replaying either external effect', async () => {
  const h = await repositoryWorkspaceFixture(cleanup)
  const prepared = await h.runtime.repositoryPublications.prepare(h.exported.id, h.prepareRequest)
  expect(prepared.phase, prepared.problem).toBe('ready')
  h.publisher.loseReplyWhen(value => value?.phase === 'published')
  const approval = { requestId: randomUUID() }
  const result = await h.runtime.repositoryPublications.publish(prepared.id, approval)
  expect(result.phase, result.problem).toBe('unknown')
  const before = recoveryStateDigest(h.runtime.store.db), original = saved(h)
  expect(await verify(h)).toMatchObject({ repositories: 1, repositoryApprovals: 1, repositoryUnresolved: 1 })
  expect(recoveryStateDigest(h.runtime.store.db)).toBe(before)
  await expect(verify(h, true)).rejects.toThrow('repository_publication_receipt')
  const { read } = await reader(h)
  expect(await reconcileRepositoryPublications(h.runtime.store.db, read, signal())).toBe(1)
  expect(await verify(h, true)).toMatchObject({ repositories: 1, repositoryTransfers: 1, repositoryReceipts: 1, repositoryUnresolved: 0 })
  expect(saved(h)).toMatchObject({ id: original.id, publication: original.publication, transfer: original.transfer, approvals: original.approvals, phase: 'published' })
  expect(h.publisher.posts).toBe(1); expect(h.git.pushes()).toBe(1)

  const corruptions: ((value: WorkspaceRepositoryPublication) => void)[] = [
    value => { value.exportId = randomUUID() }, value => { value.exportFingerprint = '0'.repeat(64) },
    value => { value.transfer.bundle.head = '0'.repeat(40) }, value => { value.request.title = 'Changed original request' },
    value => { value.destination.repositoryId++ }, value => { value.owners[0]!.coordinatorId = 'different' },
    value => { value.approvals[0]!.owner.nonce = randomUUID() }, value => { value.approvals[0]!.dispatched = false },
    value => { value.approvals[0]!.evidence![0]!.capture.id = randomUUID() },
    value => { value.receipt!.branchResult!.sha = '0'.repeat(40) }, value => { value.receipt!.pullResult!.bodyHash = '0'.repeat(64) },
    value => { value.transferReceipt!.phase = 'receiving' },
    value => { value.phase = 'reconciled'; value.receipt!.phase = 'reconciled'; delete value.receipt!.reconciliation },
    value => { value.receipt!.reconciliation = { at: new Date().toISOString(), note: 'Unexpected reconciliation note', evidence: 'Unexpected reconciliation evidence' } },
    value => { value.phase = 'held' },
  ]
  const settledDigest = recoveryStateDigest(h.runtime.store.db)
  for (const edit of corruptions) {
    h.runtime.store.db.exec('SAVEPOINT corrupt_repository')
    try { change(h, edit); await expect(verify(h, true)).rejects.toThrow(/recovery_publications_/) }
    finally { h.runtime.store.db.exec('ROLLBACK TO corrupt_repository; RELEASE corrupt_repository') }
    expect(recoveryStateDigest(h.runtime.store.db)).toBe(settledDigest)
  }
}, 60000)

it('retains missing undispatched private intents as held and blocks disappearance after admission or dispatch', async () => {
  const h = await repositoryWorkspaceFixture(cleanup)
  // Lose the transport before the first publisher write, after the durable coordinator intent exists.
  const call = PublicationClient.prototype.call
  const unavailable = vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(function (this: PublicationClient, request, ...rest) {
    if (request.op === 'repository.transfer.begin') throw new Error('No transfer admission')
    return call.call(this, request, ...rest)
  })
  const prepared = await h.runtime.repositoryPublications.prepare(h.exported.id, h.prepareRequest)
  unavailable.mockRestore()
  expect(prepared.phase).toBe('held')
  expect(saved(h).transferReceipt).toBeUndefined(); expect(saved(h).receipt).toBeUndefined()
  const expected = repositoryPublicationExpected(saved(h))
  expect(expected[1]).toMatchObject({ absent: true }); expect(expected[2]).toMatchObject({ absent: true })
  const { read } = await reader(h)
  await reconcileRepositoryPublications(h.runtime.store.db, read, signal())
  expect(await verify(h, true)).toMatchObject({ repositories: 1, repositoryTransfers: 0, repositoryReceipts: 0, repositoryUnresolved: 0 })
  expect(saved(h).phase).toBe('held'); expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
  expect((await h.runtime.repositoryPublications.retry(prepared.id)).phase).toBe('ready')
  expect(repositoryPublicationExpected(saved(h))[1]).toMatchObject({ absent: false })
  expect(repositoryPublicationExpected(saved(h))[2]).toMatchObject({ absent: false })
  await expect(reconcileRepositoryPublications(h.runtime.store.db, async () => undefined, signal())).rejects.toThrow('transfer receipt is missing')
  h.runtime.store.db.exec('SAVEPOINT dispatch_without_receipts')
  try {
    change(h, value => { delete value.receipt; delete value.transferReceipt; value.approvals.push({ id: randomUUID(), at: new Date().toISOString(), owner: value.owners[0]!, dispatched: true }) })
    expect(repositoryPublicationExpected(saved(h))[1]).toMatchObject({ absent: false })
    expect(repositoryPublicationExpected(saved(h))[2]).toMatchObject({ absent: false })
    await expect(verify(h)).rejects.toThrow('repository_publication_dispatched_evidence')
  } finally { h.runtime.store.db.exec('ROLLBACK TO dispatch_without_receipts; RELEASE dispatch_without_receipts') }
}, 60000)

it('checks repository-only recovery configuration with the original client and exact inventory revision', async () => {
  const h = await repositoryWorkspaceFixture(cleanup), client = new PublicationClient(h.publisher.connection)
  const { page } = await reader(h), destination = h.publisher.destination
  const request = { op: 'recovery.repository-destination' as const, revision: page.revision, destination: destination.id, destinationHash: destination.hash }
  expect(await client.call(request)).toMatchObject({ revision: page.revision, destination: destination.id, destinationHash: destination.hash, account: true, target: true, quiescent: true })
  const checks = controlConfigurationChecks({ authority: h.authority.config, publication: h.publisher.admin.config, publicationClient: h.publisher.connection },
    h.runtime.store.db, { credentialFile: h.authority.config.credentialFile } as RecoveryIntent,
    { epoch: 0, recovery: { generation: 1, checkpoint: randomUUID(), digest: '0'.repeat(64) }, resources: [{ identity: page.identity, revision: page.revision, total: page.total, quiescent: true }] }, [], signal())
  expect(await checks.find(check => check.kind === 'publication')!.verify()).toBe(1)
  await expect(h.publisher.admin.call(request)).rejects.toMatchObject({ status: 403, code: 'client_required' })
  await expect(client.call({ ...request, destinationHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'destination_changed' })
  await h.runtime.repositoryPublications.prepare(h.exported.id, h.prepareRequest)
  await expect(client.call(request)).rejects.toMatchObject({ code: 'inventory_changed' })
  expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
}, 60000)

it('restores a lost publication response through an encrypted checkpoint, authenticated JSONL and a held image, rejecting substituted evidence', async () => {
  const h = await repositoryRecoveryFixture(cleanup)
  const prepared = await h.runtime.repositoryPublications.prepare(h.exported.id, h.prepareRequest)
  expect(prepared.phase, prepared.problem).toBe('ready')
  h.publisher.loseReplyWhen(value => value?.phase === 'published')
  expect((await h.runtime.repositoryPublications.publish(prepared.id, { requestId: randomUUID() })).phase).toBe('unknown')
  const original = saved(h), f = await h.snapshot()
  expect(f.checkpoint.manifest.sessions.length).toBeGreaterThanOrEqual(2)
  expect(f.checkpoint.manifest.sessions.some(session => session.eventCount > 0)).toBe(true)
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit, JSON.stringify(audit.issues)).toMatchObject({ status: 'matched', phase: 'complete', issueCount: 0 })
  const request = { ...f.audit, requestId: randomUUID(), auditId: audit.id }
  const call = PublicationClient.prototype.call
  const corrupt = vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function (this: PublicationClient, request, ...rest) {
    const result = await call.call(this, request, ...rest)
    if (request.op === 'recovery.receipt' && request.kind === 'repository-publication') {
      const forged = structuredClone(result) as any; forged.observation.branchResult.sha = '0'.repeat(40); return forged
    }
    return result
  })
  await expect(prepareCheckpointReceipts(request)).rejects.toThrow('Repository observation differs')
  corrupt.mockRestore()
  const image = await prepareCheckpointReceipts(request)
  expect(await verifyReceiptImage(image.path, f.keyFile)).toEqual(image.manifest)
  expect(await prepareCheckpointReceipts(request)).toEqual(image)
  expect(image.manifest).toMatchObject({ executionOwnership: false, applied: { repositoryPublications: 1 }, controlConfiguration: { publication: true, destinations: 1 },
    publicationState: { repositories: 1, repositoryApprovals: 1, repositoryTransfers: 1, repositoryReceipts: 1, repositoryUnresolved: 0 } })
  for (const [directory, phase, hold] of [[f.held, 'unknown', 'staged'], [image.path, 'published', 'prepared']] as const) {
    const db = new DatabaseSync(join(directory, 'orchestrator.sqlite'), { readOnly: true })
    try {
      const value = WorkspaceRepositoryPublication.parse(JSON.parse(String(db.prepare('SELECT value FROM workspace_repository_publication WHERE id=?').get(original.id)!.value)))
      expect(value).toMatchObject({ id: original.id, publication: original.publication, transfer: original.transfer, approvals: original.approvals, phase })
      expect(JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.hold)!.value))).toMatchObject({ state: hold })
    } finally { db.close() }
  }
  expect(h.publisher.posts).toBe(1); expect(h.git.pushes()).toBe(1)
}, 90000)
