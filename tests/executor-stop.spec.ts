import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { Ticket } from '../src/core/index.ts'
import { ExecutorStops } from '../src/executor/stops.ts'
import { readStop, saveStop, stopDigest, stopExecutionDigest, stopScopeDigest, validateStopAuthority } from '../src/executor/stop-store.ts'
import { KV } from '../src/kv.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
class StopRegistry extends Service {
  constructor(ctx: Context, name: string, api: object) { super(ctx, name); Object.assign(this, api) }
}
function fixture(admitted = true, scoped = false) {
  const root = mkdtempSync(join(tmpdir(), 'agentic-stop-')), path = join(root, 'state.sqlite')
  const store = new Store(path), effects = new Effects(store, new HealthBoard())
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const at = '2026-01-01T00:00:00.000Z'
  const ticket = { id: 'task', title: 'Original task', createdAt: at, updatedAt: at, inputs: [], undelivered: [],
    assignments: [{ id: 'original', state: 'running', createdAt: at, startedAt: at, execution: { directory: '/original', mode: 'local' } }] } as unknown as Ticket
  store.tickets.save(ticket)
  const agent = { id: 'worker-task', status: 'idle', session: {}, cancel: vi.fn(), whenIdle: async () => {} } as unknown as Agent
  const agents = new Map<string, Agent>([[agent.id, agent]])
  const rows: { id: string; owner: string; status: string }[] = []
  const jobs = { list: vi.fn((owner: string) => rows.filter(row => row.owner === owner)), kill: vi.fn(),
    wait: vi.fn(async (id: string) => ({ status: rows.find(row => row.id === id)?.status ?? 'missing' })) }
  const children = { listChildren: vi.fn(async (_owner: string): Promise<{ id: string }[]> => []), drainChildren: vi.fn(async () => {}) }
  const hostJobs = { list: vi.fn(() => []), kill: vi.fn(), wait: vi.fn(async () => ({ status: 'missing' })) }
  const hostChildren = { listChildren: vi.fn(async () => []), drainChildren: vi.fn(async () => {}) }
  const workerContext = scoped ? new Context() : undefined
  let context: Context
  if (workerContext) {
    context = new Context()
    cleanup.push(() => context.fiber.dispose(), () => workerContext.fiber.dispose())
    context.reflect.provide('agents', agents)
    new StopRegistry(context, 'jobs', hostJobs); new StopRegistry(context, 'subagents', hostChildren)
    new StopRegistry(workerContext, 'jobs', jobs); new StopRegistry(workerContext, 'subagents', children)
    Object.assign(agent, { ctx: workerContext })
  } else context = { agents, get: (name: string) => name === 'jobs' ? jobs : name === 'subagents' ? children : undefined } as unknown as Context
  let lost = false, closing = false
  const host = { store, context, effects, signal: new AbortController().signal, remote: () => undefined,
    authorize: () => { if (closing || lost) throw new Error('unavailable') }, authorizeObservation: () => { if (lost) throw new Error('unavailable') }, closing: () => closing }
  const stops = new ExecutorStops(host)
  if (admitted) stops.admitted(agent, 'original')
  const request = () => stops.request(store.tickets.get('task')!, store.tickets.get('task')!.assignments[0]!)
  const attest = (id: string, requestId = 'operator-1') => {
    const record = stops.detail(id)
    return { schema: 1 as const, requestId, expectedRevision: record.revision, executionBindingHash: record.executionBindingHash,
      scopeHash: record.scopeHash, confirmed: true as const, note: 'Inspected the original host and Session; its known work is stopped.' }
  }
  return { store, effects, ticket, agent, agents, jobs, rows, children, stops, host, request, attest, path, workerContext, hostJobs, hostChildren,
    lose: () => { lost = true }, close: () => { closing = true } }
}

