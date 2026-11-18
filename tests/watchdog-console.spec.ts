import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { request as httpRequest } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { WatchdogJournal } from '../src/supervision/journal.ts'
import { ACK_WINDOW_MS, DEFAULT_RETENTION, type Acknowledge } from '../src/supervision/protocol.ts'
import { watchdogFixture, watchdogServer } from './fixtures/watchdog.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
function fixture() { const h = watchdogFixture(); cleanup.push(h.dispose); return h }
const command = (journal: WatchdogJournal, now: number): Acknowledge => {
  const item = journal.view(journal.open()[0]!)
  return { requestId: `wd-${now}-${randomUUID()}`, incidentId: item.id, revision: item.viewRevision, note: 'Investigating the platform choice.' }
}

it('keeps acknowledgement separate from resolution and recovers the exact receipt after new evidence and restart', () => {
  const h = fixture(), input = command(h.journal, h.now), first = h.journal.acknowledge(input, h.now)
  expect(h.journal.counts()).toMatchObject({ open: 1, unacknowledged: 0 })
  const original = h.journal.open()[0]!
  h.journal.assess({ incidentId: original.id, incidentRevision: original.revision, finding: 'blocked', evidence: 'The operator must select a platform.' }, h.now)
  expect(h.journal.counts()).toMatchObject({ open: 1, unacknowledged: 1 })
  expect(h.journal.view(h.journal.get(original.id)!)).toMatchObject({ acknowledged: false, acknowledgement: first.acknowledgement })
  expect(h.journal.acknowledge(input, h.now + 1)).toEqual(first)
  expect(() => h.journal.acknowledge({ ...input, note: 'different' }, h.now)).toThrow('request_id_conflict')
  expect(() => h.journal.acknowledge({ ...input, requestId: `wd-${h.now}-${randomUUID()}` }, h.now)).toThrow('incident_changed')
  const restored = new WatchdogJournal(h.file); cleanup.push(() => restored.close())
  expect(restored.acknowledge(input, h.now + 10)).toEqual(first)
  expect(restored.history(original.id).items.filter(item => item.kind === 'acknowledged')).toHaveLength(1)
  h.snapshot.tickets = []; h.journal.reconcile(h.snapshot, h.now + 20, 1000, 3600000)
  expect(restored.acknowledge(input, h.now + 30)).toEqual(first)
  expect(() => restored.acknowledge({ ...input, requestId: `wd-${h.now}-${randomUUID()}`,
    revision: restored.view(restored.get(original.id)!).viewRevision }, h.now)).toThrow('incident_changed')
})

it('migrates an existing schema-one journal without losing its incident or resetting audit sequence', () => {
  const h = fixture(), original = h.journal.open()[0]!
  const old = new DatabaseSync(h.file)
  delete original.viewRevision
  old.prepare('UPDATE incidents SET data=? WHERE id=?').run(JSON.stringify(original), original.id)
  old.exec('DROP TABLE operator_state; DROP TABLE acknowledgements; PRAGMA user_version=1;'); old.close()
  const migrated = new WatchdogJournal(h.file); cleanup.push(() => migrated.close())
  expect(migrated.view(migrated.get(original.id)!).viewRevision).toBe(original.revision)
  const before = migrated.recent()[0]!.seq
  migrated.acknowledge(command(migrated, h.now), h.now)
  expect(migrated.recent()[0]!.seq).toBeGreaterThan(before)
  expect(migrated.counts().unacknowledged).toBe(0)
})

it('pins audit pages and rejects incident pages changed by a concurrent assessment or acknowledgement', () => {
  const h = fixture()
  h.snapshot.tickets = Array.from({ length: 5 }, (_, index) => ({ ...h.snapshot.tickets[0]!, id: `ticket-${index}` }))
  h.journal.reconcile(h.snapshot, h.now + 1, 1000, 3600000)
  const page = h.journal.incidents('open', undefined, 2), next = h.journal.incidents('open', page.cursor!, 2)
  expect(new Set([...page.items, ...next.items].map(item => item.id)).size).toBe(4)
  const history = h.journal.history('', undefined, 2), boundary = history.items[0]!.seq
  h.journal.acknowledge(command(h.journal, h.now), h.now)
  expect(() => h.journal.incidents('open', page.cursor!, 2)).toThrow('incidents_changed_refresh')
  expect(() => h.journal.incidents('closed', page.cursor!, 2)).toThrow('invalid_cursor')
  const older = h.journal.history('', history.cursor!, 2)
  expect(older.items.every(item => item.seq < boundary)).toBe(true)
  expect(new Set([...history.items, ...older.items].map(item => item.seq)).size).toBe(4)
  expect(() => h.journal.history('', 'malformed')).toThrow('invalid_cursor')
})

