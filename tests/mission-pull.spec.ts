import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { missionPullFixture } from './fixtures/mission-pull.ts'
import { definitionOf } from '../src/workspace/plan-model.ts'
import { Verification } from '../src/verification/service.ts'
import { VerificationReviews } from '../src/verification/reviews.ts'
import { MissionReviews } from '../src/verification/missions.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const request = (revision: number) => ({ requestId: randomUUID(), revision, status: 'completed' as const })

it('binds an operator-inspected PR into the plan and worker authorization, then accepts only matching host checks', async () => {
  const h = await missionPullFixture(cleanup), { workspace, mission, action } = h
  expect(workspace.plans.version(mission.id, h.bound.planVersion).plan.actions[0]!.pull).toBe(h.bind.requestId)
  const trigger = h.store.triggers.get(h.ticket.origin.triggerId)!
  expect(trigger.meta.pull).toBe(h.bind.requestId); expect(trigger.text).toContain('acme/project PR #7')
  expect(() => workspace.act(mission.id, action.id, h.accept)).toThrow('reviewed acceptance route')
  const { pullHash, ...missing } = h.accept
  await expect(workspace.actReviewed(mission.id, action.id, missing)).rejects.toThrow('Inspect and approve')
  await expect(workspace.actReviewed(mission.id, action.id, { ...h.accept, pullHash: '0'.repeat(64) })).rejects.toThrow('changed since result review')
  const result = await workspace.actReviewed(mission.id, action.id, h.accept)
  expect(result.actions[0]).toMatchObject({ status: 'done', accepted: { basis: 'checks', pull: { target: h.bind.requestId, observation: { hash: h.pull.hash } } } })
  expect(h.publisher.posts).toBe(0)
  expect(await workspace.configurePull(mission.id, action.id, h.bind)).toEqual(workspace.get(mission.id))
})

it('recaptures all checked inputs and rereads the accepted head before whole-mission completion', async () => {
  const h = await missionPullFixture(cleanup), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept), command = request(accepted.revision)
  expect(() => h.workspace.update(accepted.id, command)).toThrow('reviewed mission completion route')
  const finished = await h.workspace.updateReviewed(accepted.id, command)
  expect(finished).toMatchObject({ status: 'completed', completed: 1, completion: { requestId: command.requestId } })
  const proof = finished.completion!.actions[0]!
  expect(proof.pull!.observation.hash).toBe(h.pull.hash)
  const evidence = h.reviews.get(proof.reviewId!).evidence!
  expect(evidence[0]!.capture.id).not.toBe(accepted.actions[0]!.accepted!.evidence![0]!.capture.id)
  expect(h.verification.get(evidence[0]!.capture.id).purpose).toBe('freshness')
  expect(h.reviews.get(proof.reviewId!).purpose).toBe('closure')
  expect(h.workspace.completions.get(command.requestId).status).toBe('completed')
  const count = h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n
  await h.workspace.updateReviewed(accepted.id, command)
  expect(h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n).toBe(count)
  expect(h.publisher.posts).toBe(0)
})

it('finds an unobserved local edit during completion and retains the original failed preparation', async () => {
  const h = await missionPullFixture(cleanup), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept), command = request(accepted.revision)
  await writeFile(join(h.source, 'dependency.txt'), 'changed after acceptance')
  expect(h.workspace.get(accepted.id).completed).toBe(1)
  await expect(h.workspace.updateReviewed(accepted.id, command)).rejects.toThrow()
  expect(h.workspace.get(accepted.id)).toMatchObject({ status: 'active', completed: 0 })
  expect(h.workspace.completions.get(command.requestId)).toMatchObject({ status: 'held', reviews: [{ actionId: h.action.id }] })
  expect(h.publisher.posts).toBe(0)
})

it('holds completion when the provider head advances, then marks the accepted result for review', async () => {
  const h = await missionPullFixture(cleanup), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept)
  h.publisher.pull.head.sha = '4'.repeat(40)
  await expect(h.workspace.updateReviewed(accepted.id, request(accepted.revision))).rejects.toThrow('changed since result review')
  expect(h.workspace.get(accepted.id)).toMatchObject({ status: 'active', completed: 0 })
  expect(h.workspace.get(accepted.id).actions[0]!.status).toBe('review')
  expect(h.publisher.posts).toBe(0)
})