it('uses real Cordis worker registry identity across admission, cancellation and observation', async () => {
  const f = fixture(true, true), ctx = f.workerContext!, original = Symbol.for('cordis.original')
  for (const name of ['jobs', 'subagents']) {
    expect(ctx.get(name)).not.toBe(ctx.get(name))
    expect(Reflect.get(ctx.get(name), original)).toBe(Reflect.get(ctx.get(name), original))
    expect(Reflect.get(ctx.get(name), original)).not.toBe(Reflect.get(f.host.context.get(name), original))
  }
  f.stops.turnStarted(f.agent, 1)
  expect(f.stops.owns(f.agent, 'original')).toBe(true)
  expect(f.stops.executionAllowed(f.agent, 'original')).toBe(true)
  f.rows.push({ id: 'worker-job', owner: f.agent.id, status: 'running' })
  const id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null, targets: { jobIds: ['worker-job'] } })
  expect(readStop(f.store.db, id)?.dispatched).toBe(true)
  expect(f.agent.cancel).toHaveBeenCalledOnce(); expect(f.jobs.kill).toHaveBeenCalledWith('worker-job', f.agent.id, 'Original assignment stopping')
  expect(f.hostJobs.list).not.toHaveBeenCalled(); expect(f.hostJobs.kill).not.toHaveBeenCalled()
  expect(f.hostChildren.listChildren).not.toHaveBeenCalled()
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'unknown', proof: null })
  f.rows[0]!.status = 'completed'
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'quiet', proof: 'registry' })
  expect(f.jobs.kill).toHaveBeenCalledOnce()
})

it('drains descendants from the captured worker subagent registry, not the host registry', async () => {
  const f = fixture(true, true), child = { id: 'worker-child', status: 'idle' } as Agent
  f.agents.set(child.id, child)
  f.children.listChildren.mockImplementation(async owner => owner === f.agent.id ? [{ id: child.id }] : [])
  f.children.drainChildren.mockImplementation(async () => { f.agents.delete(child.id) })
  const id = f.stops.request(f.ticket, f.ticket.assignments[0]!, { scope: 'descendants' }); await f.stops.idle()
  expect(f.children.drainChildren).toHaveBeenCalledWith(f.agent, [child.id])
  expect(f.stops.detail(id)).toMatchObject({ state: 'quiet', proof: 'registry', targets: { sessions: ['worker-child', f.agent.id] } })
  expect(f.hostChildren.listChildren).not.toHaveBeenCalled(); expect(f.hostChildren.drainChildren).not.toHaveBeenCalled()
})

it('targets only the selected worker jobs through real Cordis services', async () => {
  const f = fixture(true, true)
  f.rows.push({ id: 'selected', owner: f.agent.id, status: 'running' }, { id: 'handed-off', owner: f.agent.id, status: 'running' })
  const id = f.stops.request(f.ticket, f.ticket.assignments[0]!, { scope: 'jobs', jobIds: ['selected'] }); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', targets: { jobIds: ['selected'] } })
  expect(f.jobs.kill).toHaveBeenCalledExactlyOnceWith('selected', f.agent.id, 'Background duration limit reached')
  f.rows[0]!.status = 'completed'
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'quiet', proof: 'registry' })
  expect(f.hostJobs.list).not.toHaveBeenCalled(); expect(f.hostJobs.kill).not.toHaveBeenCalled()
  expect(f.agent.cancel).not.toHaveBeenCalled()
})

it.each(['jobs', 'subagents'])('fails closed when the actual worker %s registry is replaced before a stop', async name => {
  const f = fixture(true, true)
  f.stops.turnStarted(f.agent, 1)
  f.workerContext!.set(name, Reflect.get(f.host.context.get(name), Symbol.for('cordis.original')))
  expect(f.stops.owns(f.agent, 'original')).toBe(false)
  expect(f.stops.executionAllowed(f.agent, 'original')).toBe(false)
  const id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(readStop(f.store.db, id)?.dispatched).toBe(false)
  expect(f.agent.cancel).not.toHaveBeenCalled(); expect(f.jobs.kill).not.toHaveBeenCalled()
})

