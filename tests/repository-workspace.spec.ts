import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repositoryWorkspaceFixture } from './fixtures/repository-workspace.ts'
import { PublicationClient } from '../src/publication/client.ts'
import { RepositoryPublications } from '../src/publication/repository-runtime.ts'
import { WorkspaceRepositoryPublication } from '../src/publication/repository-runtime-model.ts'
import type { RepositoryReceipt } from '../src/publication/repository-model.ts'

const cleanup: (() => Promise<unknown>)[] = [], rid = () => randomUUID()
type Fixture = Awaited<ReturnType<typeof repositoryWorkspaceFixture>>
const retained = (h: Fixture) => WorkspaceRepositoryPublication.parse(JSON.parse(String(h.runtime.store.db
  .prepare('SELECT value FROM workspace_repository_publication WHERE id=?').get(h.prepareRequest.requestId)!.value)))
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('publishes exact reviewed history through workspace APIs with durable intent and a fresh approval before external writes', async () => {
  const h = await repositoryWorkspaceFixture(cleanup)
  expect(h.exported.phase).toBe('ready'); expect(h.exported.bundle?.head).toBe(h.head)
  expect(h.exported.evidence?.[0]?.selection).toEqual(h.exportRequest.checks[0])
  expect(h.runtime.verification.get(h.exported.evidence![0]!.capture.id)).toMatchObject({ purpose: 'freshness', status: 'captured', quiescent: true })
  expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
  const call = PublicationClient.prototype.call, mutations: string[] = []
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: Parameters<PublicationClient['call']>[0], signal?: AbortSignal): Promise<T> {
    if (['repository.transfer.begin', 'repository.transfer.chunk', 'repository.transfer.finish', 'repository.prepare', 'repository.publish'].includes(request.op)) {
      const item = retained(h); mutations.push(request.op)
      expect(item).toMatchObject({ id: h.prepareRequest.requestId, exportId: h.exported.id, transfer: { id: h.prepareRequest.requestId, source: h.git.url } })
      if (request.op === 'repository.publish') {
        expect(item.approvals).toHaveLength(1); expect(item.approvals[0]).toMatchObject({ dispatched: true, evidence: request.evidence })
        expect(item.phase).toBe('unknown')
      }
    }
    return call.call(this, request, signal) as Promise<T>
  })
  const catalog = await h.host.api('GET', 'repository-publication/destinations')
  expect(catalog).toMatchObject({ status: 200, body: { configured: true, items: [h.publisher.destination] } })
  const prepared = await h.host.api('POST', `repository-exports/${h.exported.id}/publications`, h.prepareRequest)
  expect(prepared).toMatchObject({ status: 200, body: { id: h.prepareRequest.requestId, phase: 'ready', received: h.exported.bundle!.bytes } })
  expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
  expect(await h.host.api('GET', `repository-exports/${h.exported.id}/publications`)).toMatchObject({ status: 200, body: { items: [{ id: h.prepareRequest.requestId }] } })
  const approval = { requestId: rid() }, published = await h.host.api('POST', `repository-publications/${h.prepareRequest.requestId}/publish`, approval)
  expect(published).toMatchObject({ status: 200, body: { phase: 'published', receipt: { phase: 'published', branchResult: { sha: h.head }, pullResult: { number: 1 } } } })
  const item = retained(h)
  expect(item.approvals[0]).toMatchObject({ id: approval.requestId, dispatched: true })
  expect(item.approvals[0]!.evidence![0]!.capture.id).not.toBe(h.exported.evidence![0]!.capture.id)
  expect(h.runtime.verification.get(item.approvals[0]!.evidence![0]!.capture.id)).toMatchObject({ purpose: 'freshness', status: 'captured', quiescent: true })
  expect(item.receipt!.attempts.map(attempt => attempt.evidence)).toEqual([item.approvals[0]!.evidence, item.approvals[0]!.evidence])
  expect(h.publisher.posts).toBe(1); expect(h.git.pushes()).toBe(1)
  expect(await h.git.git('-C', h.git.bare, 'rev-parse', 'refs/heads/agentic/' + item.id)).toBe(h.head)
  expect((await h.host.api('GET', `repository-publications/${item.id}`)).body).toMatchObject({ phase: 'published', approvals: [{ id: approval.requestId, dispatched: true }] })
  expect((await h.host.api('POST', `repository-publications/${item.id}/publish`, approval)).body.phase).toBe('published')
  expect((await h.host.api('POST', `repository-publications/${item.id}/refresh`)).body.phase).toBe('published')
  expect(mutations.filter(op => op === 'repository.publish')).toHaveLength(1)
  expect(h.publisher.posts).toBe(1); expect(h.git.pushes()).toBe(1)
}, 60000)

