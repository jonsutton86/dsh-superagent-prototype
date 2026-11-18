import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Usage, pricedUsage } from '../src/usage/service.ts'
import { UsageRuntime } from '../src/usage/runtime.ts'
import type { UsageBudget, UsageOwner, ModelPrice } from '../src/usage/model.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { inferenceFixture } from './fixtures/inference.ts'
import { startRuntime } from './fixtures/host.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const owner: UsageOwner = { sessionId: 'master', root: 'master', role: 'orchestrator' }
const price: ModelPrice = { provider: 'fixture', model: 'current', input: 1000000, output: 3000000, cacheRead: 100000, cacheWrite: 2000000, note: 'Synthetic test rates, USD per million tokens' }
const budget = (extra: Partial<UsageBudget> = {}): UsageBudget => ({ id: 'limit', title: 'Monthly limit', scope: { kind: 'workspace' }, period: 'month', enabled: true, calls: 2, ...extra })
function fixture(path?: string) {
  const directory = path ?? mkdtempSync(join(tmpdir(), 'dsh-usage-')), store = new Store(join(directory, 'state.sqlite'))
  let at = Date.parse('2026-11-09T12:00:00Z'), closed = false
  const usage = new Usage(store, () => at)
  const close = () => { if (!closed) { closed = true; store.close() } }
  cleanup.push(() => { close(); if (!path) rmSync(directory, { recursive: true, force: true }) })
  return { directory, store, usage, close, time: (value: string) => { at = Date.parse(value) },
    configure: (budgets: UsageBudget[] = [], prices = [price]) => usage.configure({ requestId: `config-${usage.configuration().revision}`, revision: usage.configuration().revision, budgets, prices }),
    begin: (who = owner, ceiling: number | undefined = 100) => usage.begin(who, 'fixture', 'current', 'conversation', ceiling) }
}