it.each(['jobs', 'subagents'])('cannot certify an empty replacement %s registry after original cancellation', async name => {
  const f = fixture(true, true)
  f.rows.push({ id: 'original-job', owner: f.agent.id, status: 'running' })
  const id = f.request(); await f.stops.idle()
  expect(f.jobs.kill).toHaveBeenCalledOnce()
  f.workerContext!.set(name, Reflect.get(f.host.context.get(name), Symbol.for('cordis.original')))
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'unknown', proof: null })
  // Even operator evidence cannot use an empty replacement to hide still-running original work.
  expect((await f.stops.attest(id, f.attest(id))).receipt.phase).toBe('refused')
  f.rows[0]!.status = 'completed'
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(f.jobs.kill).toHaveBeenCalledOnce(); expect(f.agent.cancel).toHaveBeenCalledOnce()
  expect(f.hostJobs.list).not.toHaveBeenCalled(); expect(f.hostJobs.kill).not.toHaveBeenCalled()
})

it('keeps unknown original Cordis registries held and checks worker work before operator evidence', async () => {
  const f = fixture(false, true), id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(f.agent.cancel).not.toHaveBeenCalled(); expect(f.jobs.kill).not.toHaveBeenCalled()
  f.rows.push({ id: 'still-active', owner: f.agent.id, status: 'running' })
  expect((await f.stops.attest(id, f.attest(id))).receipt.phase).toBe('refused')
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null })
})

it('keeps the original stop after kill wait returns running; observation never repeats cancellation', async () => {
  const f = fixture(); f.rows.push({ id: 'job-1', owner: f.agent.id, status: 'running' })
  const id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ id, assignmentId: 'original', state: 'unknown', targets: { jobIds: ['job-1'] } })
  expect(f.stops.problem('task')).toBeDefined(); expect(f.jobs.kill).toHaveBeenCalledTimes(1)
  expect(() => f.stops.admitted(f.agent, 'original')).toThrow('Original work is not confirmed stopped')
  expect(f.request()).toBe(id)
  await f.stops.recheck(id); expect(f.jobs.kill).toHaveBeenCalledTimes(1)
  f.rows[0]!.status = 'completed'
  expect(await f.stops.recheck(id)).toMatchObject({ id, state: 'quiet', proof: 'registry' })
  expect(f.stops.problem('task')).toBeUndefined()
})

it.each(['missing', 'unrecognized'])('does not infer quiet from %s original job evidence', async kind => {
  const f = fixture(); f.rows.push({ id: 'job-1', owner: f.agent.id, status: 'running' })
  const id = f.request(); await f.stops.idle()
  if (kind === 'missing') f.rows.length = 0; else f.rows[0]!.status = 'future-status'
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'unknown', proof: null })
})

it('cold started assignment with a newly loaded Agent and empty registry remains unknown', async () => {
  const f = fixture(false); f.stops.recover(); await f.stops.idle()
  const record = f.stops.list('task').items[0]!
  expect(f.stops.detail(record.id)).toMatchObject({ state: 'unknown', proof: null })
  expect(f.agent.cancel).not.toHaveBeenCalled(); expect(f.jobs.kill).not.toHaveBeenCalled()
  const request = f.attest(record.id)
  const first = await f.stops.attest(record.id, request)
  expect(first).toMatchObject({ receipt: { phase: 'accepted' }, current: { proof: 'operator', state: 'quiet' } })
  expect(await f.stops.attest(record.id, request)).toEqual(first)
  await expect(f.stops.attest(record.id, { ...request, note: 'Changed body' })).rejects.toThrow('identity differs')
  expect(f.stops.attestations(record.id).items).toHaveLength(1)
  validateStopAuthority(f.store.db, new Map([['task', f.store.tickets.get('task')!]]), () => {})
})

it('persists stale and active-work attestation refusals for exact lost-response recovery', async () => {
  const f = fixture(false); const id = f.request(); await f.stops.idle()
  const stale = { ...f.attest(id), expectedRevision: 1 }
  const refused = await f.stops.attest(id, stale)
  expect(refused.receipt.phase).toBe('refused'); expect(await f.stops.attest(id, stale)).toEqual(refused)
  f.rows.push({ id: 'still-active', owner: f.agent.id, status: 'running' })
  expect((await f.stops.attest(id, f.attest(id, 'operator-2'))).receipt.phase).toBe('refused')
  expect(f.stops.detail(id).state).toBe('unknown')
})

