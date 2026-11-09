import { randomUUID } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { verificationFixture } from './fixtures/verification.ts'
import { fingerprint } from '../src/remote/journal.ts'
import { VerificationReviews } from '../src/verification/reviews.ts'
import { Verification } from '../src/verification/service.ts'
import { FRESHNESS_WINDOW_MS } from '../src/verification/review-model.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
const rid = () => randomUUID()

it('groups checks of the same source into one capture, binds all selected evidence and never reruns check commands', async () => {
  const h = await verificationFixture(cleanup), a = await h.artifact(), b = await h.artifact('other.txt', 'other'), marker = join(h.directory, 'runs')
  const argv = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`]
  const first = await h.check(a, argv), second = await h.check(b, argv), input = { id: rid(), purpose: 'acceptance', target: fingerprint('result'), checks: [second.selection, first.selection] }
  const seals = await h.reviews.prepare(input)
  expect(seals).toHaveLength(2); expect(new Set(seals.map(seal => seal.capture.id)).size).toBe(1)
  expect(h.reviews.get(input.id)).toMatchObject({ status: 'ready', attempts: [{ captures: [expect.anything()] }] })
  const capture = h.verification.get(seals[0]!.capture.id)
  expect(capture).toMatchObject({ status: 'captured', purpose: 'freshness' }); expect(capture.outcome).toBeUndefined()
  expect(h.reviews.current(seals, true)).toBe(true); expect(await readFile(marker, 'utf8')).toBe('xx')
  h.advance(FRESHNESS_WINDOW_MS + 1)
  expect(h.reviews.current(seals, true)).toBe(false); expect(h.reviews.current(seals)).toBe(true)
  expect(() => h.reviews.assert(seals, input.checks)).toThrow('freshness')
  await expect(h.reviews.prepare({ ...input, target: fingerprint('another approval') })).rejects.toThrow('another approval')
})

it('holds changed sources, records a new capture on explicit retry and rejects substituted check evidence', async () => {
  const h = await verificationFixture(cleanup), artifact = await h.artifact(), checked = await h.check(artifact)
  const input = { id: rid(), purpose: 'publication', target: fingerprint('destination'), checks: [checked.selection] }
  await writeFile(join(h.source, 'dependency'), 'changed')
  await expect(h.reviews.prepare(input)).rejects.toThrow('reviewed snapshot')
  const held = h.reviews.get(input.id); expect(held.status).toBe('held'); expect(held.attempts).toHaveLength(1)
  const refreshed = await h.check(artifact)
  await expect(h.reviews.prepare({ ...input, checks: [refreshed.selection] })).rejects.toThrow('another approval')
  await expect(h.reviews.prepare({ ...input, id: rid(), checks: [{ ...refreshed.selection, evidenceHash: '0'.repeat(64) }] })).rejects.toThrow('evidence changed')
  const fresh = await h.reviews.prepare({ ...input, id: rid(), checks: [refreshed.selection] })
  expect(fresh[0]!.snapshotHash).toBe(refreshed.run.evidence!.snapshot!.hash)
  h.verification.definitions.configure(refreshed.definition.id, { requestId: rid(), revision: 1, enabled: false, workers: false, reason: 'Withdraw authority' })
  expect(h.reviews.current(fresh)).toBe(false)
})

it('preserves original unknown capture IDs across restart and refuses a replacement until quiescence is established', async () => {
  const h = await verificationFixture(cleanup), artifact = await h.artifact(), checked = await h.check(artifact)
  const input = { id: rid(), purpose: 'acceptance', target: fingerprint('result'), checks: [checked.selection] }
  const seals = await h.reviews.prepare(input), captureId = seals[0]!.capture.id
  await h.reviews.stop(); await h.verification.stop()
  const row = h.store.db.prepare('SELECT value FROM verification_run WHERE id=?').get(captureId)!, run = JSON.parse(String(row.value))
  run.status = 'running'; run.quiescent = false; run.evidence.stage = 'capturing'; delete run.evidence.finishedAt
  h.store.db.prepare('UPDATE verification_run SET value=? WHERE id=?').run(JSON.stringify(run), captureId)
  const verification = new Verification(h.verifyHost), reviews = new VerificationReviews({ ...h.reviewHost, verification })
  cleanup.push(async () => { await reviews.stop(); await verification.stop() })
  const count = h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n
  await expect(reviews.prepare(input)).rejects.toThrow('original freshness capture')
  expect(reviews.get(input.id).attempts[0]!.captures[0]!.id).toBe(captureId)
  expect(h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n).toBe(count)
  expect(reviews.get(input.id).status).toBe('held')
})

it('requires selected checks for every artifact, commits acceptance atomically and invalidates known source changes', async () => {
  const h = await verificationFixture(cleanup), a = await h.artifact(), b = await h.artifact('other.txt', 'other')
  const first = await h.check(a), second = await h.check(b), mission = h.ready(), action = mission.actions[0]!
  const input = { requestId: rid(), revision: mission.revision, command: 'complete', text: 'Reviewed the actual artifacts', ticketRevision: action.ticket!.revision,
    reviewKind: 'checks', checks: [first.selection, second.selection] }
  expect(() => h.workspace.act(mission.id, action.id, { ...input, checks: [] })).toThrow('every current artifact')
  expect(() => h.workspace.act(mission.id, action.id, input)).toThrow('reviewed acceptance route')
  await expect(h.workspace.actReviewed(mission.id, action.id, { ...input, checks: [first.selection] })).rejects.toThrow('Every current artifact')
  const accepted = await h.workspace.actReviewed(mission.id, action.id, input)
  expect(accepted.actions[0]).toMatchObject({ status: 'done', accepted: { basis: 'checks', evidence: expect.any(Array) } })
  const captures = h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n
  h.advance(FRESHNESS_WINDOW_MS + 1)
  expect((await h.workspace.actReviewed(mission.id, action.id, input)).actions[0]!.accepted).toEqual(accepted.actions[0]!.accepted)
  expect(h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n).toBe(captures)
  // Fresh capture timestamps come from the actual host clock; the historical-expiry probe above is complete.
  h.advance(-FRESHNESS_WINDOW_MS - 1)
  const complete = await h.workspace.updateReviewed(mission.id, { requestId: rid(), revision: accepted.revision, status: 'completed' })
  expect(complete.completed).toBe(1)
  await writeFile(join(h.source, 'changed.txt'), 'source changed after historical acceptance')
  const changed = await h.verification.freshness(first.run.id, rid()); expect((await h.settled(changed.id)).status).toBe('failed')
  expect(h.workspace.get(mission.id)).toMatchObject({ completed: 0, needsReview: true })
})

it('rejects concurrent mission changes after capture and explicitly labels human review of a result without artifacts', async () => {
  const h = await verificationFixture(cleanup), artifact = await h.artifact(), checked = await h.check(artifact), mission = h.ready(), action = mission.actions[0]!
  const prepare = h.reviews.prepare.bind(h.reviews)
  vi.spyOn(h.reviews, 'prepare').mockImplementationOnce(async input => {
    const seals = await prepare(input)
    h.workspace.add(mission.id, { requestId: rid(), revision: mission.revision, title: 'New review', instructions: 'Changed mission', owner: 'person' })
    return seals
  })
  await expect(h.workspace.actReviewed(mission.id, action.id, { requestId: rid(), revision: mission.revision, command: 'complete', text: 'Reviewed',
    ticketRevision: action.ticket!.revision, reviewKind: 'checks', checks: [checked.selection] })).rejects.toThrow('Mission changed')
  expect(h.workspace.get(mission.id).actions[0]!.accepted).toBeUndefined()
  const manual = await verificationFixture(cleanup), result = manual.ready(), target = result.actions[0]!
  const input = { requestId: rid(), revision: result.revision, command: 'complete', text: 'Personally reviewed the answer', ticketRevision: target.ticket!.revision }
  await expect(manual.workspace.actReviewed(result.id, target.id, input)).rejects.toThrow('explicitly acknowledge')
  expect((await manual.workspace.actReviewed(result.id, target.id, { ...input, reviewKind: 'operator' })).actions[0])
    .toMatchObject({ status: 'done', accepted: { basis: 'operator' } })
})
