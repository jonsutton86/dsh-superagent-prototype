import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { definitionOf, type PlanDefinition } from '../src/workspace/plan-model.ts'
import { verifyWorkspaceState } from '../src/recovery/workspace.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import { scheduleDefinition, workspaceStateFixture, workspaceTime } from './fixtures/workspace-state.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-workspace-state-')), store = new Store(join(directory, 'state.sqlite'))
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const f = workspaceStateFixture(store), { workspace, engine } = f
  const create = () => {
    const mission = workspace.create({ requestId: randomUUID(), title: 'Product recovery', objective: 'Complete the requested work', acceptance: 'Reviewed result' })
    return workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Prepare result', instructions: 'Only the original instructions', owner: 'agent' })
  }
  const run = (missionId: string, index = 0) => {
    const mission = workspace.get(missionId)
    const result = workspace.act(missionId, mission.actions[index]!.id, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
    return store.tickets.get(result.actions[index]!.runs.at(-1)!)!
  }
  const ready = (ticketId: string) => {
    const ticket = store.tickets.get(ticketId)!
    engine.assignmentStarted(ticketId, ticket.assignments.at(-1)!.id); engine.report(ticketId, { state: 'ready', summary: 'Original work completed' })
  }
  const review = (missionId: string, plan: PlanDefinition, ticketId?: string) => {
    const mission = workspace.get(missionId), proposal = workspace.plans.propose(missionId,
      { requestId: randomUUID(), baseVersion: mission.planVersion, rationale: 'Operator-reviewed change', plan }, ticketId)
    if (ticketId) ready(ticketId)
    workspace.plans.review(missionId, proposal.id, { requestId: randomUUID(), revision: proposal.revision,
      missionRevision: workspace.get(missionId).revision, decision: 'approve', note: 'Reviewed the complete plan' })
    return proposal
  }
  return { ...f, create, run, ready, review, verify: (signal = new AbortController().signal) => verifyWorkspaceState(store.db, signal) }
}
function change(store: Store, table: string, field: string, identity: string | number, modify: (value: any) => void) {
  const row = store.db.prepare(`SELECT value FROM ${table} WHERE ${field}=?`).get(identity)!
  const value = JSON.parse(String(row.value)); modify(value)
  store.db.prepare(`UPDATE ${table} SET value=? WHERE ${field}=?`).run(JSON.stringify(value), identity)
}

it('preserves current, superseded and removed action authority, including a worker-authored approved plan', async () => {
  const f = fixture(), mission = f.create(), ticket = f.run(mission.id)
  const original = f.workspace.plans.version(mission.id, mission.planVersion)
  expect(original.authority).toEqual([{ actionId: mission.actions[0]!.id, definitionRevision: 1 }])
  expect(f.store.triggers.get(ticket.origin.triggerId)!.meta.planVersion).toBe(mission.planVersion)
  const replacement = { ...definitionOf(mission), actions: [{ id: 'new-step', title: 'New step', instructions: 'A separate approved step', owner: 'agent' as const, dependsOn: [] }] }
  const proposal = f.review(mission.id, replacement, ticket.id), current = f.workspace.get(mission.id), second = f.run(current.id)
  expect(current.actions[0]!.id).not.toBe('new-step')
  const before = recoveryStateDigest(f.store.db), result = await f.verify()
  expect(result).toMatchObject({ missions: 1, planVersions: 3, proposals: 1, executions: 2, legacyPlanVersions: 0, legacyTriggers: 0 })
  expect(recoveryStateDigest(f.store.db)).toBe(before); expect(await f.verify()).toEqual(result)
  expect(f.store.tickets.get(ticket.id)?.mandate.scope).toBe('Only the original instructions')
  expect(f.store.tickets.get(second.id)?.mandate.scope).toBe('A separate approved step')
  expect(f.workspace.plans.proposal(mission.id, proposal.id).author.role).toBe('worker')
})

