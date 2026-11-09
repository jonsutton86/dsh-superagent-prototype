import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Candidate, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { reconcileStateGraph } from '../src/recovery/graph.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'

const stores: { store: Store; directory: string }[] = []
afterEach(() => { for (const { store, directory } of stores.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }) } })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-recovery-graph-')), store = new Store(join(directory, 'state.sqlite')); stores.push({ store, directory })
  const effects = new Effects(store, new HealthBoard()), candidates: Candidate[] = []
  let clock = Date.parse('2026-01-02T03:04:05.000Z')
  const engine = new Engine({ repo: store, now: () => new Date(clock).toISOString(),
    scope: { scope: trigger => trigger.meta.filtered ? { listened: false, reason: 'not-listened' } : { listened: true, observed: false } },
    policy: () => ({ version: 'policy-v1', paused: false, evalTimeoutMs: 60_000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }),
      revalidate: () => true, admitsInferred: () => false }),
    assessor: { request: candidate => { candidates.push(candidate); effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id }) }, release: () => {} },
    executor: { start: (ticket, assignment) => effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id }),
      deliver: ticket => effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }), stop: () => {} },
    outbox: { send: message => { store.receipts.add(message); effects.enqueue('reply', message.id, {}) },
      status: id => store.receipts.get(id)?.status, withdraw: id => { store.db.prepare('DELETE FROM outbox WHERE id=?').run(id); effects.cancel('reply', id) } },
  })
  const trigger = (id: string, overrides: Partial<Trigger> = {}): Trigger => ({ id, source: 'chat', threads: [{ source: 'chat', id: 'thread' }],
    actor: { source: 'chat', id: 'operator' }, human: true, at: new Date(clock).toISOString(), text: 'Please perform the task',
    channel: { source: 'chat', thread: 'thread', address: {} }, meta: {}, ...overrides })
  const accept = (id = 'request', thread = 'thread') => {
    engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] })); engine.evaluateDue()
    const decision = engine.decide(id, { kind: 'accept', title: 'Requested task', scope: 'Only the requested task', reason: 'Explicit request',
      acknowledgement: 'Accepted', evalId: candidates.at(-1)!.evalId })
    return store.tickets.get(decision.ticketId!)!
  }
  const reconcile = (signal = new AbortController().signal) => reconcileStateGraph(store.db, signal)
  return { store, effects, engine, trigger, accept, candidates, reconcile, tick: (ms: number) => { clock += ms } }
}
const aggregates = (store: Store) => ['trigger', 'disposition', 'thread', 'decision', 'ticket', 'outbox'].map(table =>
  store.db.prepare(`SELECT value FROM ${table} ORDER BY value`).all())