it('resumes acknowledged upload bytes after response loss and coordinator component restart under the same IDs', async () => {
  const h = await repositoryWorkspaceFixture(cleanup), publications = h.runtime.repositoryPublications!, offsets: number[] = []
  const call = PublicationClient.prototype.call
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: Parameters<PublicationClient['call']>[0], signal?: AbortSignal): Promise<T> {
    if (request.op === 'repository.transfer.chunk') { offsets.push(request.offset); expect(request.id).toBe(h.prepareRequest.requestId) }
    return call.call(this, request, signal) as Promise<T>
  })
  h.publisher.loseReplyWhen(value => value?.phase === 'receiving' && value.received === 65536)
  const held = await publications.prepare(h.exported.id, h.prepareRequest)
  expect(held).toMatchObject({ id: h.prepareRequest.requestId, phase: 'held', received: 0 })
  expect(offsets).toEqual([0])
  await publications.stop(); await h.publisher.restart()
  const recovered = new RepositoryPublications({ store: h.runtime.store, exports: h.runtime.repositoryExports, reviews: h.runtime.verificationReviews,
    ownership: h.runtime.ownership, connection: h.publisher.connection, lifetime: h.runtime.lifetime,
    roots: () => [h.world.root], authorize: () => { h.runtime.ownership!.proof() } })
  cleanup.push(() => recovered.stop())
  const ready = await recovered.retry(held.id)
  expect(ready).toMatchObject({ id: held.id, phase: 'ready', received: h.exported.bundle!.bytes, approvals: [] })
  expect(offsets).toEqual([0, 65536, 131072])
  expect(retained(h).transfer.id).toBe(held.id)
  expect(h.runtime.store.db.prepare('SELECT count(*) AS n FROM workspace_repository_publication').get()!.n).toBe(1)
  expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
}, 60000)

it('retains a dispatched approval after a lost publisher reply and rejects substituted receipts before observing the original', async () => {
  const h = await repositoryWorkspaceFixture(cleanup), publications = h.runtime.repositoryPublications!
  const ready = await publications.prepare(h.exported.id, h.prepareRequest), approval = { requestId: rid() }
  expect(ready.phase, ready.problem).toBe('ready')
  h.publisher.loseReplyWhen(value => value?.phase === 'published')
  const unknown = await publications.publish(ready.id, approval)
  expect(unknown).toMatchObject({ phase: 'unknown', approvals: [{ id: approval.requestId, dispatched: true }] })
  const original = retained(h), call = PublicationClient.prototype.call
  const mutations: ((receipt: RepositoryReceipt) => void)[] = [
    receipt => { receipt.bundle.head = 'f'.repeat(40) },
    receipt => { receipt.requestHash = 'f'.repeat(64) },
    receipt => { receipt.ownership.epoch++ },
    receipt => { receipt.attempts[0]!.evidence[0]!.capture.id = rid() },
  ]
  for (const mutate of mutations) {
    const spy = vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: Parameters<PublicationClient['call']>[0], signal?: AbortSignal): Promise<T> {
      const value = await call.call(this, request, signal)
      if (request.op === 'repository.receipt.observe') mutate(value as RepositoryReceipt)
      return value as T
    })
    expect((await publications.refresh(ready.id)).phase).toBe('unknown')
    expect(retained(h).receipt).toEqual(original.receipt)
    expect(retained(h).approvals).toEqual(original.approvals)
    spy.mockRestore()
  }
  // The source may change after an external result; observing that original result needs no new approval or source capture.
  await writeFile(join(h.taskDirectory, 'result.txt'), 'changed after dispatched approval\n')
  await h.publisher.restart()
  const observed = await publications.publish(ready.id, approval)
  expect(observed).toMatchObject({ phase: 'published', approvals: [{ id: approval.requestId, dispatched: true }], receipt: { pullResult: { number: 1 } } })
  expect(retained(h).approvals).toEqual(original.approvals)
  expect(h.publisher.posts).toBe(1); expect(h.git.pushes()).toBe(1)
}, 60000)

it('keeps an unobservable lost PR response unknown without replaying either external step', async () => {
  const h = await repositoryWorkspaceFixture(cleanup), publications = h.runtime.repositoryPublications!
  const ready = await publications.prepare(h.exported.id, h.prepareRequest), approval = { requestId: rid() }
  h.publisher.losePull()
  const unknown = await publications.publish(ready.id, approval)
  expect(unknown).toMatchObject({ phase: 'unknown', receipt: { phase: 'unknown', step: 'pull', branchResult: { sha: h.head } } })
  expect(h.publisher.posts).toBe(1); const actual = h.publisher.pulls.splice(0)
  expect((await publications.refresh(ready.id)).phase).toBe('unknown')
  expect((await publications.retry(ready.id)).phase).toBe('unknown')
  expect((await publications.publish(ready.id, { requestId: rid() })).phase).toBe('unknown')
  expect((await publications.publish(ready.id, approval)).phase).toBe('unknown')
  expect((await publications.cancel(ready.id))).toMatchObject({ phase: 'unknown', cancelRequested: true })
  expect(retained(h).approvals).toHaveLength(1)
  expect(h.publisher.posts).toBe(1); expect(h.git.pushes()).toBe(1)
  h.publisher.pulls.push(...actual)
  await h.runtime.ownership!.close()
  expect((await h.host.api('POST', `repository-publications/${ready.id}/cancel`)).status).toBe(409)
  expect(await h.host.api('POST', `repository-publications/${ready.id}/refresh`)).toMatchObject({ status: 200,
    body: { phase: 'published', cancelRequested: true, receipt: { pullResult: { number: 1 } } } })
  expect(h.publisher.posts).toBe(1); expect(h.git.pushes()).toBe(1)
}, 60000)