it('prices disjoint cached tokens once, rounds micro-USD up, and preserves configuration snapshots', () => {
  const f = fixture(); f.configure()
  const call = f.begin(), tokens = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 15, totalTokens: 100 }
  f.usage.settle(call.id, 'stop', tokens)
  expect(f.usage.get(call.id)).toMatchObject({ totalTokens: 100, cost: 153, phase: 'reported', tokens, price })
  expect(f.usage.page().totals).toMatchObject({ calls: 1, tokens: 100, cost: 153, reservedTokens: 0, reservedCost: 0 })
  f.configure([], [{ ...price, output: 9000000 }]); expect(f.usage.configuration(1).prices).toEqual([price])
  expect(f.usage.get(call.id).cost).toBe(153)
  expect(pricedUsage({ inputTokens: 1, outputTokens: 0 }, { ...price, input: 1 })).toBe(1)
  expect(pricedUsage({ inputTokens: 1, outputTokens: 0, totalTokens: 3 }, price)).toBe(7)
})
it('reserves atomically against overlapping workspace, mission, schedule and persona limits', async () => {
  const f = fixture(), who = { ...owner, missionId: 'mission', scheduleId: 'schedule', personaId: 'persona' }
  f.configure([budget({ calls: 10 }), ...(['mission', 'schedule', 'persona'] as const).map(kind => budget({ id: kind, scope: { kind, id: kind }, calls: 1 }))])
  const admitted = await Promise.allSettled([Promise.resolve().then(() => f.begin(who)), Promise.resolve().then(() => f.begin(who))])
  expect(admitted.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect(f.usage.page().totals.calls).toBe(1)
  expect(f.usage.page({ kind: 'mission', id: 'mission' }).totals.calls).toBe(1)
  expect(f.usage.page({ kind: 'mission', id: 'unrelated' }).calls).toEqual([])
  f.begin(); expect(f.usage.page().totals.calls).toBe(2)
})
it('retains unresolved reservations after SQLite reopen and releases only with evidenced reconciliation', () => {
  const f = fixture(); f.configure([budget({ calls: undefined, tokens: 150, cost: 450 })]); const call = f.begin()
  expect(() => f.begin()).toThrow('Token reservation')
  f.close(); const g = fixture(f.directory)
  expect(g.usage.get(call.id)).toMatchObject({ phase: 'unknown', outcome: 'interrupted', reservedTokens: 100, reservedCost: 300 })
  expect(() => g.begin()).toThrow('Token reservation')
  const request = { requestId: 'provider-receipt', tokens: { inputTokens: 10, outputTokens: 10 }, note: 'Provider request record inspected' }
  g.usage.reconcile(call.id, request); g.usage.reconcile(call.id, request)
  expect(g.usage.get(call.id)).toMatchObject({ phase: 'reconciled', totalTokens: 20, cost: 40, price, reconciliation: { note: request.note } })
  g.begin(); expect(g.usage.page().totals).toMatchObject({ tokens: 20, reservedTokens: 100, cost: 40, reservedCost: 300 })
  expect(() => g.usage.reconcile(call.id, { ...request, cost: 1 })).toThrow('already used')
})
it('refuses unbounded liabilities when token or cost limits apply, but supports exact call limits', () => {
  const f = fixture(); f.configure([budget()], [])
  const call = f.usage.begin(owner, 'fixture', 'current', 'conversation'); f.usage.settle(call.id, 'stop')
  f.configure([budget({ calls: undefined, tokens: 1000 })], [])
  expect(() => f.begin()).toThrow('Token reservation')
  f.configure([budget({ calls: undefined, cost: 1000 })], [])
  expect(() => f.begin()).toThrow('Estimated spend')
  expect(() => f.usage.reconcile(call.id, { requestId: 'missing-cost', tokens: { inputTokens: 0, outputTokens: 0 }, note: 'No bill' })).toThrow('verified USD cost')
  f.usage.reconcile(call.id, { requestId: 'zero-bill', tokens: { inputTokens: 0, outputTokens: 0 }, cost: 0, note: 'Provider confirms no charge' })
  f.configure([budget({ calls: undefined, cost: 300 })]); f.begin()
  expect(() => f.begin()).toThrow('Estimated spend')
})
it('counts invalid counters as unknown and preserves reported facts when unpriced calls are reconciled', () => {
  const f = fixture(); f.configure([], [])
  const valid = f.begin(), invalid = f.begin(), overflow = f.begin()
  f.usage.settle(valid.id, 'stop', { inputTokens: 1, outputTokens: 2 })
  f.usage.settle(invalid.id, 'stop', { inputTokens: -1, outputTokens: 2 })
  f.usage.settle(overflow.id, 'stop', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 })
  expect(f.usage.get(invalid.id).phase).toBe('unknown'); expect(f.usage.get(overflow.id).phase).toBe('unknown')
  f.usage.reconcile(valid.id, { requestId: 'receipt', tokens: { inputTokens: 1, outputTokens: 3 }, cost: 5, note: 'Invoice counters' })
  expect(f.usage.get(valid.id)).toMatchObject({ tokens: { inputTokens: 1, outputTokens: 2 }, totalTokens: 4, cost: 5 })
})
it('rolls UTC periods without resetting lifetime limits and rejects stale/conflicting commands', () => {
  const f = fixture(); f.configure([budget({ calls: 1, period: 'day' }), budget({ id: 'lifetime', period: 'lifetime', calls: 2 })]); f.begin()
  expect(() => f.begin()).toThrow('call limit')
  f.time('2026-11-10T00:00:00Z'); f.begin(); f.time('2026-12-01T00:00:00Z')
  expect(() => f.begin()).toThrow('call limit')
  expect(f.usage.page().totals.calls).toBe(0)
  expect(() => f.usage.configure({ requestId: 'stale', revision: 0, budgets: [], prices: [] })).toThrow('configuration changed')
  expect(() => f.usage.configure({ requestId: 'duplicates', revision: 1, budgets: [budget(), budget()], prices: [] })).toThrow('unique')
})