it('reconciles actual Engine decisions, fanout, directed inputs and correlation without changing recorded authority', async () => {
  const f = fixture(), first = f.accept(), second = f.accept('other', 'other-thread')
  f.engine.assignmentStarted(first.id, first.assignments[0]!.id)
  f.engine.assignmentStarted(second.id, second.assignments[0]!.id)
  f.engine.receive(f.trigger('shared', { threads: [{ source: 'chat', id: 'thread' }, { source: 'chat', id: 'other-thread' }] }))
  f.engine.receiveForTicket(f.trigger('directed'), first.id)
  f.engine.receive(f.trigger('filtered', { threads: [{ source: 'chat', id: 'unobserved' }], meta: { filtered: true } }))
  f.engine.receive(f.trigger('waiting', { threads: [{ source: 'chat', id: 'pending-thread' }] })); f.engine.evaluateDue()
  const before = aggregates(f.store), result = await f.reconcile()
  expect(aggregates(f.store)).toEqual(before)
  expect(result).toMatchObject({ version: 1, triggers: 6, dispositions: 6, threads: 3, tickets: 2, decisions: 2,
    assignments: 2, evaluations: 1, retiredEffects: 4, historicalEvaluations: 0,
    indexes: { triggerTimes: 0, triggerThreads: 0, decisionThreads: 0 }, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(f.effects.pending('assessment', f.candidates.at(-1)!.evalId)).toBe(true)
  expect(f.effects.pending('delivery', first.id)).toBe(true)
  expect(f.effects.pending('delivery', second.id)).toBe(true)
})

it('repairs derived indexes exactly once, retaining original JSON and current effect scheduling metadata', async () => {
  const f = fixture(), ticket = f.accept()
  f.store.db.exec("UPDATE trigger SET at='wrong'; UPDATE decision SET thread='wrong'; DELETE FROM trigger_thread; INSERT INTO trigger_thread VALUES ('wrong','ghost','wrong',0)")
  f.effects.enqueue('relay', 'steer', { text: 'Original steering' }); f.effects.enqueue('notice', 'status', { value: { ready: true }, summary: 'Original notice' })
  f.store.db.exec("UPDATE effect SET attempts=4,generation=7,error='Retry later',due=12345")
  const before = aggregates(f.store), pending = f.store.db.prepare("SELECT * FROM effect WHERE kind!='assessment' ORDER BY seq").all()
  expect(await f.reconcile()).toMatchObject({ indexes: { triggerTimes: 1, triggerThreads: 2, decisionThreads: 1 }, retiredEffects: 1 })
  expect(aggregates(f.store)).toEqual(before)
  expect(f.store.db.prepare('SELECT * FROM effect ORDER BY seq').all()).toEqual(pending)
  expect(f.store.db.prepare('SELECT id FROM trigger_thread WHERE thread=?').all('chat:thread')).toEqual([{ id: 'request' }])
  expect(f.effects.pending('launch', ticket.assignments[0]!.id)).toBe(true)
  const stable = await f.reconcile(), again = await f.reconcile()
  expect(stable).toEqual(again)
  expect(stable).toMatchObject({ indexes: { triggerTimes: 0, triggerThreads: 0, decisionThreads: 0 }, retiredEffects: 0 })
})

it('retires settled replies and obsolete launches and deliveries without replaying any effects', async () => {
  const f = fixture(), ticket = f.accept()
  f.engine.receive(f.trigger('followup'))
  f.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  const current = f.store.tickets.get(ticket.id)!
  f.engine.inputsDelivered(ticket.id, current.assignments[0]!.id, current.undelivered)
  for (const row of f.store.db.prepare('SELECT value FROM outbox').all()) f.store.receipts.settle(JSON.parse(String(row.value)), 'sent')
  const result = await f.reconcile()
  expect(result.retiredEffects).toBe(4)
  expect(f.store.db.prepare('SELECT * FROM effect').all()).toEqual([])
  expect(f.store.tickets.get(ticket.id)?.assignments[0]?.state).toBe('running')
})

it('retains expired evaluation tags as history and removes the exact assessment the handler can no longer deliver', async () => {
  const f = fixture()
  f.engine.receive(f.trigger('request')); f.engine.evaluateDue()
  const first = f.candidates[0]!
  f.engine.candidateDelivered(first.evalId); f.tick(60_001); f.engine.evaluateDue()
  const before = aggregates(f.store), result = await f.reconcile()
  expect(result.retiredEffects).toBe(1)
  expect(aggregates(f.store)).toEqual(before)
  expect(f.effects.pending('assessment', first.evalId)).toBe(false)
  // Depending on the Engine's scheduling pass, the trigger is pending or already held by the next Eval.
  expect(f.store.threads.get('chat:thread')!.pending.length + Number(!!f.store.threads.get('chat:thread')!.evaluating)).toBeGreaterThan(0)
})

it('retains historical disposition context after a ticket lets go of a trigger', async () => {
  const f = fixture(), ticket = f.accept()
  const disposition = f.store.triggers.disposition('request')!
  f.store.triggers.saveDisposition('request', { ...disposition, fanout: [], context: [ticket.id], evalId: 'expired-historical-eval' })
  expect(await f.reconcile()).toMatchObject({ historicalEvaluations: 1 })
  expect(f.store.triggers.disposition('request')?.context).toEqual([ticket.id])
})

it.each(['mandate', 'origin', 'input', 'assignment', 'acceptance', 'directed', 'pending-reply', 'effect', 'effect-kind', 'effect-key-limit', 'shape'] as const)(
  'holds a conflicting %s without partially repairing state', async conflict => {
    const f = fixture(), ticket = f.accept()
    f.store.db.exec("UPDATE trigger SET at='wrong'; DELETE FROM trigger_thread")
    if (conflict === 'mandate') { ticket.mandate.scope = 'New unauthorized work'; f.store.tickets.save(ticket) }
    if (conflict === 'origin') { ticket.origin.triggerIds = ['unknown']; f.store.tickets.save(ticket) }
    if (conflict === 'input') { ticket.inputs.push({ id: 'bad-input', kind: 'trigger', triggerId: 'request', at: ticket.createdAt, deliveredTo: 'unknown' }); f.store.tickets.save(ticket) }
    if (conflict === 'assignment') { ticket.assignments.push({ ...ticket.assignments[0]!, id: 'second-live' }); f.store.tickets.save(ticket) }
    if (conflict === 'acceptance') { const decision = f.store.decisions.get(ticket.decisionId)!; f.store.decisions.save({ ...decision, id: 'extra', evalId: 'extra' }) }
    if (conflict === 'directed') f.store.triggers.saveDisposition('request', { ...f.store.triggers.disposition('request')!, recipient: ticket.id })
    if (conflict === 'pending-reply') f.store.db.exec("DELETE FROM effect WHERE kind='reply'")
    if (conflict === 'effect') f.store.db.exec("UPDATE effect SET key='wrong' WHERE kind='launch'")
    if (conflict === 'effect-kind') f.store.db.exec("UPDATE effect SET kind='unknown' WHERE kind='launch'")
    if (conflict === 'effect-key-limit') f.store.db.prepare("UPDATE effect SET key=? WHERE kind='reply'").run('x'.repeat(4097))
    if (conflict === 'shape') f.store.db.exec("UPDATE disposition SET value='{}'")
    const before = recoveryStateDigest(f.store.db)
    await expect(f.reconcile()).rejects.toThrow('recovery_graph_')
    expect(recoveryStateDigest(f.store.db)).toBe(before)
  })

it('rejects a directed human input delivered to another otherwise valid ticket', async () => {
  const f = fixture(), first = f.accept(), second = f.accept('second', 'second-thread')
  f.engine.receiveForTicket(f.trigger('directed'), first.id)
  const original = f.store.tickets.get(first.id)!.inputs.find(input => input.kind === 'trigger' && input.triggerId === 'directed')!
  second.inputs.push({ ...original, id: 'misdirected' }); f.store.tickets.save(second)
  await expect(f.reconcile()).rejects.toThrow('recovery_graph_directed_authority')
})

it('rolls back repairs if cancelled after the first index write', async () => {
  const f = fixture(); f.accept()
  f.store.db.exec('DELETE FROM trigger_thread')
  const controller = new AbortController()
  f.store.db.function('abort_reconciliation', () => { controller.abort(); return 0 })
  f.store.db.exec('CREATE TRIGGER abort_index AFTER INSERT ON trigger_thread BEGIN SELECT abort_reconciliation(); END')
  const before = recoveryStateDigest(f.store.db)
  await expect(f.reconcile(controller.signal)).rejects.toThrow()
  expect(recoveryStateDigest(f.store.db)).toBe(before)
})

it('preserves completed and human-resumed assignments without manufacturing missing legacy launch effects', async () => {
  const f = fixture(), ticket = f.accept()
  f.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  f.engine.report(ticket.id, { state: 'ready', summary: 'The original work is complete' })
  expect(f.store.tickets.get(ticket.id)?.ended).toBeDefined()
  await f.reconcile()
  f.tick(1000); f.engine.receive(f.trigger('resume'))
  const resumed = f.store.tickets.get(ticket.id)!
  expect(resumed.ended).toBeUndefined(); expect(resumed.assignments).toHaveLength(2)
  f.effects.cancel('launch', resumed.assignments[1]!.id)
  const before = aggregates(f.store)
  expect(await f.reconcile()).toMatchObject({ assignments: 2, tickets: 1, retiredEffects: 0 })
  expect(aggregates(f.store)).toEqual(before)
  expect(f.effects.pending('launch')).toBe(false)
})

it('rejects inflated human authority and a current evaluation whose primary actor changed', async () => {
  const f = fixture(), ticket = f.accept()
  const bot = f.trigger('bot', { human: false, actor: { source: 'chat', id: 'bot' } })
  f.engine.receive(bot)
  const current = f.store.tickets.get(ticket.id)!, input = current.inputs.find(input => input.kind === 'trigger' && input.triggerId === 'bot')!
  Object.assign(input, { human: true }); f.store.tickets.save(current)
  await expect(f.reconcile()).rejects.toThrow('recovery_graph_input_authority')
  delete (input as { human?: true }).human; f.store.tickets.save(current)
  f.engine.evaluateDue()
  const thread = f.store.threads.get('chat:thread')!
  thread.evaluating!.actor = { source: 'chat', id: 'different-actor' }; f.store.threads.save(thread)
  await expect(f.reconcile()).rejects.toThrow('evaluation_actor')
})

it('bounds oversized records and keeps source bodies out of failure diagnostics', async () => {
  const f = fixture(); f.accept()
  f.store.triggers.save({ ...f.store.triggers.get('request')!, text: 'private-source-content'.repeat(450_000) })
  const before = recoveryStateDigest(f.store.db)
  await expect(f.reconcile()).rejects.toMatchObject({ code: 'shape', message: 'recovery_graph_shape: trigger:request' })
  expect(recoveryStateDigest(f.store.db)).toBe(before)
})

it('yields during a larger batch so cancellation does not wait for all graph checks', async () => {
  const f = fixture()
  f.store.atomic(() => {
    for (let i = 0; i < 300; i++) f.engine.receive(f.trigger(`batch-${i}`))
  })
  f.engine.evaluateDue()
  const before = recoveryStateDigest(f.store.db), controller = new AbortController()
  const cancellation = setImmediate(() => controller.abort())
  try { await expect(f.reconcile(controller.signal)).rejects.toThrow() } finally { clearImmediate(cancellation) }
  expect(recoveryStateDigest(f.store.db)).toBe(before)
  expect(await f.reconcile()).toMatchObject({ triggers: 300, evaluations: 1, retiredEffects: 0 })
})