it('holds changed source, protects referenced exports, and exposes cancellation without a provider write', async () => {
  const h = await repositoryWorkspaceFixture(cleanup), publications = h.runtime.repositoryPublications!
  const ready = await publications.prepare(h.exported.id, h.prepareRequest)
  expect(ready.phase, ready.problem).toBe('ready')
  await expect(h.runtime.repositoryExports.cancel(h.exported.id)).rejects.toThrow('publication')
  await expect(publications.prepare(h.exported.id, { ...h.prepareRequest, title: 'Substituted intent' })).rejects.toThrow('another intent')
  await expect(publications.prepare(h.exported.id, { ...h.prepareRequest, requestId: rid() })).rejects.toThrow('already has a publication')
  await writeFile(join(h.taskDirectory, 'result.txt'), 'changed after export\n')
  const approval = { requestId: rid() }, held = await publications.publish(ready.id, approval)
  expect(held).toMatchObject({ phase: 'held', approvals: [{ id: approval.requestId, dispatched: false }] })
  expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
  await h.runtime.settings.pause(true, 'panel')
  expect(() => publications.publish(ready.id, { requestId: rid() })).toThrow('paused')
  expect(await h.host.api('POST', `repository-publications/${ready.id}/cancel`)).toMatchObject({ status: 200, body: { phase: 'cancelled', cancelRequested: true, receipt: { phase: 'cancelled' } } })
  await h.runtime.settings.pause(false, 'panel')
  expect((await h.host.api('POST', `repository-publications/${ready.id}/retry`)).body.phase).toBe('cancelled')
  expect((await h.host.api('POST', `repository-publications/${ready.id}/publish`, { requestId: rid() })).body.phase).toBe('cancelled')
  expect(retained(h).approvals).toHaveLength(1)
  expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
}, 60000)

it('does not lose a cancellation queued while original private preparation is still returning', async () => {
  const h = await repositoryWorkspaceFixture(cleanup), publications = h.runtime.repositoryPublications!
  const call = PublicationClient.prototype.call, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: Parameters<PublicationClient['call']>[0], signal?: AbortSignal): Promise<T> {
    const value = await call.call(this, request, signal)
    if (request.op === 'repository.prepare') { entered.resolve(); await release.promise }
    return value as T
  })
  const preparing = publications.prepare(h.exported.id, h.prepareRequest)
  await entered.promise
  let cancelled = false
  const cancelling = publications.cancel(h.prepareRequest.requestId).then(value => { cancelled = true; return value })
  await Promise.resolve(); expect(cancelled).toBe(false)
  release.resolve()
  expect((await preparing).phase).toBe('ready')
  expect(await cancelling).toMatchObject({ phase: 'cancelled', cancelRequested: true, receipt: { phase: 'cancelled' } })
  expect(retained(h).cancelRequested).toBe(true)
  expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
}, 60000)

it('preserves cancellation when an earlier completion callback queues a second private preparation', async () => {
  const h = await repositoryWorkspaceFixture(cleanup), publications = h.runtime.repositoryPublications!
  const ready = await publications.prepare(h.exported.id, h.prepareRequest)
  expect(ready.phase, ready.problem).toBe('ready')
  const call = PublicationClient.prototype.call, entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()],
    release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let preparations = 0, cancellations = 0
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: Parameters<PublicationClient['call']>[0], signal?: AbortSignal): Promise<T> {
    const value = await call.call(this, request, signal)
    if (request.op === 'repository.prepare') {
      const index = preparations++; entered[index]?.resolve(); await release[index]?.promise
    }
    if (request.op === 'repository.receipt.cancel') cancellations++
    return value as T
  })
  const preparing = publications.retry(ready.id)
  await entered[0]!.promise
  // Register this reaction first: it reserves another pending operation before cancel's await resumes.
  const queued = preparing.then(() => publications.retry(ready.id))
  const cancelling = publications.cancel(ready.id)
  try {
    release[0]!.resolve(); await entered[1]!.promise
    expect(preparations).toBe(2); expect(cancellations).toBe(0)
    release[1]!.resolve()
    expect((await queued).phase).toBe('ready')
    expect(await cancelling).toMatchObject({ phase: 'cancelled', cancelRequested: true, receipt: { phase: 'cancelled' } })
    expect(cancellations).toBe(1)
    expect(retained(h).cancelRequested).toBe(true)
    expect(h.publisher.posts).toBe(0); expect(h.git.pushes()).toBe(0)
  } finally { for (const pending of release) pending.resolve(); await Promise.allSettled([preparing, queued, cancelling]) }
}, 60000)
