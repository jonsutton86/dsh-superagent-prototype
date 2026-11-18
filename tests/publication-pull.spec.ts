import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { pullReviewFixture } from './fixtures/pull-review.ts'
import { Publications } from '../src/publication/runtime.ts'
import type { Publication, PublicationRpc } from '../src/publication/protocol.ts'
import { PublicationClient } from '../src/publication/client.ts'
import { GithubPullPublication } from '../src/publication/github-pull.ts'
import { matchesPullEvidence } from '../src/publication/pull-model.ts'
import { verifyPublicationState } from '../src/recovery/publications.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

it.each([['APPROVE', 'APPROVED'], ['COMMENT', 'COMMENTED'], ['REQUEST_CHANGES', 'CHANGES_REQUESTED']] as const)('submits %s for the inspected fork commit using actual host-captured Git evidence', async (event, state) => {
  const h = await pullReviewFixture(cleanup, event), result = await h.publications.publish(h.artifact.id, h.approval)
  expect(result.receipt).toMatchObject({ phase: 'sent', pull: h.pull.binding, external: { review: { commit: h.git('rev-parse', 'HEAD'), state } } })
  expect(result.receipt!.artifact!.evidence![0]!.repository).toMatchObject({ contentTree: h.git('rev-parse', 'HEAD^{tree}') })
  expect(h.publisher.reviews[0]!.commit_id).toBe(h.pull.binding.head.sha)
  expect(h.publisher.reviews[0]!.body).toContain(`Reviewed commit: \`${h.pull.binding.head.sha}\``)
  expect(h.publisher.posts).toBe(1)
  await expect(h.publications.publish(h.artifact.id, { ...h.approval, requestId: randomUUID() })).rejects.toThrow('already has a publication')
  expect(JSON.stringify(result)).not.toContain(h.publisher.secret)
  expect(await verifyPublicationState(h.store.db, new AbortController().signal, true)).toMatchObject({ checkedArtifacts: 1, pullReviews: 1, seals: 1, sent: 1 })
})

it('requires inspected head consent and rejects checks with a different tree even if Git status is clean', async () => {
  const h = await pullReviewFixture(cleanup), { pullHash, ...unbound } = h.approval
  await expect(h.publications.publish(h.artifact.id, unbound)).rejects.toThrow('Inspect the PR head')
  await expect(h.publications.publish(h.artifact.id, { ...h.approval, checks: [] })).rejects.toThrow('host checks')
  h.git('update-index', '--assume-unchanged', 'dependency.txt'); await writeFile(join(h.source, 'dependency.txt'), 'hidden change')
  expect(h.git('status', '--porcelain')).toBe('')
  const dirty = await h.check(h.artifact)
  await expect(h.publications.publish(h.artifact.id, { ...h.approval, checks: [dirty.selection] })).rejects.toThrow('captured Git tree')
  const binding = h.verification.approval(h.checked.run.id)
  expect(matchesPullEvidence({ repository: { commit: binding.repository!.commit, tree: binding.repository!.tree } }, h.pull.binding)).toBe(false)
  expect(h.publisher.posts).toBe(0)
})

it('refuses a moved head before approval and before final dispatch, without a provider POST', async () => {
  const h = await pullReviewFixture(cleanup), original = h.publisher.pull.head.sha
  h.publisher.pull.head.sha = '4'.repeat(40)
  await expect(h.publications.publish(h.artifact.id, h.approval)).rejects.toThrow('changed since inspection')
  h.publisher.pull.head.sha = original
  const prepare = GithubPullPublication.prototype.prepare
  vi.spyOn(GithubPullPublication.prototype, 'prepare').mockImplementation(async function(this: GithubPullPublication, ...args) {
    const result = await prepare.apply(this, args); h.publisher.pull.head.sha = '4'.repeat(40); return result
  })
  expect((await h.publications.publish(h.artifact.id, h.approval)).receipt?.phase).toBe('failed')
  expect(h.publisher.posts).toBe(0)
})

it('keeps the explicit approved commit when a push races with the provider POST', async () => {
  const h = await pullReviewFixture(cleanup); let release!: () => void
  h.publisher.hold(new Promise<void>(resolve => { release = resolve }))
  const pending = h.publications.publish(h.artifact.id, h.approval)
  try { await vi.waitFor(() => expect(h.publisher.posts).toBe(1)); h.publisher.pull.head.sha = '4'.repeat(40) }
  finally { release() }
  expect((await pending).receipt?.phase).toBe('sent')
  expect(h.publisher.reviews[0]!.commit_id).toBe(h.pull.binding.head.sha)
})

it('recovers the original dismissed review after restart, archival and head changes without another capture or POST', async () => {
  const h = await pullReviewFixture(cleanup); h.publisher.loseProviderReply()
  expect((await h.publications.publish(h.artifact.id, h.approval)).receipt?.phase).toBe('unknown')
  const review = h.reviews.get(h.approval.requestId)
  h.publisher.reviews[0]!.state = 'DISMISSED'; h.publisher.pull.head.sha = '4'.repeat(40); h.publisher.pull.state = 'closed'
  h.library.archive(h.artifact.id, { requestId: randomUUID(), revision: h.artifact.revision, archived: true })
  await h.publications.stop(); await h.publisher.restart()
  const recovered = new Publications(h.host); cleanup.push(() => recovered.stop())
  const result = await recovered.retry(h.approval.requestId)
  expect(result.receipt).toMatchObject({ phase: 'sent', external: { review: { state: 'DISMISSED', commit: h.pull.binding.head.sha } } })
  expect(h.reviews.get(h.approval.requestId)).toEqual(review); expect(h.publisher.posts).toBe(1)
})