it('fences exact Agent Session and registry continuity after original admission', async () => {
  const f = fixture(); f.rows.push({ id: 'job-1', owner: f.agent.id, status: 'running' })
  const id = f.request(); await f.stops.idle(); f.rows[0]!.status = 'completed'
  Object.assign(f.agent, { session: {} })
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'unknown', proof: null })
})

it('does not cancel a replacement Agent for a delayed old assignment stop', async () => {
  const f = fixture(); const original = f.ticket.assignments[0]!
  const replacement = { ...original, id: 'replacement', state: 'running' as const }
  f.store.tickets.save({ ...f.ticket, assignments: [{ ...original, state: 'ended' }, replacement] })
  f.stops.admitted(f.agent, replacement.id)
  const id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id).state).toBe('unknown'); expect(f.agent.cancel).not.toHaveBeenCalled()
})

it('keeps handed-off root jobs outside a descendants-only stop', async () => {
  const f = fixture(); f.rows.push({ id: 'server', owner: f.agent.id, status: 'running' })
  const id = f.stops.request(f.ticket, f.ticket.assignments[0]!, { scope: 'descendants', keepInbox: true }); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'quiet', scope: 'descendants', targets: { jobIds: [] } })
  expect(f.jobs.kill).not.toHaveBeenCalled(); expect(f.rows[0]!.status).toBe('running')
})

it('allows final known proof during intentional shutdown and denies it after ownership loss', async () => {
  const f = fixture(); f.rows.push({ id: 'job-1', owner: f.agent.id, status: 'running' })
  const id = f.request(); await f.stops.idle(); f.rows[0]!.status = 'completed'; f.lose()
  await f.stops.run(id); expect(f.stops.detail(id).state).toBe('unknown')
  const g = fixture(); g.close(); const quiet = g.request(); await g.stops.idle()
  expect(g.stops.detail(quiet)).toMatchObject({ state: 'quiet', proof: 'registry' })
})

it('canonical identity survives key order and refuses forged original binding or receipt identity', async () => {
  const f = fixture(false); const id = f.request(); await f.stops.idle()
  expect(stopDigest({ a: 1, b: { c: 2, a: 3 } })).toBe(stopDigest({ b: { a: 3, c: 2 }, a: 1 }))
  const record = readStop(f.store.db, id)!
  const altered = { ...record, execution: { directory: '/another', mode: 'local' as const } }
  altered.executionBindingHash = stopExecutionDigest(altered.execution, altered.world); altered.scopeHash = stopScopeDigest(altered)
  f.store.db.prepare('UPDATE executor_stop SET value=? WHERE id=?').run(JSON.stringify(altered), id)
  expect(() => validateStopAuthority(f.store.db, new Map([['task', f.ticket]]), () => {})).toThrow('authority')
})

it('migrates legacy active and ended Session coverage without inventing local quiescence', async () => {
  const f = fixture(false)
  f.store.tickets.save({ ...f.ticket, id: 'ended', ended: { by: 'human', outcome: 'stopped', at: '2026-01-01T01:00:00.000Z' } })
  f.store.set(KV.store.schema, 12)
  const reopened = new Store(f.path)
  try {
    expect(reopened.get(KV.store.schema)).toBe(14)
    const rows = reopened.db.prepare('SELECT value FROM executor_stop ORDER BY ticket').all().map(row => JSON.parse(String(row.value)))
    expect(rows.map(row => [row.ticketId, row.state, row.legacy])).toEqual([['ended', 'dormant', true], ['task', 'unknown', true]])
    expect(rows.every(row => row.proof === null && row.instance === null)).toBe(true)
  } finally { reopened.close() }
})

