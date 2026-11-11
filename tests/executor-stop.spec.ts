import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { Ticket } from '../src/core/index.ts'
import { ExecutorStops } from '../src/executor/stops.ts'
import { readStop, stopDigest, stopExecutionDigest, stopScopeDigest, validateStopAuthority } from '../src/executor/stop-store.ts'
import { KV } from '../src/kv.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture(admitted = true) {
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
  const context = { agents, get: (name: string) => name === 'jobs' ? jobs : name === 'subagents' ? children : undefined } as unknown as Context
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
  return { store, effects, ticket, agent, agents, jobs, rows, children, stops, host, request, attest, path,
    lose: () => { lost = true }, close: () => { closing = true } }
}

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
    expect(reopened.get(KV.store.schema)).toBe(13)
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
