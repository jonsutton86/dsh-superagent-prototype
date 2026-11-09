import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, type Executor } from '../src/core/index.ts'
import { settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Workspace } from '../src/workspace/service.ts'
import { Schedules } from '../src/workspace/schedules.ts'
import { occurrenceAt } from '../src/workspace/cadence.ts'
import type { Cadence, ScheduleDefinition } from '../src/workspace/schedule-model.ts'
import { startRuntime } from './fixtures/host.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const start = '2026-11-09T14:00:00.000Z'
const plan = { title: 'Daily review', objective: 'Review project progress', acceptance: 'Evidence reviewed by the operator',
  actions: [{ id: 'review', title: 'Review progress', instructions: 'Produce a referenced progress summary', owner: 'agent' as const, dependsOn: [] as string[] }] }
const definition = (overrides: Partial<ScheduleDefinition> = {}): ScheduleDefinition => ({ title: 'Daily review',
  cadence: { kind: 'interval', start, everyMinutes: 60 }, plan, missed: 'all', graceSeconds: 60, maxRuns: 3, maxOpen: 1, ...overrides })
function fixture(path?: string) {
  const directory = path ?? mkdtempSync(join(tmpdir(), 'agentic-schedules-')), store = new Store(join(directory, 'state.sqlite'))
  let at = Date.parse(start), runnable = true, closed = false, engine: Engine
  const workspace = new Workspace(store, () => engine, () => runnable), sources = new SourceRegistry(() => store.settings())
  sources.register(workspace.source)
  const started = vi.fn(), executor: Executor = { start: (ticket, assignment) => store.afterCommit(() => started(ticket, assignment)), deliver: vi.fn(), stop: vi.fn() }
  engine = new Engine({ repo: store, scope: sources, policy: () => workspace.policy(settingsPolicy(store.settings(), sources)), executor,
    now: () => new Date(at).toISOString(), assessor: { request: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const schedules = new Schedules(store, workspace, () => runnable, () => at)
  const close = () => { if (!closed) { closed = true; store.close() } }
  cleanup.push(() => { close(); if (!path) rmSync(directory, { recursive: true, force: true }) })
  return { directory, close, store, workspace, schedules, engine, started, time: (value: string) => { at = Date.parse(value) }, pause: (value = true) => { runnable = !value },
    create: (overrides: Partial<ScheduleDefinition> = {}) => schedules.create({ requestId: 'create', enabled: true, definition: definition(overrides) }) }
}

it('handles daylight saving gaps and repeated times once per local date, independent of host timezone', () => {
  const cadence: Cadence = { kind: 'calendar', timeZone: 'America/New_York', startDate: '2026-03-01', time: '02:30', weekdays: [1, 2, 3, 4, 5, 6, 7] }
  const next = (time: string) => occurrenceAt(cadence, Date.parse(time), 1)
  expect(next('2026-03-08T00:00:00Z')).toBe('2026-03-08T07:30:00.000Z')
  expect(next('2026-03-08T07:30:00.001Z')).toBe('2026-03-09T06:30:00.000Z')
  cadence.time = '01:30'
  expect(next('2026-11-01T00:00:00Z')).toBe('2026-11-01T05:30:00.000Z')
  expect(next('2026-11-01T05:30:00.001Z')).toBe('2026-11-02T06:30:00.000Z')
  expect(occurrenceAt(cadence, Date.parse('2026-11-01T06:45:00Z'), -1)).toBe('2026-11-01T05:30:00.000Z')
  cadence.weekdays = [1]; cadence.timeZone = 'Asia/Kathmandu'; cadence.time = '09:00'
  expect(next('2026-11-09T00:00:00Z')).toBe('2026-11-09T03:15:00.000Z')
})

it('reserves and dispatches once across SQLite reopen, preserves limits and attributes standing authorization', () => {
  const f = fixture(), schedule = f.create()
  f.schedules.tick(); f.schedules.tick()
  const first = f.schedules.get(schedule.id), mission = f.workspace.get(first.occurrences[0]!.missionId!)
  expect(first.runs).toBe(1); expect(f.started).toHaveBeenCalledOnce()
  const ticket = f.store.tickets.list()[0]!, trigger = f.store.triggers.get(ticket.origin.triggerId)!
  expect(trigger.human).toBe(false); expect(trigger.meta).toMatchObject({ schedule: schedule.id, scheduleRevision: 1 })
  expect(ticket.mandate.strength).toBe('explicit'); expect(mission.schedule?.occurrence).toBe(first.occurrences[0]!.id)
  f.close()
  const g = fixture(f.directory); g.time('2026-11-09T18:00:00Z'); g.schedules.tick()
  expect(g.started).not.toHaveBeenCalled(); expect(g.schedules.get(schedule.id).runs).toBe(1)
  expect(g.schedules.get(schedule.id).open).toBe(1)
  expect(g.schedules.create({ requestId: 'create', enabled: true, definition: definition() }).id).toBe(schedule.id)
  expect(() => g.schedules.create({ requestId: 'create', enabled: false, definition: definition() })).toThrow('already used')
})

it.each(['skip', 'latest', 'all'] as const)('implements the %s missed-run policy without an unbounded replay loop', missed => {
  const f = fixture(), schedule = f.create({ missed, maxOpen: 20, maxRuns: 100 })
  f.time('2036-11-09T14:05:00Z'); f.schedules.tick()
  const result = f.schedules.get(schedule.id)
  expect(result.runs).toBe(missed === 'skip' ? 0 : 1)
  const occurrence = result.occurrences.find(item => item.state === 'active')
  if (missed === 'latest') expect(occurrence?.due).toBe('2036-11-09T14:00:00.000Z')
  if (missed === 'all') expect(occurrence?.due).toBe(start)
  if (missed !== 'all') expect(result.occurrences.find(item => item.state === 'skipped')?.through).toBeDefined()
  expect(f.started.mock.calls.length).toBeLessThanOrEqual(1)
})

it('allows the latest skip-policy occurrence within its grace window and never runs early', () => {
  const f = fixture(), schedule = f.create({ missed: 'skip' })
  f.time('2026-11-09T13:59:59Z'); f.schedules.tick(); expect(f.started).not.toHaveBeenCalled()
  f.time('2026-11-09T16:00:20Z'); f.schedules.tick()
  expect(f.schedules.get(schedule.id).occurrences.find(item => item.state === 'active')?.due).toBe('2026-11-09T16:00:00.000Z')
})

it('pauses without spending budget or advancing the cursor and retains original snapshots on edits', () => {
  const f = fixture(), created = f.create()
  f.pause(); f.schedules.tick(); expect(f.schedules.get(created.id)).toMatchObject({ nextAt: start, runs: 0 })
  f.pause(false)
  const paused = f.schedules.toggle(created.id, { requestId: 'pause', revision: 1, enabled: false })
  f.schedules.tick(); expect(f.started).not.toHaveBeenCalled()
  expect(() => f.schedules.toggle(created.id, { requestId: 'stale', revision: 1, enabled: true })).toThrow('changed')
  f.time('2026-11-09T15:00:00Z')
  const updated = f.schedules.update(created.id, { requestId: 'edit', revision: paused.revision, enabled: true,
    definition: definition({ title: 'Revised', plan: { ...plan, objective: 'New objective' } }) })
  f.schedules.tick()
  expect(f.schedules.version(created.id, 1).definition.plan.objective).toBe(plan.objective)
  expect(f.schedules.get(created.id).occurrences[0]).toMatchObject({ revision: updated.revision, due: '2026-11-09T15:00:00.000Z' })
})

it('requires reviewed dependencies, preserves human actions, and releases an open slot only after acceptance', () => {
  const f = fixture(), schedule = f.create({ plan: { ...plan, actions: [
    { id: 'approval', title: 'Confirm scope', instructions: 'Review scope', owner: 'person', dependsOn: [] },
    { ...plan.actions[0]!, dependsOn: ['approval'] },
  ] } })
  f.schedules.tick(); expect(f.started).not.toHaveBeenCalled()
  const id = f.schedules.get(schedule.id).occurrences[0]!.missionId!
  let mission = f.workspace.get(id)
  mission = f.workspace.act(id, mission.actions[0]!.id, { requestId: 'approval', revision: mission.revision, command: 'complete', text: 'Scope checked' })
  f.schedules.tick(); expect(f.started).toHaveBeenCalledOnce()
  const ticket = f.store.tickets.list()[0]!
  f.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id); f.engine.report(ticket.id, { state: 'ready', summary: 'Summary ready for review' })
  f.time('2026-11-09T16:00:00Z'); f.schedules.tick(); expect(f.schedules.get(schedule.id).runs).toBe(1)
  mission = f.workspace.get(id)
  f.workspace.act(id, mission.actions[1]!.id, { requestId: 'review', revision: mission.revision, command: 'complete', text: 'Evidence checked', ticketRevision: mission.actions[1]!.ticket!.revision })
  f.schedules.tick()
  expect(f.schedules.get(schedule.id).runs).toBe(2)
  expect(f.schedules.get(schedule.id).occurrences.find(item => item.missionId === id)?.state).toBe('complete')
  expect(f.started).toHaveBeenCalledOnce() // The next occurrence waits for its own human action.
})

it('rolls back partial dispatch, persists a blocked reservation, and resumes it without charging a second run', () => {
  const f = fixture(), schedule = f.create(), original = f.workspace.runScheduled.bind(f.workspace)
  const failure = vi.spyOn(f.workspace, 'runScheduled').mockImplementation((...args) => { original(...args); throw new Error('synthetic failed transaction') })
  f.schedules.tick()
  let state = f.schedules.get(schedule.id)
  expect(state.runs).toBe(1); expect(state.occurrences[0]?.state).toBe('blocked'); expect(state.occurrences[0]?.missionId).toBeUndefined()
  expect(f.store.tickets.list()).toHaveLength(0); expect(f.workspace.list().items).toHaveLength(0); expect(f.started).not.toHaveBeenCalled()
  failure.mockRestore()
  f.schedules.retry(schedule.id, state.occurrences[0]!.id, { requestId: 'retry' }); f.schedules.tick()
  state = f.schedules.get(schedule.id)
  expect(state.runs).toBe(1); expect(f.started).toHaveBeenCalledOnce(); expect(state.occurrences[0]!.missionId).toBeTruthy()
})

it('never automatically repeats stopped work or dispatches a changed occurrence plan', () => {
  const f = fixture(), schedule = f.create(); f.schedules.tick()
  const id = f.schedules.get(schedule.id).occurrences[0]!.missionId!, mission = f.workspace.get(id)
  f.workspace.act(id, mission.actions[0]!.id, { requestId: 'stop', revision: mission.revision, command: 'stop' })
  f.schedules.tick(); expect(f.started).toHaveBeenCalledOnce()
  f.workspace.add(id, { requestId: 'added', revision: f.workspace.get(id).revision, title: 'Unscheduled work', instructions: 'Requires fresh dispatch', owner: 'agent' })
  f.schedules.tick()
  expect(f.schedules.get(schedule.id).occurrences[0]?.state).toBe('blocked'); expect(f.started).toHaveBeenCalledOnce()
})

it('enforces a lifetime run budget even when overlap slots are free', () => {
  const f = fixture(), schedule = f.create({ maxRuns: 2, maxOpen: 20 })
  f.time('2026-11-09T19:00:00Z')
  for (let i = 0; i < 10; i++) f.schedules.tick()
  expect(f.schedules.get(schedule.id).runs).toBe(2); expect(f.started).toHaveBeenCalledTimes(2)
})

it('rejects invalid zones, empty plans, injected fields and malformed cadence definitions', () => {
  const f = fixture()
  expect(() => f.create({ cadence: { kind: 'calendar', timeZone: 'Invalid/Zone', startDate: '2026-11-09', time: '09:00', weekdays: [1] } })).toThrow('valid calendar')
  expect(() => f.create({ plan: { ...plan, actions: [] } })).toThrow('at least one')
  expect(() => f.schedules.create({ requestId: 'x', definition: definition(), enabled: true, runs: -1 })).toThrow()
  expect(() => f.create({ cadence: { kind: 'interval', start, everyMinutes: 0 } })).toThrow()
})

it('uses management routes and the real Runtime pass while preserving global pause', async () => {
  const h = await startRuntime(); cleanup.push(() => h.stop())
  const response = await h.api('POST', 'schedules', { requestId: 'runtime-schedule', enabled: true,
    definition: definition({ cadence: { kind: 'once', at: new Date(Date.now() - 1000).toISOString() } }) })
  expect(response.status).toBe(200)
  const id = (response.body as { id: string }).id
  await h.api('POST', 'executor/pause', { paused: true }); await h.runtime.pump()
  expect(h.runtime.schedules.get(id).runs).toBe(0)
  await h.api('POST', 'executor/pause', { paused: false }); await h.runtime.pump(); await h.runtime.idle()
  expect(h.runtime.schedules.get(id).runs).toBe(1)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect((await h.api('GET', `schedules/${id}/versions/1`)).status).toBe(200)
})
