import { afterEach, expect, it, vi } from 'vitest'
import { latestAssignment } from '../src/core/index.ts'
import { Usage } from '../src/usage/service.ts'
import { speculationFixture } from './fixtures/speculation.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function fixture(path?: string) { const f = speculationFixture(path); cleanup.push(f.dispose); return f }
const review = (run: { revision: number; evidence?: string }, command = 'promote', requestId = command) => ({ requestId, revision: run.revision, evidence: run.evidence, command, note: 'Checked original evidence and intended scope' })

it('serializes competing admissions against the last reserved slot before execution', async () => {
  const f = fixture(); f.policy(p => { p.limits.workspace.concurrent = 1 })
  const a = f.ticket(), b = f.ticket('second')
  const results = await Promise.allSettled([f.admit(a), f.admit(b)])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(f.spec.held()).toEqual([a.id]); expect(f.run(b).state).toBe('proposed')
  await f.admit(a); expect(f.run(a).revision).toBe(2)
})
it.each(['owner', 'provider', 'environment'] as const)('reserves independently for each %s without bypassing the workspace limit', async dimension => {
  const f = fixture(); f.policy(p => { p.limits[dimension].concurrent = 1 })
  const a = f.ticket(), b = f.ticket('second'); await f.admit(a)
  await expect(f.admit(b)).rejects.toThrow(dimension)
  const c = f.ticket('third', 'inferred', dimension === 'owner' ? 'bob' : 'alice', dimension === 'environment' ? 'other' : 'local')
  if (dimension === 'provider') f.provider.mockResolvedValue('other')
  await f.admit(c); expect(f.spec.held()).toHaveLength(2)
})
it('reserves actual provider changes atomically, enforces run ceilings and binds calls to the assignment', async () => {
  const f = fixture(); f.policy(p => { p.limits.provider.concurrent = 1; p.run.calls = 1 })
  const a = f.ticket(), b = f.ticket('second'); await f.admit(a); f.provider.mockResolvedValue('other'); await f.admit(b)
  expect(() => f.call(a, 'other')).toThrow('provider'); expect(f.run(a).providers).toEqual(['fixture']); expect(f.run(a).usage.calls).toBe(0)
  expect(() => f.call(a, 'fixture', 1001)).toThrow('allowance')
  const call = f.call(a); expect(call.owner.speculationId).toBe(f.run(a).id)
  f.usage.settle(call.id, 'stop', { inputTokens: 10, outputTokens: 5 }); expect(() => f.call(a)).toThrow('allowance')
  const old = structuredClone(b); b.assignments.push({ id: 'replacement', state: 'pending', createdAt: b.createdAt }); f.store.tickets.save(b); f.spec.queued(b, latestAssignment(b)!)
  expect(() => f.call(old)).toThrow('not admitted')
})
it('rechecks assignment and authority after asynchronous provider resolution and avoids post-close writes', async () => {
  const f = fixture(); f.policy(); const a = f.ticket()
  let resolve!: (value: string) => void; f.provider.mockReturnValue(new Promise(done => { resolve = done }))
  const pending = f.admit(a); a.assignments.push({ id: 'replacement', state: 'pending', createdAt: a.createdAt }); f.store.tickets.save(a); resolve('fixture')
  await expect(pending).rejects.toThrow('authority'); expect(f.spec.held()).toEqual([])
  const b = f.ticket('second'); f.provider.mockReturnValue(new Promise(done => { resolve = done })); const closing = f.admit(b)
  await f.spec.close(); resolve('fixture'); await expect(closing).rejects.toThrow('stopped')
})
it('preempts for explicit work but retains reservations until execution is quiet, with no new allowance for the same assignment', async () => {
  const f = fixture(); f.policy(); f.capacity(1); f.quiet(false)
  const a = f.ticket(); await f.admit(a); const b = f.ticket('explicit', 'explicit')
  expect(f.run(a)).toMatchObject({ state: 'cancelled', problem: expect.stringContaining('Preempted') })
  await expect(f.admit(b)).rejects.toThrow('quiescent'); await f.spec.tick(); expect(f.spec.held()).toEqual([a.id])
  f.quiet(true); await f.spec.tick(); await f.admit(b); expect(f.spec.held()).toEqual([])
  await expect(f.admit(a)).rejects.toThrow('Preempted'); expect(f.halt).toHaveBeenCalledWith(a.id, expect.stringContaining('Preempted'), latestAssignment(a)!.id)
})
it('holds uncertain model calls across reopen; process attestation cannot release provider uncertainty', async () => {
  const f = fixture(); f.policy(); const a = f.ticket(); await f.admit(a); const call = f.call(a), before = f.run(a)
  await f.close(); const g = fixture(f.directory)
  expect(g.run(a)).toMatchObject({ admittedAt: before.admittedAt, allowance: before.allowance, recovered: true })
  await g.spec.tick(); expect(g.spec.held()).toEqual([a.id])
  g.spec.review(before.id, review(g.run(a), 'reconcile')); await g.spec.tick(); expect(g.spec.held()).toEqual([a.id])
  expect(g.usage.get(call.id).phase).toBe('unknown')
  g.usage.reconcile(call.id, { requestId: 'provider-proof', tokens: { inputTokens: 10, outputTokens: 5 }, cost: 1, note: 'Inspected original provider receipt' })
  await g.spec.tick(); expect(g.spec.held()).toEqual([]); expect(g.run(a)).toMatchObject({ state: 'cancelled', usage: { calls: 1, tokens: 15 } })
})
it('charges retained reservations across midnight and spent usage after release without refunding it', async () => {
  const f = fixture(); f.policy(p => { p.limits.workspace.tokens = 1100; p.run.tokens = 1000; p.run.seconds = 120; for (const quota of Object.values(p.limits)) quota.seconds = 86400 })
  f.clock('2026-11-09T23:59:00Z'); const a = f.ticket(); await f.admit(a); const call = f.call(a); f.usage.settle(call.id, 'stop', { inputTokens: 100, outputTokens: 0 })
  f.clock('2026-11-10T00:00:01Z'); const b = f.ticket('second'); await expect(f.admit(b)).rejects.toThrow('workspace')
  await f.ready(a); await f.admit(b); expect(f.run(a).usage.tokens).toBe(100)
  const c = f.call(b); f.usage.settle(c.id, 'stop', { inputTokens: 101, outputTokens: 0 }); await f.ready(b)
  const third = f.ticket('third'); await expect(f.admit(third)).rejects.toThrow('workspace')
})
it('enforces priced cost reservations and refuses unknown context ceilings', async () => {
  const f = fixture(); f.policy(p => { p.run.cost = 100; for (const quota of Object.values(p.limits)) quota.cost = 100 })
  const a = f.ticket(); await f.admit(a)
  expect(() => f.call(a)).toThrow('allowance')
  f.usage.configure({ requestId: 'prices', revision: 0, budgets: [], prices: [{ provider: 'fixture', model: 'model', input: 1000000, output: 1000000, cacheRead: 1000000, cacheWrite: 1000000, note: 'Fixture USD rates' }] })
  expect(() => f.usage.begin({ sessionId: a.id, root: a.id, role: 'worker', ticketId: a.id, assignmentId: latestAssignment(a)!.id }, 'fixture', 'model', 'conversation')).toThrow('allowance')
  const call = f.call(a); f.usage.settle(call.id, 'stop', { inputTokens: 1, outputTokens: 1 }); expect(() => f.call(a)).toThrow('allowance')
})
it('promotes quiescent evidence without dispatch and requires separate exact-message approval with idempotent retries', async () => {
  const f = fixture(); f.policy(); const a = f.ticket(); await f.admit(a)
  const message = { id: 'outbound', ticketId: a.id, channel: { source: 'fixture', thread: 'fixture:1', address: { id: 'review' } }, text: 'Prepared answer', kind: 'reply' as const }
  f.store.receipts.add(message); const ready = await f.ready(a), count = f.halt.mock.calls.length
  expect(f.spec.messageProblem(message)).toContain('promotion')
  const command = review(ready), promoted = f.spec.review(ready.id, command)
  expect(promoted.state).toBe('promoted'); expect(f.spec.review(ready.id, command)).toEqual(promoted); expect(f.halt).toHaveBeenCalledTimes(count)
  expect(f.spec.messageProblem(message)).toContain('separate')
  const approval = { requestId: 'send', revision: promoted.revision, receiptId: message.id, fingerprint: promoted.messages[0]!.fingerprint, note: 'Exact text and destination reviewed' }
  f.spec.approveMessage(ready.id, approval); f.spec.approveMessage(ready.id, approval); expect(f.spec.messageProblem(message)).toBeUndefined()
  expect(f.spec.messageProblem({ ...message, text: 'Changed text' })).toContain('separate')
  expect(() => f.spec.approveMessage(ready.id, { ...approval, note: 'different' })).toThrow('already used')
  f.advance(24 * 60 * 60000); expect(f.spec.publicationProblem(a.id)).toContain('unexpired')
})
it('blocks stale evidence, changed source authority, disabled policy and expiry without waiting for a clock tick', async () => {
  const f = fixture(); f.policy(); const a = f.ticket(); await f.admit(a); const ready = await f.ready(a)
  f.evidence('changed'); expect(() => f.spec.review(ready.id, review(ready))).toThrow('current')
  f.evidence('initial'); f.authorize(false); expect(() => f.spec.review(ready.id, review(ready))).toThrow('authority')
  f.authorize(true); f.policy(p => { p.enabled = false }); expect(() => f.spec.review(ready.id, review(ready))).toThrow('current')
  f.policy(); const b = f.ticket('second'); await f.admit(b); f.advance(60000)
  expect(f.spec.problem(b)).toContain('expired'); expect(() => f.call(b)).toThrow('expired')
})
it('holds legacy inferred execution with an unknown provider until evidenced reconciliation', async () => {
  const f = fixture(); f.policy(); const a = f.ticket(); f.store.db.prepare('DELETE FROM speculation_run').run()
  await f.close(); const g = fixture(f.directory); expect(g.run(a)).toMatchObject({ state: 'cancelled', recovered: true, providers: [] })
  const b = g.ticket('second'); await expect(g.admit(b)).rejects.toThrow('unknown provider')
  g.spec.review(g.run(a).id, review(g.run(a), 'reconcile')); await g.spec.tick(); await g.admit(b)
})