it('permits a separately checked new head after a completed review and never retargets an old held approval', async () => {
  const h = await pullReviewFixture(cleanup)
  const prepare = h.reviews.prepare.bind(h.reviews)
  vi.spyOn(h.reviews, 'prepare').mockRejectedValueOnce(new Error('Capture unavailable'))
  const held = await h.publications.publish(h.artifact.id, h.approval); expect(held.phase).toBe('held')
  vi.spyOn(h.reviews, 'prepare').mockImplementation(prepare)
  const sent = await h.publications.publish(h.artifact.id, { ...h.approval, requestId: randomUUID() }); expect(sent.receipt?.phase).toBe('sent')
  await writeFile(join(h.source, 'dependency'), 'new revision'); h.commit()
  const checked = await h.check(h.artifact), pull = await h.publications.inspectPull(h.destination.id, h.destination.hash)
  expect((await h.publications.publish(h.artifact.id, { ...h.approval, requestId: randomUUID(), checks: [checked.selection], pullHash: pull.hash })).receipt?.phase).toBe('sent')
  expect((await h.publications.retry(held.id)).phase).toBe('held'); expect(h.publisher.posts).toBe(2)
})

it('independently rejects message subjects, absent or mismatched repository proof, and expired evidence', async () => {
  const h = await pullReviewFixture(cleanup), seals = await h.reviews.prepare({ id: randomUUID(), purpose: 'publication', target: h.pull.hash, checks: h.approval.checks })
  const publication: Publication = { id: randomUUID(), destination: h.destination.id, destinationHash: h.destination.hash, hash: h.artifact.hash,
    text: 'evidence', pull: h.pull.binding, artifact: { id: h.artifact.id, revision: h.artifact.revision, hash: h.artifact.hash, basis: 'checks', evidence: seals } }
  for (const change of [undefined, { ...seals[0]!.repository!, contentTree: '0'.repeat(40) }]) {
    await expect(h.publisher.client.call({ op: 'publish', publication: { ...publication, artifact: { ...publication.artifact!, evidence: [{ ...seals[0]!, repository: change }] } } })).rejects.toThrow('captured Git tree')
  }
  await expect(h.publisher.client.call({ op: 'publish', publication: { ...publication, artifact: undefined,
    message: { id: randomUUID(), missionId: randomUUID(), ticketId: randomUUID(), grantId: randomUUID(), planVersion: 1 } } })).rejects.toThrow('host checks')
  await expect(h.publisher.client.call({ op: 'publish', publication: { ...publication, artifact: { ...publication.artifact!, evidence: [{ ...seals[0]!, validUntil: new Date(0).toISOString() }] } } })).rejects.toThrow('expired')
  expect(h.publisher.posts).toBe(0)
})

it.each(['account', 'repository', 'commit', 'closed', 'draft', 'merged'] as const)('refuses %s changes before review delivery', async change => {
  const h = await pullReviewFixture(cleanup)
  if (change === 'account') h.publisher.login('another-account')
  else if (change === 'repository') h.publisher.pull.base.repo.id++
  else if (change === 'commit') h.publisher.tree('4'.repeat(40))
  else if (change === 'closed') h.publisher.pull.state = 'closed'
  else h.publisher.pull[change] = true
  await expect(h.publications.publish(h.artifact.id, h.approval)).rejects.toThrow()
  expect(h.publisher.posts).toBe(0)
})

it('blocks replacement on a new head while the original review outcome remains unknown', async () => {
  const h = await pullReviewFixture(cleanup); h.publisher.unavailable()
  expect((await h.publications.publish(h.artifact.id, h.approval)).receipt?.phase).toBe('unknown')
  await writeFile(join(h.source, 'dependency.txt'), 'new revision'); h.commit()
  const checked = await h.check(h.artifact), pull = await h.publications.inspectPull(h.destination.id, h.destination.hash)
  await expect(h.publications.publish(h.artifact.id, { ...h.approval, requestId: randomUUID(), checks: [checked.selection], pullHash: pull.hash }))
    .rejects.toThrow('already has a publication')
  expect((await h.publications.refresh(h.approval.requestId)).receipt?.phase).toBe('unknown')
  expect(h.publisher.posts).toBe(1)
})

it('requires the independent publisher capability and live ownership for PR inspection', async () => {
  const h = await pullReviewFixture(cleanup), call = PublicationClient.prototype.call
  const spy = vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const response = await call.call(this, request, signal)
    return request.op === 'identity' ? { ...response as object, capabilities: { artifactEvidence: true } } as T : response as T
  })
  await expect(h.publications.publish(h.artifact.id, h.approval)).rejects.toThrow('Inspect the PR head')
  spy.mockRestore(); await h.owner.close()
  await expect(h.publisher.client.call({ op: 'pull.inspect', destination: h.destination.id, destinationHash: h.destination.hash })).rejects.toThrow()
  expect(h.publisher.posts).toBe(0)
})

it.runIf(process.platform === 'linux' && process.env.DSH_REMOTE_ISOLATION === '1')('binds a native confined remote check and original-world capture to the PR head', async () => {
  const h = await pullReviewFixture(cleanup, 'APPROVE', true), result = await h.publications.publish(h.artifact.id, h.approval)
  expect(result.receipt).toMatchObject({ phase: 'sent', pull: h.pull.binding })
  expect(result.verification!.evidence![0]).toMatchObject({ confinement: 'linux-bubblewrap', repository: { contentTree: h.pull.binding.head.tree } })
  expect(h.publisher.posts).toBe(1)
}, 30000)