it('includes every independently accepted checked action in the final mission proof', async () => {
  const h = await missionPullFixture(cleanup)
  let mission = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept)
  mission = h.workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Second checked result', instructions: 'Inspect the final artifact', owner: 'agent' })
  const actionId = mission.actions[1]!.id
  mission = h.workspace.act(mission.id, actionId, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
  const ticket = h.store.tickets.get(mission.actions[1]!.ticket!.id)!
  h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  const artifact = h.library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'Second result', summary: 'Independent checked result', filename: 'artifact.txt', content: 'evidence' }, { role: 'worker', ticketId: ticket.id })
  const checked = await h.check(artifact)
  h.engine.report(ticket.id, { state: 'ready', summary: 'Checked result ready' }); mission = h.workspace.get(mission.id)
  mission = await h.workspace.actReviewed(mission.id, actionId, { requestId: randomUUID(), revision: mission.revision, command: 'complete', text: 'Reviewed both results', ticketRevision: mission.actions[1]!.ticket!.revision, reviewKind: 'checks', checks: [checked.selection] })
  const closed = await h.workspace.updateReviewed(mission.id, request(mission.revision))
  expect(closed.completion!.actions).toHaveLength(2)
  expect(closed.completion!.actions.map(action => h.reviews.get(action.reviewId!).checks[0]!.runId).sort()).toEqual([h.checked.run.id, checked.run.id].sort())
  expect(closed.completion!.actions.every(action => action.checks === 1 && action.evidenceHash?.length === 64)).toBe(true)
})

it('refuses completion if the mission changes while fresh evidence is being prepared', async () => {
  const h = await missionPullFixture(cleanup), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept), command = request(accepted.revision)
  const original = h.reviews.prepare.bind(h.reviews)
  vi.spyOn(h.reviews, 'prepare').mockImplementationOnce(async input => {
    const seals = await original(input)
    h.workspace.add(accepted.id, { requestId: randomUUID(), revision: accepted.revision, title: 'Additional review', instructions: 'Review changed scope', owner: 'person' })
    return seals
  })
  await expect(h.workspace.updateReviewed(accepted.id, command)).rejects.toThrow('Mission changed')
  expect(h.workspace.get(accepted.id).status).toBe('active')
  expect(h.workspace.get(accepted.id).completion).toBeUndefined()
  expect(h.workspace.completions.get(command.requestId).status).toBe('held')
})

it('rechecks the provider after capture and refuses acceptance when the head moves during review', async () => {
  const h = await missionPullFixture(cleanup), original = h.reviews.prepare.bind(h.reviews)
  vi.spyOn(h.reviews, 'prepare').mockImplementationOnce(async input => {
    const evidence = await original(input); h.publisher.pull.head.sha = '4'.repeat(40); return evidence
  })
  await expect(h.workspace.actReviewed(h.mission.id, h.action.id, h.accept)).rejects.toThrow('changed since result review')
  expect(h.workspace.get(h.mission.id).actions[0]!.accepted).toBeUndefined()
})

it.each([false, true])('requires reacceptance of a changed PR state and rejects unmerged closure (merged=%s)', async merged => {
  const h = await missionPullFixture(cleanup), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept)
  h.publisher.pull.state = 'closed'; h.publisher.pull.merged = merged
  const observed = await h.workspace.inspectPull(accepted.id, h.action.id)
  expect(h.workspace.get(accepted.id).completed).toBe(0)
  const updated = { ...h.accept, requestId: randomUUID(), revision: accepted.revision, pullHash: observed.hash }
  if (!merged) await expect(h.workspace.actReviewed(accepted.id, h.action.id, updated)).rejects.toThrow('closed without merging')
  else {
    const reviewed = await h.workspace.actReviewed(accepted.id, h.action.id, updated)
    expect((await h.workspace.updateReviewed(accepted.id, request(reviewed.revision))).status).toBe('completed')
  }
})

it('recovers a held completion after restart with its original review IDs and refuses a competing replacement', async () => {
  const h = await missionPullFixture(cleanup), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept), command = request(accepted.revision)
  vi.spyOn(h.reviews, 'prepare').mockRejectedValueOnce(new Error('Capture acknowledgement unavailable'))
  await expect(h.workspace.updateReviewed(accepted.id, command)).rejects.toThrow('unavailable')
  const prior = h.workspace.completions.get(command.requestId)
  await expect(h.workspace.updateReviewed(accepted.id, request(accepted.revision))).rejects.toThrow('Resume original mission completion')
  await h.workspace.completions.stop()
  const reopened = h.reopenWorkspace(); cleanup.push(() => reopened.completions.stop())
  expect((await reopened.retryCompletion(command.requestId)).status).toBe('completed')
  expect(reopened.completions.get(command.requestId).reviews).toEqual(prior.reviews)
})