it('records a no-op PR removal that invalidates an action without changing its instruction text', async () => {
  const f = fixture(), mission = f.create(), old = f.run(mission.id); f.ready(old.id)
  const current = f.workspace.get(mission.id)
  await f.workspace.configurePull(mission.id, current.actions[0]!.id, { requestId: randomUUID(), revision: current.revision, enabled: false })
  const newer = f.run(mission.id), version = f.workspace.plans.version(mission.id, f.workspace.get(mission.id).planVersion)
  expect(version.authority![0]!.definitionRevision).toBe(2)
  expect(newer.mandate.scope).toBe(old.mandate.scope)
  expect(await f.verify()).toMatchObject({ executions: 2, legacyPlanVersions: 0, legacyTriggers: 0 })
})

it('keeps pending and rejected proposals as candidates and rejects substituted approval evidence', async () => {
  const f = fixture(), mission = f.create(), plan = definitionOf(mission)
  const propose = () => f.workspace.plans.propose(mission.id, { requestId: randomUUID(), baseVersion: mission.planVersion, rationale: 'Candidate', plan })
  const pending = propose(), rejected = propose()
  f.workspace.plans.review(mission.id, rejected.id, { requestId: randomUUID(), revision: 1,
    missionRevision: mission.revision, decision: 'reject', note: 'Keep the current plan' })
  const before = recoveryStateDigest(f.store.db)
  expect(await f.verify()).toMatchObject({ proposals: 2, executions: 0, planVersions: 2 })
  expect(recoveryStateDigest(f.store.db)).toBe(before)
  change(f.store, 'workspace_plan_proposal', 'id', pending.id, value => {
    value.status = 'approved'; value.revision = 2; value.review = { at: workspaceTime, note: 'Forged approval', version: 3 }
  })
  await expect(f.verify()).rejects.toMatchObject({ code: 'reference' })
})

it('preserves explicit human follow-up routing without treating it as a second scheduled dispatch', async () => {
  const f = fixture(), mission = f.create(), original = f.run(mission.id)
  f.engine.assignmentStarted(original.id, original.assignments[0]!.id)
  f.workspace.act(mission.id, mission.actions[0]!.id, { requestId: 'followup-request', revision: f.workspace.get(mission.id).revision,
    command: 'steer', text: 'Handle this related question separately' })
  f.engine.handback(original.id, 'workspace-message:followup-request', 'A separate request')
  f.engine.decide('workspace-message:followup-request', { kind: 'accept', title: 'Follow-up question', scope: 'Answer the new explicit question', reason: 'Human follow-up' })
  expect(await f.verify()).toMatchObject({ executions: 2, routedExecutions: 1, scheduledExecutions: 0 })
})

it.each(['all', 'latest', 'skip'] as const)('preserves %s missed-run reservations and the exact next occurrence', async missed => {
  const f = fixture(), saved = f.schedules.create({ requestId: randomUUID(), enabled: true, definition: scheduleDefinition({ missed }) })
  f.time('2026-11-09T17:10:00.000Z'); f.schedules.tick()
  const before = recoveryStateDigest(f.store.db), state = f.schedules.get(saved.id), result = await f.verify()
  expect(result).toMatchObject({ schedules: 1, scheduleVersions: 1, occurrences: state.occurrences.length, scheduledExecutions: state.runs })
  expect(recoveryStateDigest(f.store.db)).toBe(before); expect(await f.verify()).toEqual(result)
  if (missed === 'skip') expect(state.runs).toBe(0)
  else expect(state.runs).toBe(1)
})