it('bounds retention, preserves all active incidents, expires replay before pruning receipts, and never reuses audit IDs', () => {
  const h = fixture(), input = command(h.journal, h.now)
  h.journal.acknowledge(input, h.now)
  h.snapshot.tickets = Array.from({ length: 4 }, (_, index) => ({ ...h.snapshot.tickets[0]!, id: `closed-${index}` }))
  h.journal.reconcile(h.snapshot, h.now + 1, 1000, 3600000)
  h.snapshot.tickets = [{ ...h.snapshot.tickets[0]!, id: 'still-active' }]
  h.journal.reconcile(h.snapshot, h.now + 2, 1000, 3600000)
  const history = h.journal.history('', undefined, 2), latest = h.journal.recent()[0]!.seq
  const later = h.now + ACK_WINDOW_MS + 86400000
  const removed = h.journal.maintain(later, { ...DEFAULT_RETENTION, closedDays: 1, auditDays: 1, maxClosed: 1, maxAudit: 1 })
  expect(removed).toMatchObject({ incidents: 5, receipts: 1 }); expect(removed.audit).toBeGreaterThan(0)
  expect(h.journal.counts()).toMatchObject({ open: 1, closed: 0 })
  expect(h.journal.recent()[0]!.seq).toBeGreaterThan(latest)
  expect(() => h.journal.history('', history.cursor!, 2)).toThrow('history_expired_refresh')
  expect(() => h.journal.acknowledge(input, later)).toThrow('acknowledgement_request_expired')
  const restore = new WatchdogJournal(h.file); cleanup.push(() => restore.close())
  expect(() => restore.acknowledge(input, later)).toThrow('acknowledgement_request_expired')
  expect(() => restore.acknowledge(input, h.now)).toThrow('acknowledgement_request_expired') // Wall-clock rollback cannot revive a pruned identity.
  expect(restore.maintain(later, DEFAULT_RETENTION)).toEqual({ incidents: 0, audit: 0, receipts: 0 })
})

it('keeps the newest closed episodes by closure time and caps each cleanup batch', () => {
  const h = fixture()
  h.snapshot.tickets = Array.from({ length: 1100 }, (_, index) => ({ ...h.snapshot.tickets[0]!, id: `old-${index}` }))
  h.journal.reconcile(h.snapshot, h.now + 1, 1000, 3600000)
  h.snapshot.tickets = []; h.journal.reconcile(h.snapshot, h.now + 2, 1000, 3600000)
  const now = h.now + 172800000
  const removed = h.journal.maintain(now, { ...DEFAULT_RETENTION, closedDays: 1, auditDays: 1 })
  expect(removed.incidents).toBe(1000); expect(removed.audit).toBe(1000)
  expect(h.journal.counts().closed).toBe(101)
  expect(h.journal.maintain(now + 60000, { ...DEFAULT_RETENTION, closedDays: 1, auditDays: 1 }).incidents).toBe(101)
})

it('serves a standalone same-origin console and fenced operator APIs through real HTTP while the main service is unavailable', async () => {
  const h = await watchdogServer(); cleanup.push(h.stop)
  h.journal.unavailable(h.now, 'Main process stopped')
  const page = await fetch(h.url + '/watchdog'); expect(page.status).toBe(200)
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(await page.text()).toContain('/watchdog/ui.js')
  expect(await (await fetch(h.url + '/watchdog/ui.js')).text()).toContain('Agentic OS supervision')
  expect((await fetch(h.url + '/watchdog/api/status')).status).toBe(403)
  expect((await h.request('/watchdog/api/status', { headers: { origin: 'https://evil.invalid' } })).status).toBe(403)
  const invalidHost = await new Promise<number>(resolve => {
    httpRequest(h.url + '/watchdog/api/status', { headers: { host: 'evil.invalid', 'x-orchestrator-request': '1' } }, response => {
      response.resume(); resolve(response.statusCode!)
    }).end()
  })
  expect(invalidHost).toBe(403)
  expect((await h.request('/watchdog/api/status', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  expect((await h.request('/watchdog/api/incidents?state=open&state=closed')).status).toBe(400)
  const state = await (await h.request('/watchdog/api/status')).json()
  expect(state.monitor.reachable).toBe(false); expect(state.counts.open).toBe(1)
  const input = command(h.journal, h.now)
  const result = await h.request('/watchdog/api/acknowledgements', { method: 'POST', body: JSON.stringify(input) })
  expect(result.status).toBe(200)
  expect((await (await h.request('/watchdog/api/incidents?state=unacknowledged')).json()).items).toHaveLength(0)
  expect((await (await h.request('/watchdog/api/incidents/' + input.incidentId)).json()).closedAt).toBeUndefined()
  expect((await h.request('/watchdog/api/acknowledgements', { method: 'POST', body: JSON.stringify({ ...input, actor: 'model' }) })).status).toBe(400)
  expect((await h.request('/watchdog/api/acknowledgements', { method: 'POST', body: JSON.stringify({ ...input, note: 'x'.repeat(17000) }) })).status).toBe(413)
  expect((await h.request('/watchdog/api/retry', { method: 'POST', body: '{}' })).status).toBe(404)
})