it('retains original unknown source captures under the original completion attempt after restart', async () => {
  const h = await missionPullFixture(cleanup), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept), command = request(accepted.revision)
  const original = h.reviews.prepare.bind(h.reviews)
  vi.spyOn(h.reviews, 'prepare').mockImplementationOnce(async input => { await original(input); throw new Error('Response interrupted') })
  await expect(h.workspace.updateReviewed(accepted.id, command)).rejects.toThrow('interrupted')
  const attempt = h.workspace.completions.get(command.requestId), reviewId = attempt.reviews[0]!.id, captureId = h.reviews.get(reviewId).evidence![0]!.capture.id
  await h.workspace.completions.stop(); await h.reviews.stop(); await h.verification.stop()
  const row = h.store.db.prepare('SELECT value FROM verification_run WHERE id=?').get(captureId)!, run = JSON.parse(String(row.value))
  run.status = 'running'; run.quiescent = false; run.evidence.stage = 'capturing'; delete run.evidence.finishedAt
  h.store.db.prepare('UPDATE verification_run SET value=? WHERE id=?').run(JSON.stringify(run), captureId)
  const verification = new Verification(h.verifyHost), reviews = new VerificationReviews({ ...h.reviewHost, verification })
  const reopened = h.reopenWorkspace(new MissionReviews(h.store, h.library, verification, reviews))
  cleanup.push(async () => { await reviews.stop(); await verification.stop(); await reopened.completions.stop() })
  const count = h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n
  await expect(reopened.retryCompletion(command.requestId)).rejects.toThrow('original freshness capture')
  expect(reopened.completions.get(command.requestId).reviews).toEqual(attempt.reviews)
  expect(reviews.get(reviewId).attempts[0]!.captures[0]!.id).toBe(captureId)
  expect(h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n).toBe(count)
})

it('marks pending and failed inspections as needing review, and drains inspections before shutdown', async () => {
  const h = await missionPullFixture(cleanup), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(h.publications, 'inspectPull').mockImplementationOnce(async () => { await held; throw new Error('Provider unavailable') })
  const inspection = h.workspace.inspectPull(accepted.id, h.action.id).catch(error => error)
  expect(h.workspace.get(accepted.id).completed).toBe(0)
  let stopped = false; const stopping = h.pulls.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  await expect(h.workspace.inspectPull(accepted.id, h.action.id)).rejects.toThrow('stopping')
  release(); expect(String(await inspection)).toContain('unavailable'); await stopping
  expect(h.pulls.state(h.bind.requestId).problem).toContain('observation failed')
  expect(h.workspace.get(accepted.id).completed).toBe(0)
})

it('does not overwrite a newer provider observation with a delayed older read', async () => {
  const h = await missionPullFixture(cleanup), original = h.publications.inspectPull.bind(h.publications)
  let release!: () => void, observed!: () => void
  const ready = new Promise<void>(resolve => { observed = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(h.publications, 'inspectPull').mockImplementationOnce(async (...args) => { const result = await original(...args); observed(); await held; return result })
  const delayed = h.workspace.inspectPull(h.mission.id, h.action.id); const outcome = delayed.catch(error => error)
  await ready; h.publisher.pull.head.sha = '4'.repeat(40)
  const newer = await h.workspace.inspectPull(h.mission.id, h.action.id); release()
  expect(String(await outcome)).toContain('newer PR inspection')
  expect(h.pulls.state(h.bind.requestId).observation).toEqual(newer)
  expect(h.pulls.state(h.bind.requestId).problem).toBeUndefined()
})

it('requires explicit rebinding for provider identity changes and invalidates dependent plans when the target changes', async () => {
  const h = await missionPullFixture(cleanup)
  h.publisher.pull.head.repo.id++
  await expect(h.workspace.inspectPull(h.mission.id, h.action.id)).rejects.toThrow('identity or branches changed')
  const latest = await h.publications.inspectPull(h.destination.id, h.destination.hash)
  let mission = h.workspace.get(h.mission.id)
  mission = h.workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Dependent result', owner: 'person', instructions: 'Review the final result', dependsOn: [h.action.id] })
  const rebound = await h.workspace.configurePull(mission.id, h.action.id, { ...h.bind, requestId: randomUUID(), revision: mission.revision, pullHash: latest.hash })
  expect(rebound.actions[0]!.status).toBe('outdated')
  expect(rebound.actions[1]!.definitionRevision).toBe(2)
  const invalid = definitionOf(rebound); invalid.actions[0]!.pull = 'missing-target'
  expect(() => h.workspace.applyPlan(rebound.id, rebound.revision, invalid, 'proposal')).toThrow('not found')
  expect(h.publisher.posts).toBe(0)
})

it.runIf(process.platform === 'linux' && process.env.DSH_REMOTE_ISOLATION === '1')('closes a PR-bound mission using actual native confined remote evidence', async () => {
  const h = await missionPullFixture(cleanup, true), accepted = await h.workspace.actReviewed(h.mission.id, h.action.id, h.accept)
  const closed = await h.workspace.updateReviewed(accepted.id, request(accepted.revision))
  expect(closed.status).toBe('completed'); expect(h.reviews.get(closed.completion!.actions[0]!.reviewId!).evidence![0]!.confinement).toBe('linux-bubblewrap')
}, 30000)
