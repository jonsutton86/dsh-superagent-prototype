import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { Ticket } from '../src/core/index.ts'
import { ExecutorStops } from '../src/executor/stops.ts'

class Jobs extends Service {
  rows: { id: string; owner: string; status: string }[] = []
  list = vi.fn((owner: string) => this.rows.filter(row => row.owner === owner))
  kill = vi.fn()
  wait = vi.fn(async (id: string) => ({ status: this.rows.find(row => row.id === id)?.status ?? 'missing' }))
  constructor(ctx: Context) { super(ctx, 'jobs') }
}
class Children extends Service {
  listChildren = vi.fn(async (_owner: string): Promise<{ id: string }[]> => [])
  drainChildren = vi.fn(async () => {})
  constructor(ctx: Context) { super(ctx, 'subagents') }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function fixture(admit = true) {
  const directory = mkdtempSync(join(tmpdir(), 'stop-service-identity-'))
  const store = new Store(join(directory, 'state.sqlite')), effects = new Effects(store, new HealthBoard())
  const context = new Context(), jobs = new Jobs(context), children = new Children(context)
  const worker = context.extend({})
  const agent = { id: 'worker-task', ctx: worker, status: 'idle', session: {}, cancel: vi.fn(), whenIdle: async () => {} } as unknown as Agent
  const agents = new Map<string, Agent>([[agent.id, agent]])
  context.reflect.provide('agents', agents)
  const at = '2026-01-01T00:00:00.000Z'
  const ticket = { id: 'task', title: 'Original task', createdAt: at, updatedAt: at, inputs: [], undelivered: [],
    assignments: [{ id: 'original', state: 'running', createdAt: at, startedAt: at,
      execution: { directory: '/original', mode: 'local' } }] } as unknown as Ticket
  store.tickets.save(ticket)
  const host = { store, effects, context, signal: new AbortController().signal, remote: () => undefined,
    authorize: () => {}, authorizeObservation: () => {}, closing: () => false }
  const stops = new ExecutorStops(host)
  if (admit) stops.admitted(agent, 'original')
  const request = () => stops.request(store.tickets.get('task')!, store.tickets.get('task')!.assignments[0]!)
  cleanup.push(async () => { await stops.idle(); await context.fiber.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, effects, context, worker, jobs, children, agent, agents, ticket, host, stops, request }
}

it('dispatches and proves quiet through fresh inherited Cordis proxies of the original services', async () => {
  const f = fixture()
  expect(f.context.get('jobs')).not.toBe(f.context.get('jobs'))
  expect(f.worker.get('jobs')).not.toBe(f.context.get('jobs'))
  const id = f.request(); await f.stops.idle()
  expect(f.agent.cancel).toHaveBeenCalledTimes(1)
  expect(f.stops.detail(id)).toMatchObject({ state: 'quiet', proof: 'registry' })
  expect(f.stops.problem('task')).toBeUndefined()
})

it.each(['jobs', 'subagents'])('refuses a different worker %s registry even when host registries remain original', async name => {
  const f = fixture(), replacement = new Context()
  replacement.reflect.provide(name === 'jobs' ? 'subagents' : 'jobs', name === 'jobs' ? f.children : f.jobs)
  if (name === 'jobs') new Jobs(replacement); else new Children(replacement)
  Object.assign(f.agent, { ctx: replacement })
  const id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(f.agent.cancel).not.toHaveBeenCalled()
  expect(f.jobs.kill).not.toHaveBeenCalled()
  await replacement.fiber.dispose()
})

it.each(['jobs', 'subagents'])('refuses a different host %s registry instead of inspecting a replacement world', async name => {
  const f = fixture(), replacement = new Context()
  replacement.reflect.provide('agents', f.agents)
  replacement.reflect.provide(name === 'jobs' ? 'subagents' : 'jobs', name === 'jobs' ? f.children : f.jobs)
  if (name === 'jobs') new Jobs(replacement); else new Children(replacement)
  f.host.context = replacement
  const id = f.request(); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(f.agent.cancel).not.toHaveBeenCalled()
  expect(f.jobs.kill).not.toHaveBeenCalled()
  await replacement.fiber.dispose()
})

it('does not prove quiet after the worker registry changes following original cancellation', async () => {
  const f = fixture()
  f.jobs.rows.push({ id: 'original-job', owner: f.agent.id, status: 'running' })
  const id = f.request(); await f.stops.idle()
  expect(f.agent.cancel).toHaveBeenCalledTimes(1)
  expect(f.jobs.kill).toHaveBeenCalledTimes(1)
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  f.jobs.rows[0]!.status = 'completed'
  const replacement = new Context()
  new Jobs(replacement); new Children(replacement)
  Object.assign(f.agent, { ctx: replacement })
  expect(await f.stops.recheck(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(f.agent.cancel).toHaveBeenCalledTimes(1)
  expect(f.jobs.kill).toHaveBeenCalledTimes(1)
  await replacement.fiber.dispose()
})

it('preserves an ended original stop across cold absence and an untouched pending retry', async () => {
  const f = fixture(false), ticket = f.store.tickets.get('task')!, original = ticket.assignments[0]!
  const retry = { ...original, id: 'retry', state: 'pending' as const, createdAt: '2026-01-02T00:00:00.000Z' }
  delete retry.startedAt
  original.state = 'ended'; original.endedAt = '2026-01-01T01:00:00.000Z'
  ticket.assignments = [original, retry]; f.store.tickets.save(ticket); f.agents.clear()
  f.effects.ensure('launch', 'retry', { ticketId: ticket.id, assignmentId: retry.id })
  const id = f.stops.request(ticket, original); await f.stops.idle()
  expect(f.stops.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  const restored = new ExecutorStops({ ...f.host, effects: new Effects(f.store, new HealthBoard()) })
  restored.recover(); await restored.idle()
  expect(restored.detail(id)).toMatchObject({ state: 'unknown', proof: null })
  expect(restored.problem(ticket.id)).toBeDefined()
  expect(() => restored.admitted(f.agent, retry.id)).toThrow('Original work is not confirmed stopped')
  expect(f.agent.cancel).not.toHaveBeenCalled(); expect(f.jobs.kill).not.toHaveBeenCalled()
})
