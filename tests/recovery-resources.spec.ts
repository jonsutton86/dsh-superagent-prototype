import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { key } from '../src/core/index.ts'
import { verifyContextState } from '../src/recovery/context.ts'
import { verifyBudgetState } from '../src/recovery/budgets.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import { defaultReflection, reflectionPlan } from '../src/workspace/reflection-model.ts'
import type { UsageOwner } from '../src/usage/model.ts'
import type { Store } from '../src/app/store.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
const rid = () => randomUUID(), signal = () => new AbortController().signal
const context = (h: Host) => ({ masterId: h.runtime.masterId, worlds: [], sessions: [...h.agents.values()].map(value => {
  const agent = value as unknown as Agent; return { id: agent.id, header: structuredClone(agent.session.header) }
}) })
const verify = async (h: Host) => ({ context: await verifyContextState(h.runtime.store.db, signal()), budget: await verifyBudgetState(h.runtime.store.db, context(h), signal()) })
function change(store: Store, table: string, identity: string, update: (value: any) => void) {
  const value = JSON.parse(String(store.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(identity)!.value)); update(value)
  store.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), identity)
}
async function fixture() {
  const h = await startRuntime(undefined, { executionMode: 'local', noAccounts: true }); cleanup.push(() => h.stop())
  await h.controller.create({ sessionId: h.runtime.masterId })
  const r = h.runtime, owner: UsageOwner = { role: 'orchestrator', sessionId: r.masterId, root: r.masterId }
  r.usage.bind(owner.sessionId, owner.root)
  const price = { provider: 'fixture', model: 'current', input: 1000000, output: 3000000, cacheRead: 100000, cacheWrite: 2000000, note: 'Synthetic rates' }
  r.usage.configure({ requestId: rid(), revision: 0, prices: [price], budgets: [] })
  const record = r.library.publish({ requestId: rid(), kind: 'memory', title: 'Original evidence', summary: 'Captured facts', content: 'Captured fact' })
  return { h, r, owner, price, record }
}
async function reflection(f: Awaited<ReturnType<typeof fixture>>) {
  const { r } = f, source = r.workspace.create({ requestId: rid(), title: 'Source mission', objective: 'Remember the original evidence', acceptance: 'Operator review' })
  const spec = { ...defaultReflection, missionIds: [source.id] }
  const schedule = r.schedules.create({ requestId: rid(), enabled: true, definition: { title: 'Reflect', cadence: { kind: 'once', at: new Date().toISOString() },
    missed: 'latest', maxRuns: 1, maxOpen: 1, reflection: spec, plan: reflectionPlan(spec) } })
  r.schedules.tick(); await r.idle()
  const run = r.reflections.get(r.schedules.get(schedule.id).occurrences[0]!.id), ticketId = r.workspace.get(run.missionId).actions[0]!.runs[0]!
  r.reflections.read(ticketId, { limit: 400 })
  const proposal = r.reflections.propose(ticketId, { requestId: rid(), rationale: 'Preserve captured knowledge', evidence: { records: [f.record.id] },
    candidate: { kind: 'memory', title: 'Lesson', summary: 'Derived lesson', content: 'Preserve original records.' } })
  return { run, proposal, source, ticketId }
}

it('preserves original reflection selection, read charges and reviewed history after source edits and policy changes', async () => {
  const f = await fixture(), { h, r } = f, reflected = await reflection(f)
  r.reflections.review(reflected.run.id, reflected.proposal.id, { requestId: rid(), revision: 1, decision: 'approve', note: 'Reviewed captured evidence' })
  r.workspace.add(reflected.source.id, { requestId: rid(), revision: reflected.source.revision, title: 'Later work', instructions: 'Review later evidence', owner: 'person' })
  r.library.archive(f.record.id, { requestId: rid(), revision: f.record.revision, archived: true })
  const before = recoveryStateDigest(r.store.db), result = await verify(h)
  expect(result.context).toMatchObject({ reflectionRuns: 1, proposals: 1, capturedMissions: 1, capturedRecords: 1, readOwners: 1, readCalls: 1, legacySnapshots: 0 })
  expect(await verify(h)).toEqual(result); expect(recoveryStateDigest(r.store.db)).toBe(before)
})

