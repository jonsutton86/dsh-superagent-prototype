import { spawnSync } from 'node:child_process'
import { RepositoryRef, RepositoryDestinationConfig } from '../src/publication/repository-model.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { repositoryPublicationFixture } from './fixtures/repository-publication.ts'
import type { RepositoryReceipt, RepositoryTransferReceipt } from '../src/publication/repository-model.ts'
import { InventoryPage } from '../src/ownership/inventory.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('imports actual reviewed Git history, atomically creates one branch and creates one original PR through the private publisher', async () => {
  const h = await repositoryPublicationFixture(cleanup)
  expect((await h.upload()).phase).toBe('ready')
  const prepared = await h.prepare(); expect(prepared.prepared, prepared.receipt.problem).toBe(true)
  const receipt = await h.publish()
  expect(receipt.phase, receipt.problem).toBe('published')
  expect(receipt.branchResult?.sha).toBe(h.transfer.bundle.head)
  expect(await h.git.git('-C', h.git.bare, 'rev-parse', 'refs/heads/' + receipt.branch)).toBe(h.transfer.bundle.head)
  expect(receipt.pullResult).toMatchObject({ head: { sha: h.transfer.bundle.head }, draft: true, number: 1 })
  expect(receipt.attempts.map(value => value.step)).toEqual(['branch', 'pull'])
  expect(h.git.pushes()).toBe(1); expect(h.posts).toBe(1)
  expect(await h.publish()).toEqual(receipt)
  await h.restart()
  expect(await h.client.call({ op: 'repository.receipt.get', id: receipt.id })).toEqual(receipt)
  const inventory = InventoryPage.parse(await h.admin.call({ op: 'recovery.inventory', offset: 0 }))
  expect(inventory.quiescent).toBe(true)
  expect(inventory.items.map(value => value.kind).sort()).toEqual(['repository-destination', 'repository-publication', 'repository-transfer'])
  expect(JSON.stringify(inventory)).not.toContain(h.git.token); expect(JSON.stringify(receipt)).not.toContain(h.git.token)
}, 30000)

it('observes a lost Git push acknowledgement and explicitly resumes only the remaining PR step', async () => {
  const h = await repositoryPublicationFixture(cleanup); await h.upload(); expect((await h.prepare()).prepared).toBe(true)
  h.git.losePushReply()
  const unknown = await h.publish(); expect(unknown).toMatchObject({ phase: 'unknown', step: 'branch' }); expect(h.posts).toBe(0)
  const requests = h.git.pushes()
  expect(await h.publish()).toEqual(unknown); expect(h.git.pushes()).toBe(requests); expect(h.git.updates()).toBe(1)
  const observed = await h.client.call<RepositoryReceipt>({ op: 'repository.receipt.observe', id: unknown.id })
  expect(observed).toMatchObject({ phase: 'held', step: 'pull', branchResult: { sha: h.transfer.bundle.head } })
  expect((await h.publish()).phase).toBe('published'); expect(h.git.pushes()).toBe(requests); expect(h.git.updates()).toBe(1); expect(h.posts).toBe(1)
}, 30000)

it('observes a lost PR acknowledgement across publisher restart without issuing another POST', async () => {
  const h = await repositoryPublicationFixture(cleanup); await h.upload(); expect((await h.prepare()).prepared).toBe(true)
  h.losePull(); const unknown = await h.publish()
  expect(unknown).toMatchObject({ phase: 'unknown', step: 'pull' }); expect(h.posts).toBe(1)
  await h.restart()
  const observed = await h.client.call<RepositoryReceipt>({ op: 'repository.receipt.observe', id: unknown.id })
  expect(observed.phase).toBe('published'); expect(h.posts).toBe(1); expect(h.git.pushes()).toBe(1)
}, 30000)

it('resumes original uploaded chunks, refuses changed ranges and validates bundle integrity before importing', async () => {
  const h = await repositoryPublicationFixture(cleanup), first = h.bytes.subarray(0, 65536)
  await h.client.call({ op: 'repository.transfer.begin', transfer: h.transfer })
  const { createHash } = await import('node:crypto'), hash = createHash('sha256').update(first).digest('hex')
  const request = { op: 'repository.transfer.chunk' as const, id: h.transfer.id, offset: 0, data: first.toString('base64'), hash }
  const original = await h.client.call<RepositoryTransferReceipt>(request)
  expect(await h.client.call(request)).toEqual(original)
  await expect(h.client.call({ ...request, data: Buffer.from('different').toString('base64') })).rejects.toThrow()
  await expect(h.client.call({ op: 'repository.transfer.finish', id: h.transfer.id })).rejects.toThrow('incomplete')
  await h.restart(); await vi.waitFor(async () => expect((await h.upload()).phase).toBe('ready'), { timeout: 5000 })
  h.service.journal.db.prepare('UPDATE repository_transfer_chunk SET data=? WHERE id=? AND offset=0').run(Buffer.from('corrupt'), h.transfer.id)
  expect((await h.prepare()).prepared).toBe(false); expect(h.git.pushes()).toBe(0); expect(h.posts).toBe(0)
}, 30000)

// The installed Git executable is the oracle for supported branch-name syntax.
it.each(['main', 'feat/full-superagent-architecture', 'release/v1.2', 'HEAD',
  '.hidden', 'topic/.hidden', 'topic..next', 'topic//next', 'topic.lock', 'topic.lock/next',
  'topic/', 'topic.', '-topic', 'topic space', 'topic~1', 'topic^', 'topic:next',
  'topic?next', 'topic*next', 'topic[next', 'topic\\next', 'topic@{1}', 'topic\n'])
('validates repository branch name against Git: %j', name => {
  const git = spawnSync('git', ['check-ref-format', '--branch', name], { encoding: 'utf8' })
  expect(git.error).toBeUndefined()
  expect(RepositoryRef.safeParse(name).success).toBe(git.status === 0)
})

it('rejects the symbolic HEAD name before constructing a repository destination', () => {
  expect(RepositoryDestinationConfig.safeParse({ id: 'test', name: 'Test', repository: 'acme/project',
    repositoryId: 20, baseRef: 'HEAD', login: 'publisher', credentialFile: '/tmp/test-credential' }).success).toBe(false)
})