it('keeps pause/resume cursors and old occurrence templates across a schedule edit', async () => {
  const f = fixture(), saved = f.schedules.create({ requestId: randomUUID(), enabled: true, definition: scheduleDefinition() })
  f.schedules.toggle(saved.id, { requestId: randomUUID(), revision: 1, enabled: false }); f.schedules.tick()
  expect(await f.verify()).toMatchObject({ occurrences: 0, scheduleVersions: 2 })
  f.schedules.toggle(saved.id, { requestId: randomUUID(), revision: 2, enabled: true }); f.schedules.tick()
  const old = f.schedules.get(saved.id).occurrences[0]!, original = f.workspace.get(old.missionId!)
  const next = scheduleDefinition({ cadence: { kind: 'interval', start: '2026-11-09T19:00:00.000Z', everyMinutes: 60 } })
  next.plan.actions[0]!.instructions = 'Later approved instructions'
  f.schedules.update(saved.id, { requestId: randomUUID(), revision: 3, enabled: true, definition: next })
  f.time('2026-11-09T19:00:00.000Z'); f.schedules.tick()
  expect(await f.verify()).toMatchObject({ schedules: 1, scheduleVersions: 4, occurrences: 2, scheduledExecutions: 2 })
  expect(f.workspace.get(original.id).actions[0]!.instructions).toBe('Report the recorded progress')
  const before = recoveryStateDigest(f.store.db); await f.verify(); expect(recoveryStateDigest(f.store.db)).toBe(before)
})

it('rejects a hole in reserved occurrences even when the run counter is changed to hide the missing record', async () => {
  const f = fixture(), saved = f.schedules.create({ requestId: randomUUID(), enabled: true, definition: scheduleDefinition() })
  for (const time of [workspaceTime, '2026-11-09T15:00:00.000Z', '2026-11-09T16:00:00.000Z']) { f.time(time); f.schedules.tick() }
  expect(await f.verify()).toMatchObject({ occurrences: 3, scheduledExecutions: 3 })
  const middle = f.schedules.get(saved.id).occurrences.find(item => item.due === '2026-11-09T15:00:00.000Z')!
  f.store.db.prepare('DELETE FROM workspace_occurrence WHERE id=?').run(middle.id)
  change(f.store, 'workspace_schedule', 'id', saved.id, value => { value.runs-- })
  await expect(f.verify()).rejects.toThrow('occurrence_sequence')
})

it('preserves exhausted one-time cursors and calendar cursors across daylight-saving changes', async () => {
  const f = fixture(), once = f.schedules.create({ requestId: randomUUID(), enabled: true,
    definition: scheduleDefinition({ cadence: { kind: 'once', at: workspaceTime } }) })
  f.schedules.tick(); expect(f.schedules.get(once.id).nextAt).toBeUndefined()
  const calendar = f.schedules.create({ requestId: randomUUID(), enabled: true, definition: scheduleDefinition({ cadence: {
    kind: 'calendar', timeZone: 'America/New_York', startDate: '2026-03-08', time: '02:30', weekdays: [1, 2, 3, 4, 5, 6, 7],
  } }) })
  f.time('2026-03-08T07:30:00.000Z'); f.schedules.tick()
  expect(f.schedules.get(calendar.id).nextAt).toBe('2026-03-09T06:30:00.000Z')
  const before = recoveryStateDigest(f.store.db)
  expect(await f.verify()).toMatchObject({ schedules: 2, occurrences: 2, scheduledExecutions: 2 })
  expect(recoveryStateDigest(f.store.db)).toBe(before)
})