it('keeps completed, failed and interrupted recall charges under their original cumulative policies', async () => {
  const { h, r, record } = await fixture(), recall = r.library.recall, actor = { role: 'router' as const }
  const policy = recall.configuration().policy
  recall.configure({ requestId: rid(), revision: 0, policy: { ...policy, owner: { ...policy.owner, calls: 3 } } })
  recall.read({ id: record.id }, actor, signal())
  expect(() => recall.read({ id: rid() }, actor, signal())).toThrow('not found')
  recall.search({}, actor, signal())
  const last = recall.state().attempts[0]!
  change(r.store, 'workspace_recall_attempt', last.id, value => { value.phase = 'reserved'; value.charged = value.reserved; delete value.truncated })
  const before = recoveryStateDigest(r.store.db)
  expect((await verify(h)).context).toMatchObject({ recallAttempts: 3, failedRecall: 1, reservedRecall: 1, recallOwners: 1 })
  expect(recoveryStateDigest(r.store.db)).toBe(before)
  expect(() => recall.search({}, actor, signal())).toThrow('allowance exhausted')
})

it('retains model liabilities, prices, original provider reports and explicit reconciliation across later budget reductions', async () => {
  const { h, r, owner, price } = await fixture(), pending = r.usage.begin(owner, 'fixture', 'current', 'conversation', 100)
  const reported = r.usage.begin(owner, 'fixture', 'current', 'conversation', 100)
  r.usage.settle(reported.id, 'stop', { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalTokens: 100 })
  const unpriced = r.usage.begin(owner, 'other', 'current', 'conversation', 100)
  r.usage.settle(unpriced.id, 'stop', { inputTokens: 1, outputTokens: 2 })
  r.usage.reconcile(unpriced.id, { requestId: rid(), tokens: { inputTokens: 1, outputTokens: 3 }, cost: 5, note: 'Provider record inspected' })
  r.usage.configure({ requestId: rid(), revision: 1, prices: [{ ...price, output: 9000000 }],
    budgets: [{ id: 'lowered', title: 'Lower future spending', scope: { kind: 'workspace' }, period: 'lifetime', enabled: true, calls: 1 }] })
  let before = recoveryStateDigest(r.store.db)
  expect((await verify(h)).budget).toMatchObject({ calls: 3, pendingCalls: 1, reconciledCalls: 1, tokens: 104, cost: 158, reservedTokens: 100, reservedCost: 300 })
  expect(recoveryStateDigest(r.store.db)).toBe(before)
  r.usage.interrupted(); before = recoveryStateDigest(r.store.db)
  expect((await verify(h)).budget).toMatchObject({ pendingCalls: 0, unknownCalls: 1, reservedTokens: 100, reservedCost: 300 })
  expect(r.usage.get(pending.id).phase).toBe('unknown'); expect(recoveryStateDigest(r.store.db)).toBe(before)
  expect(() => r.usage.begin(owner, 'fixture', 'current', 'conversation', 100)).toThrow('call limit')
})