it('attributes legacy unassigned ticket calls conservatively and retains unknown usage after process reconciliation', async () => {
  const f = fixture(); f.policy(); const a = f.ticket()
  const oldUsage = new Usage(f.store), call = oldUsage.begin({ sessionId: a.id, root: a.id, role: 'worker', ticketId: a.id }, 'legacy-provider', 'model', 'conversation', 100)
  f.store.db.prepare('DELETE FROM speculation_run').run(); await f.close()
  const g = fixture(f.directory), recovered = g.run(a)
  expect(g.usage.get(call.id)).toMatchObject({ phase: 'unknown', owner: { speculationId: recovered.id } })
  g.spec.review(recovered.id, review(recovered, 'reconcile')); await g.spec.tick(); expect(g.spec.held()).toEqual([a.id])
  g.usage.reconcile(call.id, { requestId: 'legacy-receipt', tokens: { inputTokens: 1, outputTokens: 2 }, cost: 0, note: 'Original provider receipt checked' })
  await g.spec.tick(); expect(g.spec.held()).toEqual([]); expect(g.run(a).usage.tokens).toBe(3)
})
it('allows recovery stop promises to settle instead of restarting cancellation before every quiet check', async () => {
  const f = fixture(); f.policy(); const a = f.ticket(); await f.admit(a); await f.close()
  const g = fixture(f.directory)
  g.halt.mockImplementation(() => { g.quiet(false); queueMicrotask(() => g.quiet(true)) })
  const run = g.run(a); g.spec.review(run.id, review(run, 'reconcile'))
  await g.spec.tick(); expect(g.spec.held()).toEqual([a.id])
  await g.spec.tick(); expect(g.spec.held()).toEqual([]); expect(g.halt).toHaveBeenCalledOnce()
})
