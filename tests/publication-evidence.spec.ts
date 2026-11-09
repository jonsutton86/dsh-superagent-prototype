import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { verificationFixture } from './fixtures/verification.ts'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { publicationFixture } from './fixtures/publication.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { Publications } from '../src/publication/runtime.ts'
import { PublicationClient } from '../src/publication/client.ts'
import { PublicationError, type Publication, type PublicationReceipt, type PublicationRpc } from '../src/publication/protocol.ts'
import { RemoteError } from '../src/remote/protocol.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
async function fixture(native = false, remoteHost = false) {
  const h = await verificationFixture(cleanup, native, remoteHost), authority = await ownershipAuthority(cleanup), owner = new CoordinatorOwnership(authority.config)
  const publisher = await publicationFixture(cleanup, authority.resource, owner)
  cleanup.push(() => owner.close()); await owner.start()
  const host = { store: h.store, library: h.library, lifetime: h.lifetime.signal, roots: () => [h.source], ownership: owner,
    connection: publisher.connection, verification: h.verification, reviews: h.reviews }
  const publications = new Publications(host); cleanup.push(() => publications.stop())
  const artifact = await h.artifact(), checked = await h.check(artifact), destination = (await publications.destinations()).items[0]!
  const approval = { requestId: randomUUID(), revision: artifact.revision, hash: artifact.hash, destination: destination.id,
    destinationHash: destination.hash, checks: [checked.selection] }
  return { ...h, authority, owner, publisher, host, publications, artifact, checked, approval }
}

it('requires exact successful host checks and records capture-bound evidence in the independent receipt', async () => {
  const h = await fixture(), { checks, ...unchecked } = h.approval
  await expect(h.publications.publish(h.artifact.id, unchecked)).rejects.toThrow('successful host checks')
  await expect(h.publications.publish(h.artifact.id, { ...h.approval, checks: [{ ...checks[0], evidenceHash: '0'.repeat(64) }] })).rejects.toThrow()
  expect(h.publisher.posts).toBe(0)
  const record = await h.publications.publish(h.artifact.id, h.approval)
  expect(record).toMatchObject({ phase: 'observed', receipt: { phase: 'sent', artifact: { basis: 'checks' } } })
  expect(record.receipt!.artifact!.evidence).toEqual(record.verification!.evidence)
  const seal = record.verification!.evidence![0]!
  expect(seal).toMatchObject({ artifact: { id: h.artifact.id, revision: h.artifact.revision, hash: h.artifact.hash }, selection: checks[0], confinement: 'host-process' })
  expect(h.verification.get(seal.capture.id)).toMatchObject({ purpose: 'freshness', status: 'captured', quiescent: true })
  expect(h.publisher.posts).toBe(1)
})

it('holds changed sources without sending and prevents a held approval from duplicating a newer publication', async () => {
  const h = await fixture(); await writeFile(join(h.source, 'dependency.txt'), 'new input')
  const held = await h.publications.publish(h.artifact.id, h.approval)
  expect(held.phase).toBe('held'); expect(h.publisher.posts).toBe(0)
  const newer = await h.check(h.artifact)
  const published = await h.publications.publish(h.artifact.id, { ...h.approval, requestId: randomUUID(), checks: [newer.selection] })
  expect(published.receipt?.phase).toBe('sent')
  const attempts = h.reviews.get(held.id).attempts.length
  expect((await h.publications.retry(held.id)).phase).toBe('held')
  expect(h.reviews.get(held.id).attempts).toHaveLength(attempts); expect(h.publisher.posts).toBe(1)
})

it('observes a lost original receipt after source changes and restart without capturing or sending again', async () => {
  const h = await fixture(), call = PublicationClient.prototype.call
  let drop = true
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const response = await call.call(this, request, signal)
    if (request.op === 'publish' && drop) { drop = false; throw new Error('Lost acknowledgement') }
    return response as T
  })
  expect((await h.publications.publish(h.artifact.id, h.approval)).phase).toBe('unknown')
  const review = h.reviews.get(h.approval.requestId)
  await writeFile(join(h.source, 'artifact.txt'), 'changed after delivery')
  h.library.archive(h.artifact.id, { requestId: randomUUID(), revision: h.artifact.revision, archived: true })
  await h.publications.stop(); await h.publisher.restart()
  const recovered = new Publications(h.host); cleanup.push(() => recovered.stop())
  expect((await recovered.retry(h.approval.requestId)).receipt?.phase).toBe('sent')
  expect(h.reviews.get(h.approval.requestId)).toEqual(review); expect(h.publisher.posts).toBe(1)
})

it('does not treat unavailable observation or a disappearing known receipt as absence', async () => {
  const h = await fixture(), call = PublicationClient.prototype.call
  let mode: 'unavailable' | 'normal' | 'missing' = 'unavailable'
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    if (request.op === 'receipt.observe' && mode !== 'normal') {
      if (mode === 'missing') throw new PublicationError(404, 'receipt_missing', 'Receipt missing')
      throw new Error('Observation unavailable')
    }
    return await call.call(this, request, signal) as T
  })
  expect((await h.publications.publish(h.artifact.id, h.approval)).phase).toBe('unknown')
  expect(() => h.reviews.get(h.approval.requestId)).toThrow('not found'); expect(h.publisher.posts).toBe(0)
  mode = 'normal'; expect((await h.publications.retry(h.approval.requestId)).receipt?.phase).toBe('sent')
  const review = h.reviews.get(h.approval.requestId)
  mode = 'missing'; expect((await h.publications.retry(h.approval.requestId)).phase).toBe('unknown')
  expect(h.reviews.get(h.approval.requestId)).toEqual(review); expect(h.publisher.posts).toBe(1)
})