async function runtimeFixture() {
  const f = fixture(), ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  const inference = await inferenceFixture(ctx), abort = new AbortController(), board = new HealthBoard()
  const parents = new Map<string, string | undefined>(), inspect = vi.fn(async (id: string) => {
    if (!parents.has(id)) throw new Error('Synthetic private diagnostic')
    return { meta: { parentSession: parents.get(id) } }
  })
  ctx.reflect.provide('agents', { get: () => undefined }); ctx.reflect.provide('sessionController', { inspect })
  const resolve = vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({ context: { contextWindow: 100 } } as Awaited<ReturnType<typeof ctx.llm.resolveModelInfo>>)
  const runtime = new UsageRuntime(ctx, f.store, f.usage, 'master', abort.signal, board.claim('usage')); cleanup.push(() => runtime.dispose())
  const stream = async (id?: string) => {
    const call = await ctx.llm.prepareCall({ provider: 'fixture', model: 'current' })
    const result = []
    for await (const chunk of call.stream(Object.freeze({ ...call.config, sessionId: id ? SessionId(id) : undefined, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Private prompt never enters usage ledger' }] }] }))) result.push(chunk)
    return result
  }
  return { ...f, ...inference, ctx, runtime, abort, board, parents, inspect, resolve, stream }
}
it('uses real Harness stream middleware to admit before dispatch, account completion, and deny without a provider call', async () => {
  const f = await runtimeFixture(); f.configure([budget({ calls: 1 })])
  f.adapter.chunks = [{ type: 'usage', usage: { inputTokens: 11, outputTokens: 4 } }, { type: 'finish', reason: { kind: 'stop' } }]
  f.adapter.before = async () => { expect(f.usage.page().totals).toMatchObject({ calls: 1, pending: 1, reservedTokens: 100 }) }
  await f.stream('master'); expect(f.usage.page().totals).toMatchObject({ tokens: 15, cost: 23, pending: 0 })
  await expect(f.stream('master')).rejects.toThrow('Model call limit'); expect(f.adapter.calls).toHaveLength(1)
  expect(JSON.stringify(f.usage.page())).not.toContain('Private prompt')
  expect(f.board.all.usage?.state).toBe('error')
})
it('attributes cold descendants, caches immutable lineage and excludes unrelated roots and rootless probes', async () => {
  const f = await runtimeFixture(); f.parents.set('child', 'parent'); f.parents.set('parent', 'master'); f.parents.set('unrelated', undefined)
  await f.stream('child'); expect(f.usage.page().calls[0]!.owner).toEqual({ ...owner, sessionId: 'child' })
  expect(f.usage.binding('child')).toBe('master'); f.inspect.mockClear(); await f.stream('child'); expect(f.inspect).not.toHaveBeenCalled()
  await f.stream('unrelated'); await f.stream(); expect(f.usage.page().totals.calls).toBe(2)
  expect(() => f.usage.bind('child', 'another')).toThrow('lineage changed')
  f.parents.set('cycle', 'cycle'); await expect(f.stream('cycle')).rejects.toThrow('cycle')
  await expect(f.stream('missing')).rejects.toThrow('Cannot establish Session ancestry')
})
it('keeps partial streams and shutdown outcomes unknown and refuses metadata failures under token limits', async () => {
  const f = await runtimeFixture(); f.configure()
  f.adapter.chunks = [{ type: 'usage', usage: { inputTokens: 11, outputTokens: 4 } }]
  await f.stream('master'); expect(f.usage.page().calls[0]!.phase).toBe('unknown')
  expect(f.usage.page().totals.reservedTokens).toBe(100)
  f.configure([budget({ calls: undefined, tokens: 1000 })]); f.resolve.mockRejectedValue(new Error('Metadata private diagnostic'))
  await expect(f.stream('master')).rejects.toThrow('Token reservation'); expect(f.adapter.calls).toHaveLength(1)
  f.configure(); f.adapter.before = async () => { f.runtime.dispose() }
  await f.stream('master'); expect(f.usage.page().calls.every(call => call.phase === 'unknown')).toBe(true)
})
it('does not write a late ancestry response after accounting shuts down', async () => {
  const f = await runtimeFixture()
  f.inspect.mockImplementation(async () => { f.runtime.dispose(); return { meta: { parentSession: 'master' } } })
  await expect(f.stream('child')).rejects.toThrow('Model accounting has stopped')
  expect(f.usage.binding('child')).toBeUndefined(); expect(f.adapter.calls).toHaveLength(0)
})
it('attributes actual workspace tickets and their descendants to mission and schedule budgets', async () => {
  const host = await startRuntime(); cleanup.push(() => host.stop())
  await host.api('POST', 'executor/pause', { paused: true })
  const saved = host.runtime.schedules.create({ requestId: 'scheduled', enabled: true, definition: { title: 'Budget proof', cadence: { kind: 'once', at: new Date().toISOString() }, missed: 'latest', graceSeconds: 60, maxRuns: 1, maxOpen: 1,
    plan: { title: 'Budget proof', objective: 'Check ownership', acceptance: 'Scoped usage', actions: [{ id: 'action', title: 'Action', owner: 'agent', instructions: 'Check', dependsOn: [] }] } } })
  await host.api('POST', 'executor/pause', { paused: false }); await host.runtime.pump(); await host.runtime.idle()
  const mission = host.runtime.workspace.get(host.runtime.schedules.get(saved.id).occurrences[0]!.missionId!), task = mission.actions[0]!.runs[0]!
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose()); const f = await inferenceFixture(ctx)
  ctx.reflect.provide('agents', { get: () => undefined }); ctx.reflect.provide('sessionController', { inspect: async () => ({ meta: { parentSession: `worker-${task}` } }) })
  const runtime = new UsageRuntime(ctx, host.runtime.store, host.runtime.usage, 'unused-master', new AbortController().signal, new HealthBoard().claim('usage')); cleanup.push(() => runtime.dispose())
  const call = await ctx.llm.prepareCall({ provider: 'fixture', model: 'current' })
  for await (const chunk of call.stream({ ...call.config, sessionId: SessionId('child'), messages: [] })) void chunk
  expect(host.runtime.usage.page().calls[0]!.owner).toMatchObject({ ticketId: task, missionId: mission.id, scheduleId: saved.id })
  expect(f.adapter.calls).toHaveLength(1)
})