it('refuses corrupted plans, grants, run counters, cursors, schedule origins and execution bindings without mutation', async () => {
  const f = fixture(), schedule = f.schedules.create({ requestId: randomUUID(), enabled: true, definition: scheduleDefinition() })
  f.schedules.tick()
  const occurrence = f.schedules.get(schedule.id).occurrences[0]!, mission = f.workspace.get(occurrence.missionId!), ticket = f.store.tickets.get(mission.actions[0]!.runs[0]!)!
  const mutations = [
    () => change(f.store, 'workspace_mission', 'id', mission.id, value => { value.actions[0].instructions = 'Substituted instructions' }),
    () => change(f.store, 'workspace_mission', 'id', mission.id, value => { value.actions[0].definitionRevision = 99 }),
    () => change(f.store, 'workspace_mission', 'id', mission.id, value => { value.schedule.revision++ }),
    () => change(f.store, 'workspace_plan_version', 'mission', mission.id, value => { value.authority[0].definitionRevision++ }),
    () => change(f.store, 'workspace_schedule', 'id', schedule.id, value => { value.runs = 0 }),
    () => change(f.store, 'workspace_schedule', 'id', schedule.id, value => { value.nextAt = workspaceTime }),
    () => change(f.store, 'workspace_schedule', 'id', schedule.id, value => { value.nextAt = '2026-11-09T18:00:00.000Z' }),
    () => change(f.store, 'workspace_schedule_version', 'schedule', schedule.id, value => { value.enabled = false }),
    () => change(f.store, 'workspace_occurrence', 'id', occurrence.id, value => { value.revision++ }),
    () => change(f.store, 'workspace_occurrence', 'id', occurrence.id, value => { value.missionId = randomUUID() }),
    () => change(f.store, 'trigger', 'id', ticket.origin.triggerId, value => { value.meta.planVersion = 999 }),
    () => change(f.store, 'trigger', 'id', ticket.origin.triggerId, value => { value.meta.actionRevision = 99 }),
    () => change(f.store, 'trigger', 'id', ticket.origin.triggerId, value => { value.meta.scheduleRevision = 99 }),
    () => change(f.store, 'ticket', 'id', ticket.id, value => { value.mandate.scope = 'Unapproved work' }),
    () => change(f.store, 'ticket', 'id', ticket.id, value => { value.mandate.basis.sender = 'other-operator' }),
  ]
  for (const mutate of mutations) {
    f.store.db.exec('SAVEPOINT corrupt_product')
    try {
      mutate(); const before = recoveryStateDigest(f.store.db)
      await expect(f.verify()).rejects.toThrow('recovery_workspace_')
      expect(recoveryStateDigest(f.store.db)).toBe(before)
    } finally { f.store.db.exec('ROLLBACK TO corrupt_product; RELEASE corrupt_product') }
  }
  expect(await f.verify()).toMatchObject({ scheduledExecutions: 1 })
})

it('retains legacy plan and dispatch records without inventing exact revision stamps', async () => {
  const f = fixture(), mission = f.create(); f.run(mission.id)
  for (const row of f.store.db.prepare('SELECT mission,version,value FROM workspace_plan_version').all()) {
    const value = JSON.parse(String(row.value)); delete value.authority
    f.store.db.prepare('UPDATE workspace_plan_version SET value=? WHERE mission=? AND version=?').run(JSON.stringify(value), String(row.mission), Number(row.version))
  }
  for (const row of f.store.db.prepare('SELECT id,value FROM trigger').all()) change(f.store, 'trigger', 'id', String(row.id), value => { delete value.meta.planVersion })
  for (const row of f.store.db.prepare('SELECT id FROM ticket').all()) change(f.store, 'ticket', 'id', String(row.id), value => { delete value.mandate.basis.scope.planVersion })
  for (const row of f.store.db.prepare('SELECT id FROM decision').all()) change(f.store, 'decision', 'id', String(row.id), value => { if (value.mandate) delete value.mandate.basis.scope.planVersion })
  const before = recoveryStateDigest(f.store.db)
  expect(await f.verify()).toMatchObject({ executions: 1, legacyPlanVersions: 2, legacyTriggers: 1 })
  expect(recoveryStateDigest(f.store.db)).toBe(before)
})

it('yields to cancellation and bounds serialized product records without exposing their content', async () => {
  const f = fixture()
  for (let i = 0; i < 100; i++) f.create()
  const before = recoveryStateDigest(f.store.db), controller = new AbortController(), pending = setImmediate(() => controller.abort())
  try { await expect(f.verify(controller.signal)).rejects.toThrow() } finally { clearImmediate(pending) }
  expect(recoveryStateDigest(f.store.db)).toBe(before)
  const mission = f.workspace.list().items[0]!
  change(f.store, 'workspace_mission', 'id', mission.id, value => { value.extra = 'private-content'.repeat(600000) })
  await expect(f.verify()).rejects.toMatchObject({ code: 'limit', message: 'recovery_workspace_limit: workspace_mission' })
})
