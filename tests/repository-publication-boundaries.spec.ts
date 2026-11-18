import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { PublicationClient } from '../src/publication/client.ts'
import { GithubRepositoryPublication, type PreparedRepositoryBranch } from '../src/publication/repository-provider.ts'
import { RepositoryGit, RepositoryProcessUnsettled } from '../src/publication/repository-git.ts'
import type { RepositoryReceipt, RepositoryTransferReceipt } from '../src/publication/repository-model.ts'
import { repositoryPublicationFixture } from './fixtures/repository-publication.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
type Prepared = { prepared: boolean; receipt: RepositoryReceipt }

it('cancels an undispatched import, removes its private files and retains an immutable cancelled receipt', async () => {
  const h = await repositoryPublicationFixture(cleanup); await h.upload(); expect((await h.prepare()).prepared).toBe(true)
  const root = join(h.directory, 'service/imports'); expect((await readdir(root)).length).toBe(1)
  const request = { op: 'repository.receipt.cancel' as const, id: h.publication.id }
  await expect(h.admin.call(request)).rejects.toThrow('ownership proof')
  const cancelled = await h.client.call<RepositoryReceipt>(request)
  expect(cancelled).toMatchObject({ phase: 'cancelled', ownership: h.owner.status().owner, attempts: [] })
  expect(await readdir(root)).toEqual([])
  expect(await h.client.call(request)).toEqual(cancelled)
  expect((await h.prepare()).prepared).toBe(false); expect(await h.publish()).toEqual(cancelled)
  expect(h.git.pushes()).toBe(0); expect(h.posts).toBe(0)
  await expect(h.client.call({ op: 'repository.transfer.cancel', id: h.transfer.id })).rejects.toThrow('attached')
}, 30000)

it('cancels the remaining PR step after explicit refusal without deleting its already-created branch', async () => {
  const h = await repositoryPublicationFixture(cleanup); await h.upload(); expect((await h.prepare()).prepared).toBe(true)
  h.refusePull(true)
  const held = await h.publish(); expect(held).toMatchObject({ phase: 'held', step: 'pull', branchResult: { sha: h.transfer.bundle.head } })
  expect(held.attempts.map(item => item.step)).toEqual(['branch', 'pull'])
  const cancelled = await h.client.call<RepositoryReceipt>({ op: 'repository.receipt.cancel', id: h.publication.id })
  expect(cancelled).toMatchObject({ phase: 'cancelled', branchResult: held.branchResult })
  expect(await h.git.git('-C', h.git.bare, 'rev-parse', 'refs/heads/' + cancelled.branch)).toBe(h.transfer.bundle.head)
  h.refusePull(false); expect(await h.publish()).toEqual(cancelled)
  expect(h.git.pushes()).toBe(1); expect(h.posts).toBe(1); expect(h.pulls).toHaveLength(0)
}, 30000)

it('attributes transfer cancellation to the new owner while retaining its prior owner and deleting only unused chunks', async () => {
  const h = await repositoryPublicationFixture(cleanup), uploaded = await h.upload()
  await h.owner.close()
  const next = new CoordinatorOwnership(h.authority.config); cleanup.push(() => next.close()); await next.start()
  const client = new PublicationClient(h.connection, next)
  const cancelled = await client.call<RepositoryTransferReceipt>({ op: 'repository.transfer.cancel', id: h.transfer.id })
  expect(cancelled.phase).toBe('cancelled'); expect(cancelled.ownership).toEqual(next.status().owner)
  expect(cancelled.owners).toEqual([uploaded.ownership, next.status().owner])
  expect(h.service.journal.db.prepare('SELECT count(*) AS n FROM repository_transfer_chunk WHERE id=?').get(h.transfer.id)?.n).toBe(0)
  expect(await client.call({ op: 'repository.transfer.cancel', id: h.transfer.id })).toEqual(cancelled)
  expect(h.git.pushes()).toBe(0)
}, 30000)

it('does not accept a substituted branch receipt after dispatch, and recovers only the exact original branch', async () => {
  const original = GithubRepositoryPublication.prototype.prepare
  vi.spyOn(GithubRepositoryPublication.prototype, 'prepare').mockImplementation(async function (this: GithubRepositoryPublication, ...args) {
    const prepared = await original.apply(this, args)
    return { close: () => prepared.close(), push: async signal => ({ ...await prepared.push(signal), repositoryId: 999 }) }
  })
  const h = await repositoryPublicationFixture(cleanup); await h.upload(); expect((await h.prepare()).prepared).toBe(true)
  const unknown = await h.publish()
  expect(unknown).toMatchObject({ phase: 'unknown', step: 'branch' }); expect(unknown.branchResult).toBeUndefined()
  expect(h.git.updates()).toBe(1); expect(h.posts).toBe(0)
  await expect(h.client.call({ op: 'repository.receipt.cancel', id: unknown.id })).rejects.toThrow('inactive undispatched')
  const observed = await h.client.call<RepositoryReceipt>({ op: 'repository.receipt.observe', id: unknown.id })
  expect(observed).toMatchObject({ phase: 'held', step: 'pull', branchResult: { repositoryId: 20, sha: h.transfer.bundle.head } })
  expect((await h.publish()).phase).toBe('published'); expect(h.git.updates()).toBe(1); expect(h.posts).toBe(1)
}, 30000)

