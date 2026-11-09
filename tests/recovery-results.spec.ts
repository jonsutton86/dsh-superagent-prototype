import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { verificationFixture } from './fixtures/verification.ts'
import { verifyResultState } from '../src/recovery/results.ts'
import { verifyWorkspaceState } from '../src/recovery/workspace.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import { fingerprint } from '../src/remote/journal.ts'
import type { Store } from '../src/app/store.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
const verify = (store: Store) => verifyResultState(store.db, new AbortController().signal)
function change(store: Store, table: string, id: string, update: (value: any) => void) {
  const value = JSON.parse(String(store.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)!.value)); update(value)
  store.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), id)
}

it('preserves actual artifact bytes, check evidence, review captures and completed mission authority without rerunning work', async () => {
  const h = await verificationFixture(cleanup), artifact = await h.artifact(), checked = await h.check(artifact)
  const mission = h.ready(), action = mission.actions[0]!
  const accepted = await h.workspace.actReviewed(mission.id, action.id, { requestId: randomUUID(), revision: mission.revision,
    command: 'complete', text: 'Reviewed original evidence', ticketRevision: action.ticket!.revision, reviewKind: 'checks', checks: [checked.selection] })
  const finished = await h.workspace.updateReviewed(accepted.id, { requestId: randomUUID(), revision: accepted.revision, status: 'completed' })
  const before = recoveryStateDigest(h.store.db), result = await verify(h.store)
  expect(result).toMatchObject({ artifacts: 1, blobs: 1, checks: 1, checkVersions: 1, runs: 3, successfulRuns: 3, reviews: 2, completions: 1 })
  expect(await verify(h.store)).toEqual(result); expect(recoveryStateDigest(h.store.db)).toBe(before)
  await verifyWorkspaceState(h.store.db, new AbortController().signal)
  const reviewId = finished.completion!.actions[0]!.reviewId!, old = h.reviews.get(reviewId)
  await h.reviews.prepare({ id: reviewId, purpose: old.purpose, target: old.target, checks: old.checks })
  expect(h.reviews.get(reviewId).attempts[0]!.evidence).toEqual(old.evidence)
  expect(await verify(h.store)).toMatchObject({ runs: 4, reviews: 2, completions: 1, legacyReviewSeals: 0 })
})

it('refuses substituted bytes, provenance, check requests, snapshots, seals and receipt history without changing state', async () => {
  const h = await verificationFixture(cleanup), memory = h.library.publish({ requestId: randomUUID(), kind: 'memory', title: 'Original source', summary: 'Source', content: 'Original source' })
  h.library.publish({ requestId: randomUUID(), kind: 'memory', title: 'Derived source', summary: 'Derived', content: 'Derived source', sources: [{ id: memory.id, relation: 'derived_from' }] })
  const artifact = await h.artifact(), checked = await h.check(artifact, [process.execPath, '-e', 'process.stdout.write("original output")'])
  const review = { id: randomUUID(), purpose: 'acceptance', target: fingerprint('result'), checks: [checked.selection] }
  await h.reviews.prepare(review)
  const mutations = [
    () => h.store.db.prepare('UPDATE workspace_blob SET data=? WHERE hash=?').run(Buffer.from('corrupted'), artifact.hash),
    () => h.store.db.prepare('UPDATE workspace_library SET scope=? WHERE id=?').run('workspace', artifact.id),
    () => h.store.db.exec('DELETE FROM workspace_library_edge'),
    () => h.store.db.exec('DELETE FROM workspace_library_search'),
    () => h.store.db.prepare('DELETE FROM workspace_library_command WHERE record=?').run(artifact.id),
    () => change(h.store, 'workspace_library', artifact.id, value => { value.provenance.assignmentId = 'unrelated-assignment' }),
    () => change(h.store, 'workspace_library', artifact.id, value => { delete value.filename }),
    () => change(h.store, 'verification_check', checked.definition.id, value => { value.enabled = false }),
    () => h.store.db.exec('DELETE FROM verification_check_command'),
    () => change(h.store, 'verification_run', checked.run.id, value => { value.request.argv = ['/bin/false'] }),
    () => change(h.store, 'verification_run', checked.run.id, value => { value.requestHash = '0'.repeat(64) }),
    () => change(h.store, 'verification_run', checked.run.id, value => { value.owner.ticketId = 'unrelated-ticket' }),
    () => change(h.store, 'verification_run', checked.run.id, value => { value.evidence.snapshot.entries[0].hash = '0'.repeat(64) }),
    () => change(h.store, 'verification_run', checked.run.id, value => { value.outcome.exitCode = 1 }),
    () => h.store.db.prepare('UPDATE verification_output SET data=? WHERE id=?').run(Buffer.from('changed output!'), checked.run.id),
    () => change(h.store, 'verification_review', review.id, value => { value.evidence[0].capture.id = checked.run.id }),
    () => change(h.store, 'verification_review', review.id, value => { value.evidence[0].validUntil = '2099-01-01T00:00:00.000Z' }),
    () => change(h.store, 'verification_review', review.id, value => { value.attempts[0].captures[0].checkId = 'missing-check' }),
  ]
  for (const mutate of mutations) {
    h.store.db.exec('SAVEPOINT corrupt_result')
    try { mutate(); const before = recoveryStateDigest(h.store.db); await expect(verify(h.store)).rejects.toThrow('recovery_results_'); expect(recoveryStateDigest(h.store.db)).toBe(before) }
    finally { h.store.db.exec('ROLLBACK TO corrupt_result; RELEASE corrupt_result') }
  }
  expect(await verify(h.store)).toMatchObject({ artifacts: 1, memories: 2, edges: 1 })
})

