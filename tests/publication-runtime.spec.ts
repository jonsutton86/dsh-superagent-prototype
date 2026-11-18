import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { publicationFixture } from './fixtures/publication.ts'
import { startRuntime } from './fixtures/host.ts'
import { PublicationClient } from '../src/publication/client.ts'
import type { PublicationRpc } from '../src/publication/protocol.ts'
import type { PublicationRecord } from '../src/publication/runtime.ts'
import { Publications } from '../src/publication/runtime.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
async function fixture() {
  const authority = await ownershipAuthority(cleanup), publisher = await publicationFixture(cleanup, authority.resource)
  const host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true, ownership: authority.config, publication: publisher.connection })
  cleanup.push(() => host.stop())
  const artifact = host.runtime.library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'Reviewed report', summary: 'Operator-approved report',
    content: 'A reviewed result', mime: 'text/markdown', filename: 'report.md' })
  const destination = (await host.runtime.publications.destinations()).items[0]!
  const approval = { requestId: randomUUID(), revision: artifact.revision, hash: artifact.hash, destination: destination.id, destinationHash: destination.hash }
  return { authority, publisher, host, artifact, approval }
}

it('publishes exact approved artifact content and recovers a lost acknowledgement with the original ID', async () => {
  const { host, publisher, artifact, approval } = await fixture()
  const call = PublicationClient.prototype.call; let drop = true
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const value = await call.call(this, request, signal)
    if (request.op === 'publish' && drop) { drop = false; throw new Error('Lost publication acknowledgement') }
    return value as T
  })
  const first = await host.api('POST', `library/${artifact.id}/publications`, approval)
  expect(first.status).toBe(200); expect(first.body).toMatchObject({ id: approval.requestId, phase: 'unknown', hash: artifact.hash })
  expect(publisher.posts).toBe(1)
  expect((await host.api('POST', `publications/${approval.requestId}/retry`)).body).toMatchObject({ phase: 'observed', receipt: { phase: 'sent', hash: artifact.hash } })
  expect(publisher.posts).toBe(1)
  const records = await host.api('GET', `library/${artifact.id}/publications`)
  expect((records.body.items as PublicationRecord[])).toHaveLength(1)
  expect(JSON.stringify(records.body)).not.toContain(publisher.secret)
  expect(JSON.stringify(records.body)).not.toContain('A reviewed result')
  expect(publisher.comments[0]!.body).toContain('A reviewed result\n\n<!-- dsh-publication:')
})

it('refuses stale approvals and concurrent request substitution without sending extra comments', async () => {
  const { host, publisher, artifact, approval } = await fixture()
  expect((await host.api('POST', `library/${artifact.id}/publications`, { ...approval, hash: '0'.repeat(64) })).status).toBe(409)
  expect((await host.api('POST', `library/${artifact.id}/publications`, { ...approval, destinationHash: '0'.repeat(64) })).status).toBe(409)
  const values = await Promise.all([host.api('POST', `library/${artifact.id}/publications`, approval), host.api('POST', `library/${artifact.id}/publications`, approval)])
  expect(values.map(value => value.status)).toEqual([200, 200]); expect(publisher.posts).toBe(1)
  expect((await host.api('POST', `library/${artifact.id}/publications`, { ...approval, requestId: randomUUID() })).status).toBe(409)
  expect((await host.api('POST', `library/${artifact.id}/publications`, { ...approval, revision: 2 })).status).toBe(409)
  host.runtime.library.archive(artifact.id, { requestId: randomUUID(), revision: 1, archived: true })
  expect((await host.api('POST', `library/${artifact.id}/publications`, { ...approval, requestId: randomUUID() })).status).toBe(409)
  expect(publisher.posts).toBe(1)
})

it('keeps publication observation available after ownership loss and never dispatches a retry', async () => {
  const { host, publisher, artifact, approval, authority } = await fixture()
  publisher.loseProviderReply()
  expect((await host.api('POST', `library/${artifact.id}/publications`, approval)).body).toMatchObject({ receipt: { phase: 'unknown' } })
  authority.restart()
  await vi.waitFor(() => expect(host.runtime.lifetime.aborted).toBe(true), { timeout: 5000 })
  expect((await host.api('POST', `publications/${approval.requestId}/refresh`)).body).toMatchObject({ receipt: { phase: 'sent' } })
  expect((await host.api('POST', `publications/${approval.requestId}/retry`)).status).toBe(409)
  expect((await host.api('POST', `library/${artifact.id}/publications`, { ...approval, requestId: randomUUID() })).status).toBe(409)
  expect(publisher.posts).toBe(1)
  expect(() => new Publications({ store: host.runtime.store, library: host.runtime.library, lifetime: new AbortController().signal, roots: () => [] }))
    .toThrow('cannot be removed or replaced')
}, 10_000)

it.each(['stale', 'unknown'] as const)('refuses artifact publication when transitive source state is %s', async state => {
  const { host, publisher, approval } = await fixture(), library = host.runtime.library
  let source = library.publish({ requestId: randomUUID(), kind: 'memory', title: 'Original', summary: 'Source', content: 'Evidence' })
  const leaf = source
  for (let n = 0; n < (state === 'unknown' ? 34 : 2); n++) source = library.publish({ requestId: randomUUID(), kind: 'memory',
    title: `Derived ${n}`, summary: 'Source chain', content: 'Derived evidence', sources: [{ id: source.id, relation: 'derived_from' }] })
  if (state === 'stale') library.archive(leaf.id, { requestId: randomUUID(), revision: 1, archived: true })
  const artifact = library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'Dependent report', summary: 'Requires source check',
    content: 'Candidate result', sources: [{ id: source.id, relation: 'derived_from' }] })
  expect(library.read(artifact.id).freshness?.status).toBe(state)
  expect((await host.api('POST', `library/${artifact.id}/publications`, { ...approval, hash: artifact.hash, revision: artifact.revision })).status).toBe(409)
  expect(publisher.posts).toBe(0)
})