it('does not accept a substituted PR receipt after dispatch and observes the original without another POST', async () => {
  const original = GithubRepositoryPublication.prototype.createPull
  vi.spyOn(GithubRepositoryPublication.prototype, 'createPull').mockImplementation(async function (this: GithubRepositoryPublication, ...args) {
    return { ...await original.apply(this, args), bodyHash: '0'.repeat(64) }
  })
  const h = await repositoryPublicationFixture(cleanup); await h.upload(); expect((await h.prepare()).prepared).toBe(true)
  const unknown = await h.publish(); expect(unknown).toMatchObject({ phase: 'unknown', step: 'pull' }); expect(unknown.pullResult).toBeUndefined()
  expect(h.posts).toBe(1); expect(await h.publish()).toEqual(unknown)
  const observed = await h.client.call<RepositoryReceipt>({ op: 'repository.receipt.observe', id: unknown.id })
  expect(observed.phase).toBe('published'); expect(observed.pullResult?.bodyHash).not.toBe('0'.repeat(64))
  expect(h.posts).toBe(1); expect(h.git.updates()).toBe(1)
}, 30000)

it('counts in-flight imports against capacity and makes a cancelled cache slot available without external writes', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), closes = new Map<string, ReturnType<typeof vi.fn>>()
  const prepare = vi.spyOn(GithubRepositoryPublication.prototype, 'prepare').mockImplementation(async (_destination, _transfer, _chunks, branch) => {
    await waiting
    const close = vi.fn(async () => {}); closes.set(branch, close)
    return { close, push: vi.fn(async () => { throw new Error('Capacity fixture cannot publish') }) }
  })
  const h = await repositoryPublicationFixture(cleanup); await h.upload()
  const publications = Array.from({ length: 9 }, () => ({ ...h.publication, id: randomUUID() }))
  const requests = publications.map(publication => h.client.call<Prepared>({ op: 'repository.prepare', publication }))
  let results: Prepared[]
  try { await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(8), { timeout: 5000 }) }
  finally { release(); results = await Promise.all(requests) }
  expect(results.filter(result => result.prepared)).toHaveLength(8)
  const rejected = results.find(result => !result.prepared)!; expect(rejected.receipt.problem).toContain('eight')
  const ready = results.find(result => result.prepared)!
  await h.client.call({ op: 'repository.receipt.cancel', id: ready.receipt.id })
  expect(closes.get(ready.receipt.branch)).toHaveBeenCalledOnce()
  expect((await h.client.call<Prepared>({ op: 'repository.prepare', publication: publications.find(item => item.id === rejected.receipt.id)! })).prepared).toBe(true)
  expect(prepare).toHaveBeenCalledTimes(9); expect(h.git.pushes()).toBe(0); expect(h.posts).toBe(0)
}, 30000)

it('discards prepared imports from an expired owner before admitting the successor import', async () => {
  const closed: string[] = []
  const prepare = vi.spyOn(GithubRepositoryPublication.prototype, 'prepare').mockImplementation(async (_destination, _transfer, _chunks, branch): Promise<PreparedRepositoryBranch> =>
    ({ close: async () => { closed.push(branch) }, push: async () => { throw new Error('Cache fixture cannot publish') } }))
  const h = await repositoryPublicationFixture(cleanup); await h.upload()
  const old = Array.from({ length: 8 }, () => ({ ...h.publication, id: randomUUID() }))
  for (const publication of old) expect((await h.client.call<Prepared>({ op: 'repository.prepare', publication })).prepared).toBe(true)
  await h.owner.close()
  const next = new CoordinatorOwnership(h.authority.config); cleanup.push(() => next.close()); await next.start()
  const client = new PublicationClient(h.connection, next), publication = { ...h.publication, id: randomUUID() }
  expect((await client.call<Prepared>({ op: 'repository.prepare', publication })).prepared).toBe(true)
  expect(closed.sort()).toEqual(old.map(item => 'agentic/' + item.id).sort())
  expect(prepare).toHaveBeenCalledTimes(9); expect(h.git.pushes()).toBe(0); expect(h.posts).toBe(0)
}, 30000)