it('preserves a held review with an unsubmitted original capture and resumes only that capture identity', async () => {
  const h = await verificationFixture(cleanup), artifact = await h.artifact(), checked = await h.check(artifact)
  const input = { id: randomUUID(), purpose: 'acceptance', target: fingerprint('lost capture'), checks: [checked.selection] }
  const capture = vi.spyOn(h.verification, 'freshness').mockRejectedValueOnce(new Error('Interrupted before submission'))
  await expect(h.reviews.prepare(input)).rejects.toThrow('Interrupted')
  const held = h.reviews.get(input.id), original = held.attempts[0]!.captures[0]!.id, before = recoveryStateDigest(h.store.db)
  expect(await verify(h.store)).toMatchObject({ runs: 1, reviews: 1, successfulRuns: 1 }); expect(recoveryStateDigest(h.store.db)).toBe(before)
  capture.mockRestore(); const seals = await h.reviews.prepare(input)
  expect(seals[0]!.capture.id).toBe(original)
  expect(await verify(h.store)).toMatchObject({ runs: 2, reviews: 1, legacyReviewSeals: 0 })
})

it('validates original remote receipts and captured evidence through the actual endpoint', async () => {
  const h = await verificationFixture(cleanup, process.env.DSH_REMOTE_ISOLATION === '1', true), artifact = await h.artifact(), checked = await h.check(artifact)
  await h.reviews.prepare({ id: randomUUID(), purpose: 'publication', target: fingerprint('remote result'), checks: [checked.selection] })
  const before = recoveryStateDigest(h.store.db)
  expect(await verify(h.store)).toMatchObject({ runs: 2, successfulRuns: 2, reviews: 1, legacyBindings: 0 })
  expect(recoveryStateDigest(h.store.db)).toBe(before)
  change(h.store, 'verification_run', checked.run.id, value => { value.receipt.grantId = 'other-grant' })
  await expect(verify(h.store)).rejects.toThrow('receipt')
})

it('reports missing historical seal snapshots explicitly without manufacturing their evidence', async () => {
  const h = await verificationFixture(cleanup), artifact = await h.artifact(), checked = await h.check(artifact)
  const input = { id: randomUUID(), purpose: 'acceptance', target: fingerprint('legacy'), checks: [checked.selection] }
  await h.reviews.prepare(input)
  change(h.store, 'verification_review', input.id, value => { for (const attempt of value.attempts) { delete attempt.evidence; delete attempt.evidenceVersion } })
  const before = recoveryStateDigest(h.store.db)
  expect(await verify(h.store)).toMatchObject({ legacyReviewSeals: 1 }); expect(recoveryStateDigest(h.store.db)).toBe(before)
})

it('preserves explicitly unbound legacy artifacts and yields to cancellation with bounded diagnostics', async () => {
  const h = await verificationFixture(cleanup), artifact = await h.artifact()
  change(h.store, 'workspace_library', artifact.id, value => { delete value.execution })
  expect(await verify(h.store)).toMatchObject({ artifacts: 1, legacyBindings: 1 })
  for (let i = 0; i < 100; i++) h.library.publish({ requestId: randomUUID(), kind: 'memory', title: 'Cancellation fixture', summary: 'Bounded scan', content: 'Identical shared blob' })
  const controller = new AbortController(), before = recoveryStateDigest(h.store.db), pending = setImmediate(() => controller.abort())
  try { await expect(verifyResultState(h.store.db, controller.signal)).rejects.toThrow() } finally { clearImmediate(pending) }
  expect(recoveryStateDigest(h.store.db)).toBe(before)
  change(h.store, 'workspace_library', artifact.id, value => { value.extra = 'private-result'.repeat(700000) })
  await expect(verify(h.store)).rejects.toMatchObject({ code: 'limit', message: 'recovery_results_limit: workspace_library' })
})

it('retains historical approvals after expiry, archival, disabled checks and a later provider observation problem', async () => {
  const h = await verificationFixture(cleanup), artifact = await h.artifact(), checked = await h.check(artifact)
  const seals = await h.reviews.prepare({ id: randomUUID(), purpose: 'publication', target: fingerprint('historical destination'), checks: [checked.selection] })
  h.advance(120000); h.library.archive(artifact.id, { requestId: randomUUID(), revision: 1, archived: true })
  h.verification.definitions.configure(checked.definition.id, { requestId: randomUUID(), revision: 1, enabled: false, workers: false, reason: 'Retire check' })
  change(h.store, 'verification_run', checked.run.id, value => { value.problem = 'Later provider observation unavailable' })
  expect(h.reviews.current(seals)).toBe(false)
  const before = recoveryStateDigest(h.store.db)
  expect(await verify(h.store)).toMatchObject({ artifacts: 1, runs: 2, successfulRuns: 2, reviews: 1 })
  expect(recoveryStateDigest(h.store.db)).toBe(before)
})