it('reuses final full quiet coverage across a cold restore until later same-assignment work consumes it', async () => {
  const f = fixture(), id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id).state).toBe('quiet')
  const restored = new ExecutorStops({ ...f.host, effects: new Effects(f.store, new HealthBoard()) }); restored.recover(); await restored.idle()
  expect(restored.list('task').items).toHaveLength(1); expect(restored.problem('task')).toBeUndefined()
  restored.beforeAdmission('task', 'original')
  expect(readStop(f.store.db, id)?.coverageConsumed).toBe(true)
  // A cold replacement Agent has no original admission provenance, despite the same Session ID and empty job list.
  f.agents.set(f.agent.id, { ...f.agent, session: {} } as Agent)
  const crashed = new ExecutorStops({ ...f.host, effects: new Effects(f.store, new HealthBoard()) }); crashed.recover(); await crashed.idle()
  expect(crashed.list('task').items).toHaveLength(2); expect(crashed.problem('task')).toBeDefined()
  expect(crashed.detail(id)).toMatchObject({ state: 'quiet', proof: 'registry' })
})

it('consumed quiet coverage cannot skip a later stop just because the assignment now ended', async () => {
  const f = fixture(), first = f.request(); await f.stops.idle()
  f.stops.beforeAdmission('task', 'original'); f.rows.push({ id: 'later-job', owner: f.agent.id, status: 'running' })
  const ticket = f.store.tickets.get('task')!; ticket.assignments[0]!.state = 'ended'; f.store.tickets.save(ticket)
  const second = f.request(); expect(second).not.toBe(first); await f.stops.idle()
  expect(f.stops.detail(first)).toMatchObject({ state: 'quiet', proof: 'registry' })
  expect(f.stops.detail(second)).toMatchObject({ state: 'unknown', targets: { jobIds: ['later-job'] } })
})

it('binds an old native turn to its original admission even when replacement delivery is later authorized', () => {
  const f = fixture(); f.stops.turnStarted(f.agent, 1)
  expect(f.stops.turnAllowed(f.agent, 'original', 1)).toBe(true)
  f.stops.admitted(f.agent, 'replacement')
  expect(f.stops.turnAllowed(f.agent, 'replacement', 1)).toBe(false)
  expect(f.stops.executionAllowed(f.agent, 'replacement')).toBe(false)
  f.stops.turnStarted(f.agent, 2)
  expect(f.stops.turnAllowed(f.agent, 'replacement', 2)).toBe(true)
})

it('settles a first never-dispatched pending assignment from its existing untouched launch boundary', async () => {
  const f = fixture(false), ticket = f.store.tickets.get('task')!
  ticket.assignments[0]!.state = 'ended'; delete ticket.assignments[0]!.startedAt; f.store.tickets.save(ticket)
  f.agents.clear(); f.effects.ensure('launch', 'original', { ticketId: 'task', assignmentId: 'original' })
  const id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'quiet', proof: 'undispatched' })
  expect(f.jobs.kill).not.toHaveBeenCalled()
  validateStopAuthority(f.store.db, new Map([['task', ticket]]), () => {})
})

it('operator evidence may settle missing local job evidence but cannot bypass an unknown live status', async () => {
  const f = fixture(); f.rows.push({ id: 'job', owner: f.agent.id, status: 'running' })
  const id = f.request(); await f.stops.idle(); f.rows.length = 0
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'unknown' })
  expect((await f.stops.attest(id, f.attest(id))).receipt.phase).toBe('accepted')
})

it('settles a never-dispatched retry assignment alongside an ended prior assignment', async () => {
  const f = fixture(false), ticket = f.store.tickets.get('task')!
  const original = ticket.assignments[0]!
  const retry = { ...original, id: 'retry', state: 'pending', createdAt: '2026-01-02T00:00:00.000Z' } as typeof original
  delete retry.startedAt
  original.state = 'ended'; original.endedAt = '2026-01-01T01:00:00.000Z'
  ticket.assignments = [original, retry]
  f.store.tickets.save(ticket)
  f.agents.clear()
  f.effects.ensure('launch', 'retry', { ticketId: 'task', assignmentId: 'retry' })
  const id = f.stops.request(ticket, retry)
  await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ assignmentId: 'retry', state: 'quiet', proof: 'undispatched' })
  expect(f.jobs.kill).not.toHaveBeenCalled()
  validateStopAuthority(f.store.db, new Map([['task', ticket]]), () => {})
})