it('cannot adopt a matching external branch after an unsettled local import without a recorded dispatch', async () => {
  vi.spyOn(GithubRepositoryPublication.prototype, 'prepare').mockRejectedValue(new RepositoryProcessUnsettled('Injected local process uncertainty'))
  const h = await repositoryPublicationFixture(cleanup); await h.upload()
  const prepared = await h.prepare(); expect(prepared).toMatchObject({ prepared: false, receipt: { phase: 'unknown', step: 'branch', attempts: [] } })
  const branch = vi.spyOn(GithubRepositoryPublication.prototype, 'branch').mockResolvedValue({ repository: 'acme/project', repositoryId: 20,
    ref: prepared.receipt.branch, sha: h.transfer.bundle.head })
  expect(await h.client.call({ op: 'repository.receipt.observe', id: h.publication.id })).toEqual(prepared.receipt)
  expect(branch).not.toHaveBeenCalled(); expect(await h.publish()).toEqual(prepared.receipt)
  await expect(h.client.call({ op: 'repository.receipt.cancel', id: h.publication.id })).rejects.toThrow('inactive undispatched')
  expect(h.git.pushes()).toBe(0); expect(h.posts).toBe(0)
}, 30000)

it('leaves no private import directory when the paired provider cannot resolve its executable', async () => {
  const h = await repositoryPublicationFixture(cleanup); await h.upload()
  const resolve = vi.spyOn(LocalSubprocessRuntime.prototype, 'resolveExecutable').mockRejectedValueOnce(new Error('Injected executable lookup failure'))
  const spawn = vi.spyOn(LocalSubprocessRuntime.prototype, 'spawn')
  const prepared = await h.prepare()
  expect(prepared).toMatchObject({ prepared: false, receipt: { phase: 'held', attempts: [] } })
  expect(resolve).toHaveBeenCalledOnce(); expect(spawn).not.toHaveBeenCalled()
  expect(await readdir(join(h.directory, 'service/imports'))).toEqual([])
  expect(h.git.pushes()).toBe(0); expect(h.posts).toBe(0)
}, 30000)

it('preserves a competing branch created between the final existence check and the Git push', async () => {
  const h = await repositoryPublicationFixture(cleanup); await h.upload(); expect((await h.prepare()).prepared).toBe(true)
  const original = RepositoryGit.prototype.push
  vi.spyOn(RepositoryGit.prototype, 'push').mockImplementation(async function (this: RepositoryGit, branch, head) {
    await h.git.git('-C', h.git.bare, 'update-ref', 'refs/heads/' + branch, h.transfer.bundle.base)
    return original.call(this, branch, head)
  })
  const unknown = await h.publish()
  expect(unknown).toMatchObject({ phase: 'unknown', step: 'branch' }); expect(unknown.branchResult).toBeUndefined()
  expect(await h.git.git('-C', h.git.bare, 'rev-parse', 'refs/heads/' + unknown.branch)).toBe(h.transfer.bundle.base)
  expect(await h.client.call({ op: 'repository.receipt.observe', id: unknown.id })).toEqual(unknown)
  expect(h.posts).toBe(0)
}, 30000)

it('stops after branch creation when the owner releases its lease, and requires explicit successor publication for the PR', async () => {
  const h = await repositoryPublicationFixture(cleanup), original = GithubRepositoryPublication.prototype.prepare
  vi.spyOn(GithubRepositoryPublication.prototype, 'prepare').mockImplementation(async function (this: GithubRepositoryPublication, ...args) {
    const prepared = await original.apply(this, args)
    return { close: () => prepared.close(), push: async signal => { const value = await prepared.push(signal); await h.owner.close(); return value } }
  })
  await h.upload(); expect((await h.prepare()).prepared).toBe(true)
  const held = await h.publish()
  expect(held).toMatchObject({ phase: 'held', step: 'pull', branchResult: { sha: h.transfer.bundle.head } })
  expect(held.attempts.map(item => item.step)).toEqual(['branch']); expect(h.posts).toBe(0)
  const next = new CoordinatorOwnership(h.authority.config); cleanup.push(() => next.close()); await next.start()
  const client = new PublicationClient(h.connection, next)
  expect((await client.call<RepositoryReceipt>({ op: 'repository.receipt.get', id: held.id })).phase).toBe('held')
  expect(h.posts).toBe(0)
  const sent = await client.call<RepositoryReceipt>({ op: 'repository.publish', publication: h.publication, evidence: h.evidence() })
  expect(sent.phase).toBe('published'); expect(sent.attempts.map(item => item.step)).toEqual(['branch', 'pull'])
  expect(sent.attempts[1]?.ownership).toEqual(next.status().owner)
  expect(h.git.updates()).toBe(1); expect(h.posts).toBe(1)
}, 30000)