it('rejects substituted snapshots, proposals, counters, request receipts, model charges and attribution without changing state', async () => {
  const f = await fixture(), { h, r, owner, record } = f, reflected = await reflection(f)
  r.library.recall.read({ id: record.id }, { role: 'router' }, signal())
  const attempt = r.library.recall.state().attempts[0]!, call = r.usage.begin(owner, 'fixture', 'current', 'conversation', 100)
  r.usage.settle(call.id, 'stop', { inputTokens: 2, outputTokens: 3 })
  const changes = [
    () => change(r.store, 'workspace_reflection', reflected.run.id, value => { value.snapshot.guidance = 'Substituted private instructions' }),
    () => change(r.store, 'workspace_reflection', reflected.run.id, value => { value.snapshot.records[0].value.content = 'Changed evidence'; value.snapshotHash = key(JSON.stringify(value.snapshot)); value.bytes = Buffer.byteLength(JSON.stringify(value.snapshot)) }),
    () => change(r.store, 'workspace_reflection_proposal', reflected.proposal.id, value => { value.evidence.records = [rid()] }),
    () => r.store.db.exec('UPDATE workspace_reflection_read SET calls=101'),
    () => r.store.db.exec("UPDATE workspace_reflection_command SET fingerprint='bad'"),
    () => change(r.store, 'workspace_recall_attempt', attempt.id, value => { value.charged.bytes = value.reserved.bytes + 1 }),
    () => change(r.store, 'workspace_recall_attempt', attempt.id, value => { value.owner.id = 'router:2000-01-01' }),
    () => change(r.store, 'usage_call', call.id, value => { value.totalTokens++ }),
    () => change(r.store, 'usage_call', call.id, value => { value.cost++ }),
    () => change(r.store, 'usage_call', call.id, value => { value.reservedCost++ }),
    () => change(r.store, 'usage_call', call.id, value => { value.price.input++ }),
    () => change(r.store, 'usage_call', call.id, value => { value.owner.root = 'different-owner' }),
    () => r.store.db.exec('DELETE FROM usage_command'),
    () => r.store.db.exec('DELETE FROM usage_session'),
  ]
  for (const mutate of changes) {
    r.store.db.exec('SAVEPOINT corrupt_resource')
    try { mutate(); const before = recoveryStateDigest(r.store.db); await expect(verify(h)).rejects.toThrow('recovery_'); expect(recoveryStateDigest(r.store.db)).toBe(before) }
    finally { r.store.db.exec('ROLLBACK TO corrupt_resource; RELEASE corrupt_resource') }
  }
})

it('checks actual Session ancestry and worker assignment attribution for model-call descendants', async () => {
  const f = await fixture(), { h, r } = f, reflected = await reflection(f), ticket = r.store.tickets.get(reflected.ticketId)!, root = `worker-${ticket.id}`
  await h.controller.create({ sessionId: 'accounted-child' })
  Object.assign((h.agents.get('accounted-child')! as unknown as Agent).session.header, { parentSession: root })
  r.usage.bind('accounted-child', root)
  const owner: UsageOwner = { sessionId: 'accounted-child', root, role: 'worker', ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)!.id,
    missionId: reflected.run.missionId, scheduleId: reflected.run.scheduleId }
  const call = r.usage.begin(owner, 'fixture', 'current', 'conversation', 100); r.usage.settle(call.id, 'stop', { inputTokens: 1, outputTokens: 1 })
  expect((await verify(h)).budget).toMatchObject({ calls: 1, legacyAssignments: 0 })
  const input = context(h); Object.assign(input.sessions.find(item => item.id === 'accounted-child')!.header, { parentSession: r.masterId })
  await expect(verifyBudgetState(r.store.db, input, signal())).rejects.toThrow('usage_session_binding')
})

it('preserves opaque legacy command receipts and snapshot versions without manufacturing missing evidence', async () => {
  const f = await fixture(), reflected = await reflection(f)
  f.r.store.db.exec('UPDATE usage_command SET request=NULL')
  change(f.r.store, 'workspace_reflection', reflected.run.id, value => { delete value.captureVersion })
  const before = recoveryStateDigest(f.r.store.db), result = await verify(f.h)
  expect(result.budget.legacyCommands).toBe(1); expect(result.context.legacySnapshots).toBe(1)
  expect(recoveryStateDigest(f.r.store.db)).toBe(before)
})

