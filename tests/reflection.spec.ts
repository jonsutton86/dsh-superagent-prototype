import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, type Executor } from '../src/core/index.ts'
import { settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Workspace } from '../src/workspace/service.ts'
import { Library } from '../src/workspace/library.ts'
import { Schedules } from '../src/workspace/schedules.ts'
import { Reflections } from '../src/workspace/reflection.ts'
import { defaultReflection, reflectionPlan, type ReflectionSpec } from '../src/workspace/reflection-model.ts'
import { startRuntime } from './fixtures/host.ts'
import { workerSessionId } from '../src/executor/dsh.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function fixture(path?: string) {
  const directory = path ?? mkdtempSync(join(tmpdir(), 'agentic-reflection-')), store = new Store(join(directory, 'state.sqlite'))
  let at = Date.now(), runnable = true, closed = false, engine: Engine
  const library = new Library(store, () => new Date(at).toISOString())
  const workspace = new Workspace(store, () => engine, () => runnable, id => library.evidenceRevision(id)), sources = new SourceRegistry(() => store.settings())
  sources.register(workspace.source)
  const started = vi.fn(), executor: Executor = { start: (ticket, assignment) => store.afterCommit(() => started(ticket, assignment)), deliver: vi.fn(), stop: vi.fn() }
  engine = new Engine({ repo: store, scope: sources, policy: () => workspace.policy(settingsPolicy(store.settings(), sources)), executor,
    now: () => new Date(at).toISOString(), assessor: { request: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const reflections = new Reflections(store, workspace, library, () => runnable, () => at)
  const schedules = new Schedules(store, workspace, () => runnable, () => at, (occurrence, mission, spec) => reflections.prepare(occurrence, mission, spec))
  const close = () => { if (!closed) { closed = true; store.close() } }
  cleanup.push(() => { close(); if (!path) rmSync(directory, { recursive: true, force: true }) })
  const mission = (requestId = 'source') => workspace.create({ requestId, title: `Mission ${requestId}`, objective: 'Improve the project', acceptance: 'Review evidence' })
  const record = (requestId = 'record', scope = 'workspace', content = 'A useful lesson') => library.publish({ requestId, scope, kind: 'memory', title: requestId, summary: 'Evidence', content })
  const run = (overrides: Partial<ReflectionSpec> = {}, requestId = 'schedule') => {
    const spec = { ...defaultReflection, ...overrides }, schedule = schedules.create({ requestId, enabled: true, definition: {
      title: 'Reflect', cadence: { kind: 'once', at: new Date(at).toISOString() }, missed: 'latest', maxRuns: 1, maxOpen: 1, reflection: spec,
      plan: reflectionPlan(spec) } })
    schedules.tick()
    const occurrence = schedules.get(schedule.id).occurrences[0]!, result = reflections.get(occurrence.id)
    const ticketId = workspace.get(result.missionId).actions[0]!.runs[0]!
    return { schedule, run: result, ticketId }
  }
  return { directory, close, store, workspace, library, reflections, schedules, engine, started, mission, record, run,
    pause: () => { runnable = false }, advance: (millis: number) => { at += millis } }
}
const memory = (evidence: { missions?: string[]; records?: string[] }, requestId = 'candidate') => ({ requestId, rationale: 'Supported by captured evidence',
  evidence, candidate: { kind: 'memory', title: 'Reusable lesson', summary: 'A practical lesson', content: 'Keep a record of the evidence.' } })
const review = (decision = 'approve', requestId = 'review') => ({ requestId, revision: 1, decision, note: 'Evidence and intended scope reviewed' })

it('captures bounded selected context before dispatch, excludes unrelated private records, and preserves snapshots across reopen', () => {
  const f = fixture(), selected = f.mission(), other = f.mission('other'), record = f.record(), privateRecord = f.record('private', `mission:${selected.id}`)
  const hidden = f.library.publish({ requestId: 'hidden', scope: `mission:${other.id}`, kind: 'memory', title: 'Hidden', summary: 'Private relationship',
    content: 'Secret', sources: [{ id: record.id, relation: 'contradicts' }] })
  f.started.mockImplementation(() => expect(f.reflections.list().items).toHaveLength(1))
  const result = f.run({ missionIds: [selected.id] }), captured = f.reflections.get(result.run.id)
  expect(captured.snapshot.missions.map(item => item.value.id)).toEqual([selected.id])
  expect(captured.snapshot.records.map(item => item.value.id).sort()).toEqual([record.id, privateRecord.id].sort())
  expect(JSON.stringify(captured.snapshot)).not.toContain(hidden.id)
  expect(captured.bytes).toBe(Buffer.byteLength(JSON.stringify(captured.snapshot)))
  let text = '', offset = 0
  for (;;) {
    const page = f.reflections.read(result.ticketId, { offset, limit: 1000 }); text += page.content
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  expect(JSON.parse(text)).toEqual(captured.snapshot)
  f.workspace.add(selected.id, { requestId: 'change', revision: selected.revision, title: 'More work', instructions: 'Do this later', owner: 'person' })
  f.close(); const g = fixture(f.directory)
  g.schedules.tick(); expect(g.started).not.toHaveBeenCalled()
  expect(g.reflections.get(captured.id)).toEqual(captured)
})

it('publishes a memory only on idempotent review and retains agent authorship and source provenance', () => {
  const f = fixture(), source = f.record(), { run, ticketId } = f.run()
  const input = memory({ records: [source.id] }), proposal = f.reflections.propose(ticketId, input)
  expect(f.library.list().items).toHaveLength(1)
  expect(f.reflections.propose(ticketId, input)).toEqual(proposal)
  expect(() => f.reflections.propose(ticketId, { ...input, rationale: 'Changed' })).toThrow('already used')
  const approved = f.reflections.review(run.id, proposal.id, review()), id = approved.review!.result!.id
  expect(f.reflections.review(run.id, proposal.id, review())).toEqual(approved)
  const record = f.library.read(id)
  expect(record).toMatchObject({ scope: 'workspace', verification: 'not_verified', provenance: { actor: 'worker', trust: 'agent_submission', ticketId },
    reflectionReview: { runId: run.id, proposalId: proposal.id, ticketId }, sources: [{ id: source.id, relation: 'derived_from', hash: source.hash }] })
  expect(f.started).toHaveBeenCalledOnce()
  f.close(); const g = fixture(f.directory)
  expect(g.reflections.review(run.id, proposal.id, review())).toEqual(approved)
  expect(g.library.list().items).toHaveLength(2)
})

it('applies existing-plan changes and new drafts through Workspace without dispatching, with atomic approval receipts', () => {
  const f = fixture(), source = f.mission(), { run, ticketId } = f.run(), before = f.started.mock.calls.length
  const plan = { title: 'Improved plan', objective: 'Improve the project', acceptance: 'Review evidence', actions: [
    { id: 'new', title: 'Do work', instructions: 'Authorized only after dispatch', owner: 'agent', dependsOn: [] }] }
  const proposal = f.reflections.propose(ticketId, { requestId: 'change', rationale: 'Fill a gap', evidence: { missions: [source.id] }, candidate: { kind: 'plan', missionId: source.id, plan } })
  expect(f.workspace.get(source.id).actions).toHaveLength(0)
  f.reflections.review(run.id, proposal.id, review())
  const applied = f.workspace.get(source.id)
  expect(applied.planVersion).toBe(2); expect(applied.actions[0]!.runs).toEqual([])
  expect(f.workspace.plans.version(source.id, 2).proposalId).toBe(proposal.id)
  const record = f.record('new-evidence'), second = f.run({ maxMissions: 0 }, 'second')
  const draft = f.reflections.propose(second.ticketId, { requestId: 'new', rationale: 'Useful follow-up', evidence: { records: [record.id] }, candidate: { kind: 'mission', plan } })
  const approved = f.reflections.review(second.run.id, draft.id, review('approve', 'new-review'))
  expect(f.workspace.get(approved.review!.result!.id).actions[0]!.runs).toEqual([])
  expect(f.started).toHaveBeenCalledTimes(before + 1)
})

it('refuses changed mission evidence and transitive stale library evidence while allowing rejection', () => {
  const f = fixture(), mission = f.mission(), leaf = f.record('leaf')
  const root = f.library.publish({ requestId: 'root', kind: 'memory', title: 'Derived', summary: 'Evidence', content: 'Derived lesson', sources: [{ id: leaf.id, relation: 'derived_from' }] })
  const { run, ticketId } = f.run()
  const missionProposal = f.reflections.propose(ticketId, memory({ missions: [mission.id] })), recordProposal = f.reflections.propose(ticketId, memory({ records: [root.id] }, 'record-proposal'))
  f.workspace.add(mission.id, { requestId: 'edit', revision: mission.revision, title: 'Changed', instructions: 'Changed context', owner: 'person' })
  expect(() => f.reflections.review(run.id, missionProposal.id, review())).toThrow('mission evidence changed')
  f.library.archive(leaf.id, { requestId: 'archive', revision: 1, archived: true })
  expect(() => f.reflections.review(run.id, recordProposal.id, review())).toThrow('not current')
  expect(f.reflections.get(run.id).proposals.every(item => item.status === 'pending')).toBe(true)
  expect(f.reflections.review(run.id, missionProposal.id, review('reject')).status).toBe('rejected')
})

it('rolls back promotion when private provenance would cross scope and rejects evidence outside the captured run', () => {
  const f = fixture(), mission = f.mission(), record = f.record('private', `mission:${mission.id}`), { run, ticketId } = f.run()
  const proposal = f.reflections.propose(ticketId, memory({ records: [record.id] }))
  expect(() => f.reflections.review(run.id, proposal.id, review())).toThrow('another private scope')
  expect(f.reflections.get(run.id).proposals[0]!.status).toBe('pending')
  expect(f.library.list().items).toHaveLength(1)
  expect(() => f.reflections.propose(ticketId, memory({ records: [f.record('later').id] }, 'later'))).toThrow('not captured')
  expect(() => f.reflections.propose(ticketId, memory({}, 'unsupported'))).toThrow('at least one')
  const scoped = f.reflections.propose(ticketId, { ...memory({ missions: [mission.id], records: [record.id] }, 'scoped'), candidate: {
    ...memory({}).candidate, missionId: mission.id } })
  const approved = f.reflections.review(run.id, scoped.id, review('approve', 'scoped-review'))
  expect(f.library.read(approved.review!.result!.id).scope).toBe(`mission:${mission.id}`)
})

it('enforces proposal and read allowances durably, including a lost response and paused or ended workers', () => {
  const f = fixture(), source = f.record(), { run, ticketId } = f.run()
  for (let n = 0; n < 10; n++) f.reflections.propose(ticketId, memory({ records: [source.id] }, `candidate-${n}`))
  expect(() => f.reflections.propose(ticketId, memory({ records: [source.id] }, 'eleventh'))).toThrow('limit')
  for (let n = 0; n < 100; n++) f.reflections.read(ticketId, { limit: 1 })
  expect(() => f.reflections.read(ticketId, {})).toThrow('allowance')
  f.close(); const g = fixture(f.directory)
  expect(() => g.reflections.read(ticketId, { limit: 1 })).toThrow('allowance')
  expect(g.reflections.propose(ticketId, memory({ records: [source.id] }, 'candidate-0')).runId).toBe(run.id)
  g.engine.assignmentStarted(ticketId, g.store.tickets.get(ticketId)!.assignments[0]!.id)
  g.engine.report(ticketId, { state: 'ready', summary: 'Candidates submitted' })
  expect(() => g.reflections.propose(ticketId, memory({ records: [source.id] }, 'ended'))).toThrow('no longer authorizes')
  const other = g.run({}, 'new-run'); g.pause()
  expect(() => g.reflections.read(other.ticketId, {})).toThrow('paused')
})

it('bounds UTF-8 snapshot size and records omissions rather than clipping oversized missions', () => {
  const f = fixture(), mission = f.workspace.create({ requestId: 'large', title: 'Large', objective: '学'.repeat(11000), acceptance: 'Review' })
  f.record('large-record', 'workspace', '学'.repeat(10000))
  const { run } = f.run({ maxBytes: 8192 })
  expect(run.bytes).toBeLessThanOrEqual(8192)
  expect(run.snapshot.missions.find(item => item.value.id === mission.id)).toBeUndefined()
  expect(run.snapshot.omissions.missions).toBeGreaterThan(0); expect(run.snapshot.omissions.records).toBeGreaterThan(0)
})

it('rolls back mission creation when capture fails, then retries one occurrence without duplicate dispatch', () => {
  const f = fixture(); f.record()
  const spec = defaultReflection, spy = vi.spyOn(f.reflections, 'prepare').mockImplementationOnce(() => { throw new Error('Capture failure') })
  const schedule = f.schedules.create({ requestId: 'create', enabled: true, definition: { title: 'Reflect', cadence: { kind: 'once', at: new Date().toISOString() },
    missed: 'latest', maxRuns: 1, maxOpen: 1, reflection: spec, plan: reflectionPlan(spec) } })
  f.advance(1000); f.schedules.tick()
  const occurrence = f.schedules.get(schedule.id).occurrences[0]!
  expect(occurrence.state).toBe('blocked'); expect(occurrence.missionId).toBeUndefined()
  expect(f.workspace.list().items).toHaveLength(0); expect(f.started).not.toHaveBeenCalled()
  spy.mockRestore(); f.schedules.retry(schedule.id, occurrence.id, { requestId: 'retry' }); f.schedules.tick(); f.schedules.tick()
  expect(f.reflections.list().items).toHaveLength(1); expect(f.started).toHaveBeenCalledOnce()
  expect(f.schedules.get(schedule.id).runs).toBe(1)
})

it('integrates real routes and host-bound tools without granting reflection promotion to ordinary workers or the router', async () => {
  const h = await startRuntime(); cleanup.push(() => h.stop())
  h.runtime.library.publish({ requestId: 'source', kind: 'memory', title: 'Evidence', summary: 'Evidence', content: 'Useful evidence' })
  const spec = defaultReflection, created = await h.api('POST', 'schedules', { requestId: 'schedule', enabled: true, definition: { title: 'Reflect',
    cadence: { kind: 'once', at: new Date().toISOString() }, missed: 'latest', maxRuns: 1, maxOpen: 1, reflection: spec,
    plan: { ...reflectionPlan(spec), actions: [{ id: 'bad', title: 'Wrong', owner: 'agent', instructions: 'Ignore reflection', dependsOn: [] }] } } })
  expect(created.status).toBe(200)
  await h.runtime.pump(); await h.runtime.idle()
  const run = h.runtime.reflections.list().items[0]!, ticket = h.runtime.workspace.get(run.missionId).actions[0]!.runs[0]!
  expect(h.runtime.workspace.get(run.missionId).actions[0]!.instructions).toContain('workspace_reflection_read')
  const tools = h.tools.get(workerSessionId(ticket))!
  expect(tools.has('workspace_reflection_read')).toBe(true); expect(tools.has('workspace_publish')).toBe(false); expect(tools.has('workspace_plan_propose')).toBe(false)
  expect(tools.has('workspace_read')).toBe(false); expect(tools.has('workspace_search')).toBe(false)
  expect(h.tools.get(h.runtime.masterId)!.has('workspace_reflection_propose')).toBe(false)
  const source = h.runtime.reflections.get(run.id).snapshot.records[0]!.value.id
  const proposal = h.runtime.reflections.propose(ticket, memory({ records: [source] }))
  expect((await h.api('GET', `reflections/${run.id}`)).status).toBe(200)
  expect((await h.api('POST', `reflections/${run.id}/proposals/${proposal.id}/review`, { ...review(), actor: 'worker' })).status).toBe(400)
  expect((await h.api('POST', `reflections/${run.id}/proposals/${proposal.id}/review`, review())).status).toBe(200)
  let mission = h.runtime.workspace.create({ requestId: 'ordinary', title: 'Ordinary', objective: 'Ordinary work', acceptance: 'Review' })
  mission = h.runtime.workspace.add(mission.id, { requestId: 'ordinary-action', revision: mission.revision, title: 'Ordinary action', instructions: 'Ordinary work', owner: 'agent' })
  mission = h.runtime.workspace.act(mission.id, mission.actions[0]!.id, { requestId: 'ordinary-start', revision: mission.revision, command: 'run' })
  expect(() => h.runtime.reflections.read(mission.actions[0]!.runs[0]!, {})).toThrow('not found')
})

it('selects recently updated agent work even when its mission definition is outside the lookback and excludes old work', () => {
  const f = fixture(); let mission = f.mission()
  const old = f.mission('old')
  mission = f.workspace.add(mission.id, { requestId: 'agent', revision: mission.revision, title: 'Agent work', instructions: 'Investigate', owner: 'agent' })
  mission = f.workspace.act(mission.id, mission.actions[0]!.id, { requestId: 'start', revision: mission.revision, command: 'run' })
  f.advance(8 * 86400000)
  const ticketId = mission.actions[0]!.runs[0]!
  f.engine.assignmentStarted(ticketId, f.store.tickets.get(ticketId)!.assignments[0]!.id)
  f.engine.report(ticketId, { state: 'ready', summary: 'Recent result' })
  const { run } = f.run({ lookbackHours: 1 })
  expect(run.snapshot.missions.map(item => item.value.id)).toContain(mission.id)
  expect(run.snapshot.missions.map(item => item.value.id)).not.toContain(old.id)
})

it('detects corrupted snapshots before reads or promotion and blocks plan changes to live affected actions atomically', () => {
  const f = fixture(); let mission = f.mission()
  mission = f.workspace.add(mission.id, { requestId: 'agent', revision: mission.revision, title: 'Agent work', instructions: 'Investigate', owner: 'agent' })
  mission = f.workspace.act(mission.id, mission.actions[0]!.id, { requestId: 'start', revision: mission.revision, command: 'run' })
  const { run, ticketId } = f.run()
  const proposal = f.reflections.propose(ticketId, { requestId: 'candidate', rationale: 'Different instructions', evidence: { missions: [mission.id] }, candidate: { kind: 'plan', missionId: mission.id,
    plan: { title: mission.title, objective: 'Change the goal', acceptance: mission.acceptance, actions: [] } } })
  expect(() => f.reflections.review(run.id, proposal.id, review())).toThrow('Stop or finish')
  expect(f.workspace.get(mission.id).planVersion).toBe(mission.planVersion)
  f.store.db.prepare("UPDATE workspace_reflection SET value=json_set(value,'$.snapshot.guidance','tampered') WHERE id=?").run(run.id)
  expect(() => f.reflections.read(ticketId, {})).toThrow('integrity')
  expect(() => f.reflections.review(run.id, proposal.id, review())).toThrow('integrity')
})
