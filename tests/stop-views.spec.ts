import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { stopHold } from '../src/executor/stop-view.ts'
import { StopHoldViewSchema } from '../src/executor/stop-view-model.ts'
import { saveStop } from '../src/executor/stop-store.ts'
import { ticketDetail, ticketList } from '../src/app/views/tickets.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Supervision } from '../src/supervision/service.ts'
import { WatchdogJournal } from '../src/supervision/journal.ts'
import { stopRecord } from './fixtures/stop-record.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import type { Ticket } from '../src/core/model.ts'

const roots: string[] = [], stores: Store[] = [], journals: WatchdogJournal[] = []
let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; for (const value of journals.splice(0)) value.close();
  for (const value of stores.splice(0)) value.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'stop-view-')); roots.push(root)
  const store = new Store(join(root, 'main.sqlite')); stores.push(store)
  const ticket: Ticket = { id: 'ticket', title: 'Original task', decisionId: 'decision', origin: { triggerId: 'trigger', triggerIds: ['trigger'] },
    mandate: { strength: 'explicit', actor: { source: 'workspace', id: 'owner' }, policyVersion: 'v', basis: { via: 'listed' }, scope: 'Original scope' },
    channels: [], inputs: [{ id: 'input-original', kind: 'text', text: 'Saved human input', at: '2026-01-01T00:00:00.000Z' }], undelivered: ['input-original'],
    assignments: [{ id: 'assignment-old', state: 'ended', createdAt: '2026-01-01T00:00:00.000Z', endedReason: 'retried' },
      { id: 'assignment-pending', state: 'pending', createdAt: '2026-01-01T00:00:00.000Z' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  store.tickets.save(ticket)
  return { root, store, ticket }
}

it('projects exact original identities and total counts with bounded samples, without changing the ticket or stop records', () => {
  const { store, ticket } = setup()
  for (let index = 0; index < 7; index++) saveStop(store.db, stopRecord(ticket, { id: `stop-${index}` }))
  const before = store.db.prepare('SELECT value FROM executor_stop ORDER BY id').all()
  const hold = stopHold(store, ticket)!
  expect(hold).toMatchObject({ held: true, count: 7, truncated: true, pendingAssignmentId: 'assignment-pending', pendingInputs: 1 })
  expect(hold.originals).toHaveLength(4); expect(hold.originals.every(item => item.assignmentId === 'assignment-old')).toBe(true)
  expect(stopHold(store, ticket)).toEqual(hold)
  expect(StopHoldViewSchema.safeParse(hold).success).toBe(true)
  expect(StopHoldViewSchema.safeParse({ ...hold, count: 1 }).success).toBe(false)
  expect(StopHoldViewSchema.safeParse({ ...hold, originals: [{ ...hold.originals[0], state: 'quiet', proof: 'registry' }] }).success).toBe(false)
  expect(store.db.prepare('SELECT value FROM executor_stop ORDER BY id').all()).toEqual(before)
  expect(store.tickets.get(ticket.id)).toEqual(ticket)
  const changed = stopRecord(ticket, { id: 'stop-0', state: 'observing', revision: 2 }); saveStop(store.db, changed)
  expect(stopHold(store, ticket)?.revision).not.toBe(hold.revision)
})

it('keeps a single ended assignment visible in task detail/list and supervision without nudge or review-budget replenishment', () => {
  const { store, ticket, root } = setup(); ticket.assignments.pop(); ticket.ended = { by: 'human', outcome: 'stopped', at: ticket.updatedAt }
  store.tickets.save(ticket); const stop = stopRecord(ticket); saveStop(store.db, stop)
  const other = stopRecord(ticket, { id: 'second-stop' }); saveStop(store.db, other)
  const views = { store, sources: new SourceRegistry(() => store.settings()), links: () => ({}) as never }
  expect(ticketList(views, 'open', 0, 20).items).toHaveLength(1)
  expect(ticketDetail(views, ticket.id)).toMatchObject({ stage: 'ended', stopHold: { held: true, count: 2 }, assignments: [{ id: 'assignment-old' }] })
  const note = vi.fn(), supervisor = new Supervision({ store, engine: { note }, stateDir: root, configured: () => true, health: () => ({}) })
  const journal = new WatchdogJournal(join(root, 'watchdog.sqlite')); journals.push(journal)
  const initial = supervisor.snapshot(); expect(initial.tickets[0]).toMatchObject({ stage: 'ended', canNudge: false, stopHold: { held: true } })
  journal.reconcile(initial, 100000, 1000, 3600000)
  const incident = journal.open()[0]!, reserved = journal.reserve(incident.id, 100000, 1000)!
  const delivery = reserved.delivery!.id, cycle = reserved.cycleAt
  saveStop(store.db, { ...stop, state: 'observing', revision: 2 })
  const material = supervisor.snapshot(); expect(material.tickets[0]!.episodeRevision).toBe(initial.tickets[0]!.episodeRevision)
  expect(material.tickets[0]!.revision).not.toBe(initial.tickets[0]!.revision)
  journal.reconcile(material, 100001, 1000, 3600000)
  expect(journal.get(incident.id)).toMatchObject({ cycleAt: cycle, attempts: reserved.attempts, delivery: { id: delivery } })
  saveStop(store.db, { ...other, state: 'quiet', proof: 'registry', settledAt: '2026-01-01T00:00:01.000Z', revision: 2 })
  const partial = supervisor.snapshot()
  expect(partial.tickets[0]!.stopHold?.count).toBe(1)
  expect(partial.tickets[0]!.episodeRevision).toBe(initial.tickets[0]!.episodeRevision)
  journal.reconcile(partial, 100002, 1000, 3600000)
  expect(journal.get(incident.id)).toMatchObject({ cycleAt: cycle, attempts: reserved.attempts, delivery: { id: delivery } })
  store.saveSettings({ ...store.settings(), paused: true }); journal.reconcile(supervisor.snapshot(), 100002, 1000, 3600000)
  expect(journal.open()).toHaveLength(1); expect(note).not.toHaveBeenCalled()
  saveStop(store.db, { ...stop, state: 'quiet', proof: 'registry', settledAt: '2026-01-01T00:00:01.000Z', revision: 3 })
  expect(supervisor.snapshot().tickets).toEqual([])
})

it('uses the same hold in mission and inbox while retaining pending assignment and saved input IDs', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const item = host.runtime.inbox.start({ requestId: 'held-task', text: 'Prepare evidence' }); await host.runtime.idle()
  const ticket = host.runtime.store.tickets.get(item.id)!, original = ticket.assignments[0]!.id
  saveStop(host.runtime.store.db, stopRecord(ticket))
  const before = host.runtime.store.tickets.get(item.id)
  expect(host.runtime.inbox.item(item.id)).toMatchObject({ status: 'blocked', stopHold: { originals: [{ assignmentId: original }] } })
  expect(host.runtime.workspace.get(item.mission!.id).actions[0]).toMatchObject({ status: 'blocked', ticket: { retryable: false, stopHold: { held: true } } })
  expect(host.runtime.store.tickets.get(item.id)).toEqual(before)
})