it('keeps actual speculative work held through unknown usage and preserves reviewed publication after release', async () => {
  const f = await fixture(), { h, r } = f, sent = vi.fn(async () => 'sent' as const)
  r.sources.register({ kind: 'probe', title: { en: 'Probe', zh: '测试' }, description: { en: '', zh: '' }, schema: z.object({}), fields: [], health: [],
    scope: () => ({ listened: true, observed: true }), channel: { send: sent, link: () => ({ url: '', label: { en: 'Fixture', zh: '测试' } }) } })
  await r.settings.save('eval', { ...r.store.settings().eval, mode: 'auto' }, r.store.blockRevision('eval'), 'panel')
  const policy = r.store.settings().policy
  await r.settings.save('policy', { ...policy, sources: { ...policy.sources, probe: { allowed: [{ id: 'alice' }], admission: {} } },
    rules: [{ id: 'probe', name: 'Prepare', enabled: true, instruction: 'Prepare local evidence' }] }, r.store.blockRevision('policy'), 'panel')
  const trigger = { id: 'budget-probe', source: 'probe', threads: [{ source: 'probe', id: '1' }], actor: { source: 'probe', id: 'alice' }, human: true,
    at: new Date().toISOString(), text: 'A preparation opportunity', meta: {}, channel: { source: 'probe', thread: 'probe:1', address: { id: 'sink' } } }
  r.receive(trigger)
  const decision = r.engine.decide(trigger.id, { kind: 'accept', title: 'Prepare', name: 'prepare-budget', scope: 'Synthetic work', reason: 'Fixture assessment', rules: ['probe'], acknowledgement: 'Preparation acknowledgement' })
  if (decision.kind !== 'accept') throw new Error('Expected admitted fixture')
  await r.pump(); await r.idle()
  const ticket = r.store.tickets.get(decision.ticketId!)!, run = r.speculation.page().items[0]!, root = `worker-${ticket.id}`
  r.usage.bind(root, root)
  const call = r.usage.begin({ sessionId: root, root, role: 'worker', ticketId: ticket.id, assignmentId: run.assignmentId }, run.providers[0]!, 'current', 'conversation', 100)
  r.usage.settle(call.id, 'interrupted'); r.engine.report(ticket.id, { state: 'ready', summary: 'Original prepared result' }); await r.idle(); await r.speculation.tick()
  const before = recoveryStateDigest(r.store.db)
  expect((await verify(h)).budget).toMatchObject({ speculativeRuns: 1, heldAllocations: 1, unknownCalls: 1, releasedAllocations: 0, legacyPolicies: 0 })
  expect(recoveryStateDigest(r.store.db)).toBe(before)
  r.usage.reconcile(call.id, { requestId: rid(), tokens: { inputTokens: 2, outputTokens: 3 }, cost: 0, note: 'Provider settlement verified' })
  await vi.waitFor(async () => { await r.speculation.tick(); expect(r.speculation.get(run.id).releasedAt).toBeDefined() })
  const ready = r.speculation.get(run.id), promoted = r.speculation.review(run.id, { requestId: rid(), revision: ready.revision, command: 'promote', evidence: ready.evidence, note: 'Promote original evidence' })
  const message = promoted.messages.find(item => item.id === key('ack', trigger.id))!
  r.speculation.approveMessage(run.id, { requestId: rid(), revision: promoted.revision, receiptId: message.id, fingerprint: message.fingerprint, note: 'Review original message' })
  expect((await verify(h)).budget).toMatchObject({ heldAllocations: 0, releasedAllocations: 1, promotedRuns: 1, approvedMessages: 1 })
  change(r.store, 'speculation_run', run.id, value => { value.allowance.tokens++ })
  await expect(verify(h)).rejects.toThrow('speculation_allowance')
})

it('observes cancellation and refuses oversized evidence with bounded static diagnostics', async () => {
  const { h, r } = await fixture(), aborted = new AbortController(); aborted.abort(new Error('Cancelled inspection'))
  await expect(verifyContextState(r.store.db, aborted.signal)).rejects.toThrow('Cancelled inspection')
  await expect(verifyBudgetState(r.store.db, context(h), aborted.signal)).rejects.toThrow('Cancelled inspection')
  r.store.db.prepare('UPDATE usage_command SET request=?').run('private-evidence-'.repeat(600000))
  await expect(verify(h)).rejects.toThrow('recovery_budgets_limit: usage_command')
})