it('refuses publishers without the evidence capability and serializes competing approvals', async () => {
  const h = await fixture(), call = PublicationClient.prototype.call
  const spy = vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const response = await call.call(this, request, signal)
    if (request.op === 'identity') return { ...response as object, capabilities: undefined } as T
    return response as T
  })
  await expect(h.publications.publish(h.artifact.id, h.approval)).rejects.toThrow('support artifact evidence')
  expect(h.publisher.posts).toBe(0); spy.mockRestore()
  const results = await Promise.allSettled([h.publications.publish(h.artifact.id, h.approval),
    h.publications.publish(h.artifact.id, { ...h.approval, requestId: randomUUID() })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(h.publisher.posts).toBe(1)
})

it('rechecks freshness after provider preparation and preserves an expired original receipt', async () => {
  const h = await fixture()
  const evidence = await h.reviews.prepare({ id: randomUUID(), purpose: 'publication', target: 'a'.repeat(64), checks: h.approval.checks })
  evidence[0]!.validUntil = new Date(Date.now() + 700).toISOString()
  const publication: Publication = { id: randomUUID(), destination: h.approval.destination, destinationHash: h.approval.destinationHash,
    text: 'evidence', hash: h.artifact.hash, artifact: { id: h.artifact.id, revision: h.artifact.revision, hash: h.artifact.hash, basis: 'checks', evidence } }
  let release!: () => void; h.publisher.holdPrepare(new Promise<void>(resolve => { release = resolve }))
  const sending = h.publisher.client.call<PublicationReceipt>({ op: 'publish', publication }); void sending.catch(() => {})
  try {
    await vi.waitFor(() => expect(h.publisher.inspections).toBe(1))
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(evidence[0]!.validUntil)))
    release()
    const receipt = await sending
    expect(receipt.phase).toBe('failed'); expect(h.publisher.posts).toBe(0)
    expect(await h.publisher.client.call({ op: 'publish', publication })).toEqual(receipt)
    await expect(h.publisher.client.call({ op: 'publish', publication: { ...publication, id: randomUUID() } })).rejects.toThrow('expired')
  } finally { release(); h.publisher.holdPrepare() }
})

it.each([false, ...(process.env.DSH_REMOTE_ISOLATION === '1' ? [true] : [])])('accepts and publishes across original-world lease renewal and endpoint restart (native: %s)', async native => {
  const h = await fixture(native, !native), mission = h.ready(), action = mission.actions[0]!
  await h.remote!.client.intent({ op: 'grant.renew', requestId: randomUUID(), revision: h.checked.run.backend.revision, leaseMs: 300000 })
  const accepted = await h.workspace.actReviewed(mission.id, action.id, { requestId: randomUUID(), revision: mission.revision, command: 'complete',
    ticketRevision: action.ticket!.revision, text: 'Checked the actual confined output', reviewKind: 'checks', checks: h.approval.checks })
  expect(accepted.actions[0]!.accepted?.evidence?.[0]?.confinement).toBe(native ? 'linux-bubblewrap' : 'host-process')
  expect(h.verification.get(accepted.actions[0]!.accepted!.evidence![0]!.capture.id).backend.revision).toBe(h.checked.run.backend.revision + 1)
  const sent = await h.publications.publish(h.artifact.id, h.approval)
  expect(sent.receipt).toMatchObject({ phase: 'sent', artifact: { basis: 'checks', evidence: [{ confinement: native ? 'linux-bubblewrap' : 'host-process' }] } })
  expect(h.remote!.endpoint.journal.jobs()).toHaveLength(3)
  await h.remote!.restart()
  expect((await h.publications.retry(h.approval.requestId)).receipt).toEqual(sent.receipt)
  expect(h.workspace.get(mission.id).actions[0]!.accepted).toEqual(accepted.actions[0]!.accepted)
  expect(h.remote!.endpoint.journal.jobs()).toHaveLength(3); expect(h.publisher.posts).toBe(1)
})

it('preserves a definitive remote admission refusal instead of overwriting it with a missing-command observation', async () => {
  const h = await fixture(false, true), rpc = h.remote!.endpoint.rpc.bind(h.remote!.endpoint), requestId = randomUUID()
  vi.spyOn(h.remote!.endpoint, 'rpc').mockImplementation(async (principal, input, proof) => {
    const request = input as { op: string; requestId?: string }
    if (request.op === 'job.spawn' && request.requestId === requestId) throw new RemoteError(409, 'stale_revision', 'Grant revision changed before dispatch')
    return rpc(principal, input, proof)
  })
  await h.verification.request(h.artifact.id, { requestId, artifactHash: h.artifact.hash, artifactRevision: h.artifact.revision,
    check: { id: h.checked.definition.id, version: 1 } })
  await vi.waitFor(() => expect(h.verification.get(requestId)).toMatchObject({ status: 'failed', quiescent: true, problem: 'Grant revision changed before dispatch' }))
  expect(await h.verification.refresh(requestId)).toEqual(h.verification.get(requestId))
  expect(h.remote!.endpoint.journal.jobs().some(job => job.id === requestId)).toBe(false)
})