it('retains an unknown original stop after cold start even when the retry never dispatched', async () => {
  const f = fixture(false), ticket = f.store.tickets.get('task')!
  // Simulate a cold restore: prior assignment ended and its stop is held unknown, while the retry is still pending.
  const original = ticket.assignments[0]!
  const retry = { ...original, id: 'retry', state: 'pending', createdAt: '2026-01-02T00:00:00.000Z' } as typeof original
  delete retry.startedAt
  original.state = 'ended'; original.endedAt = '2026-01-01T01:00:00.000Z'
  ticket.assignments = [original, retry]
  f.store.tickets.save(ticket)
  f.agents.clear()
  f.effects.ensure('launch', 'retry', { ticketId: 'task', assignmentId: 'retry' })
  const held = f.stops.request(ticket, original)
  await f.stops.idle()
  expect(f.stops.detail(held).state).toBe('unknown')
  // A fresh instance and an empty current registry cannot certify the original process's work.
  const restored = new ExecutorStops({ ...f.host, effects: new Effects(f.store, new HealthBoard()) })
  restored.recover(); await restored.idle()
  expect(restored.detail(held)).toMatchObject({ state: 'unknown', proof: null })
  expect(restored.problem('task')).toContain('Original work is not confirmed stopped')
})

function preparationFixture() {
  const f = fixture(false), ticket = f.store.tickets.get('task')!, assignment = ticket.assignments[0]!
  assignment.state = 'pending'; delete assignment.startedAt; f.store.tickets.save(ticket)
  f.agents.clear(); f.effects.ensure('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  f.effects.beginLaunch(assignment.id)
  return { ...f, ticket, assignment, begin: () => f.stops.beginPreparation(ticket, assignment, 'prepare-command') }
}

it('persists preparation intent before dispatch and retains unknown original coverage after response loss and cold recovery', async () => {
  const f = preparationFixture(), id = f.begin()
  expect(readStop(f.store.db, id)).toMatchObject({ state: 'unknown', proof: null, assignmentId: 'original',
    preparation: { phase: 'intent', command: 'unknown', exitCode: null, quiescence: 'unknown' } })
  expect(() => f.begin()).toThrow('Original work is not confirmed stopped')
  const restored = new ExecutorStops({ ...f.host, effects: new Effects(f.store, new HealthBoard()) })
  restored.recover(); await restored.idle()
  expect(await restored.recheck(id)).toMatchObject({ state: 'unknown', proof: null })
  restored.finishPreparation(id, { command: 'exited', exitCode: 1, quiescence: 'confirmed' })
  expect(restored.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(restored.list('task').items.map(item => item.id)).toEqual([id])
  validateStopAuthority(f.store.db, new Map([['task', f.ticket]]), () => {})
})

it('retains settled failed preparation proof after launch retirement and reuses the exact original receipt for retry', async () => {
  const f = preparationFixture(), id = f.begin()
  f.stops.finishPreparation(id, { command: 'exited', exitCode: 3, quiescence: 'confirmed' })
  f.assignment.state = 'ended'; f.assignment.endedAt = '2026-01-01T01:00:00.000Z'
  f.assignment.report = { state: 'failed', summary: 'prepare failed', at: f.assignment.endedAt }
  f.store.tickets.save(f.ticket)
  f.effects.finishLaunch('original'); f.store.db.prepare("DELETE FROM effect WHERE kind='launch' AND key='original'").run()
  const restored = new ExecutorStops({ ...f.host, effects: new Effects(f.store, new HealthBoard()) })
  restored.recover(); await restored.idle()
  expect(restored.request(f.ticket, f.assignment)).toBe(id)
  expect(restored.detail(id)).toMatchObject({ state: 'quiet', proof: 'preparation', assignmentId: 'original' })
  validateStopAuthority(f.store.db, new Map([['task', f.ticket]]), () => {})
  expect(f.agent.cancel).not.toHaveBeenCalled()
})

it.each([
  { command: 'exited' as const, exitCode: 1, quiescence: 'unknown' as const },
  { command: 'unknown' as const, exitCode: null, quiescence: 'unknown' as const },
])('never uses incomplete preparation observation as quiet proof: %j', async outcome => {
  const f = preparationFixture(), id = f.begin()
  f.stops.finishPreparation(id, outcome)
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(() => f.stops.beforeAdmission('task', 'original')).toThrow('Original work is not confirmed stopped')
  f.stops.finishPreparation(id, { command: 'exited', exitCode: 0, quiescence: 'confirmed' })
  expect(readStop(f.store.db, id)?.preparation).toMatchObject(outcome)
  expect(f.stops.request(f.ticket, f.assignment)).toBe(id)
})

it('consumes successful preparation coverage before further launch work and never reuses it to stop that later work', async () => {
  const f = preparationFixture(), id = f.begin()
  f.stops.finishPreparation(id, { command: 'exited', exitCode: 0, quiescence: 'confirmed' })
  f.stops.beforeAdmission('task', 'original')
  expect(readStop(f.store.db, id)?.coverageConsumed).toBe(true)
  const later = f.stops.request(f.ticket, f.assignment); await f.stops.idle()
  expect(later).not.toBe(id)
  expect(f.stops.detail(later)).toMatchObject({ state: 'unknown', proof: null })
})

it('refuses preparation-only authority for a reused loaded Session or a remote execution world', () => {
  const f = preparationFixture()
  f.agents.set(f.agent.id, f.agent)
  expect(() => f.begin()).toThrow('exclusive pre-dispatch coverage')
  f.agents.clear()
  f.assignment.execution = { ...f.assignment.execution!, environment: { environmentId: 'remote', revision: 1, epoch: 1, world: 'remote-world' } }
  f.store.tickets.save(f.ticket)
  expect(() => f.begin()).toThrow('exclusive pre-dispatch coverage')
  expect(f.stops.list().items).toHaveLength(0)
})

it('rejects restored preparation proof if later worker dispatch was not marked as consuming its coverage', () => {
  const f = preparationFixture(), id = f.begin()
  f.stops.finishPreparation(id, { command: 'exited', exitCode: 1, quiescence: 'confirmed' })
  f.assignment.startedAt = '2026-01-01T01:00:00.000Z'; f.store.tickets.save(f.ticket)
  expect(() => validateStopAuthority(f.store.db, new Map([['task', f.ticket]]), () => {})).toThrow('preparation-only coverage')
})

it('refuses operator attestation while the original preparation handle is still being observed', async () => {
  const f = preparationFixture(), id = f.begin()
  expect(f.stops.detail(id).canAttest).toBe(false)
  expect((await f.stops.attest(id, f.attest(id))).receipt.phase).toBe('refused')
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  f.stops.finishPreparation(id, { command: 'exited', exitCode: 3, quiescence: 'unknown' })
  expect(f.stops.detail(id).canAttest).toBe(true)
})

it('preserves the pending preparation intent if storage ownership is lost before outcome acceptance', () => {
  const f = preparationFixture(), id = f.begin()
  f.lose()
  expect(() => f.stops.finishPreparation(id, { command: 'exited', exitCode: 3, quiescence: 'confirmed' })).toThrow('unavailable')
  expect(readStop(f.store.db, id)).toMatchObject({ state: 'unknown', proof: null, preparation: { phase: 'intent' } })
})

it('upgrades schema 13 without rewriting original stop identities and marks schema 14 for old-reader refusal', async () => {
  const f = fixture(false), id = f.request(); await f.stops.idle()
  const before = readStop(f.store.db, id)
  f.store.set(KV.store.schema, 13)
  const reopened = new Store(f.path)
  try {
    expect(reopened.get(KV.store.schema)).toBe(14)
    expect(readStop(reopened.db, id)).toEqual(before)
  } finally { reopened.close() }
})

it('keeps observed preparation outcomes and consumed coverage immutable', () => {
  const f = preparationFixture(), id = f.begin()
  f.stops.finishPreparation(id, { command: 'exited', exitCode: 3, quiescence: 'confirmed' })
  const observed = readStop(f.store.db, id)!
  expect(() => saveStop(f.store.db, { ...observed, preparation: { ...observed.preparation!, exitCode: 0 } })).toThrow('identity cannot change')
  f.stops.beforeAdmission('task', 'original')
  expect(() => saveStop(f.store.db, observed)).toThrow('identity cannot change')
})
