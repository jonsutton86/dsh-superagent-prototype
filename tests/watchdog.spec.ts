import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WatchdogJournal } from '../src/supervision/journal.ts'
import { WatchdogMonitor, type MonitorOptions } from '../src/supervision/monitor.ts'
import type { ObservationSet } from '../src/supervision/client.ts'

let directory: string, journal: WatchdogJournal, now: number, snapshot: ObservationSet
const options: MonitorOptions = { pollMs: 30_000, staleMs: 900_000, reviewEveryMs: 3_600_000, retryMs: 300_000, assessmentTimeoutMs: 90_000 }
const client = { observe: vi.fn<() => Promise<ObservationSet>>(), intervene: vi.fn() }
const assessor = { busy: vi.fn(() => false), send: vi.fn(async (_id: string, _text: string) => {}), cancel: vi.fn() }
let monitor: WatchdogMonitor
const create = () => new WatchdogMonitor(journal, client, assessor, options, () => now)
const stalled = () => {
  const incident = journal.open()[0]!
  journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'stalled', evidence: 'Repeated unchanged report, no progress' }, now)
  return incident
}
beforeEach(() => {
  vi.resetAllMocks(); assessor.busy.mockReturnValue(false); assessor.send.mockResolvedValue(); client.intervene.mockResolvedValue({ accepted: true, reason: 'status_requested' })
  now = Date.parse('2026-11-06T12:00:00Z'); directory = mkdtempSync(join(tmpdir(), 'watchdog-journal-'))
  journal = new WatchdogJournal(join(directory, 'watchdog.sqlite'))
  snapshot = { instance: 'process-1', version: 'v1', at: new Date(now).toISOString(), configured: true, paused: false, health: { worker: { state: 'ready' } },
    tickets: [{ id: 't1', revision: 'r1', assignmentId: 'a1', title: 'Fix regression', scope: 'Repair and test', stage: 'working',
      updatedAt: new Date(now - 1_000_000).toISOString(), report: { state: 'working', summary: 'Investigating', at: '2026-11-06T11:00:00Z' }, canNudge: true }] }
  client.observe.mockImplementation(async () => structuredClone(snapshot)); monitor = create()
})
afterEach(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

it('persists observations and assessment receipts across a watchdog restart', async () => {
  await monitor.poll()
  const incident = journal.open()[0]!
  expect(assessor.send).toHaveBeenCalledOnce()
  expect(assessor.send.mock.calls[0]![1]).toContain('untrusted task data')
  expect(incident.attempts).toBe(1)
  journal.close(); journal = new WatchdogJournal(join(directory, 'watchdog.sqlite')); monitor = create()
  await monitor.poll()
  expect(assessor.send).toHaveBeenCalledOnce()
  stalled()
  expect((await monitor.requestStatus(incident.id, incident.revision)).accepted).toBe(true)
  expect((await monitor.requestStatus(incident.id, incident.revision)).accepted).toBe(true)
  expect(client.intervene).toHaveBeenCalledOnce()
  expect(journal.recent().map(item => item.kind)).toEqual(expect.arrayContaining(['observed', 'assessed', 'intervention', 'delivery_reserved']))
})

it('requires a current stalled diagnosis and refuses recovery when paused, offline, blocked, or stale', async () => {
  await monitor.poll()
  const incident = journal.open()[0]!
  expect((await monitor.requestStatus(incident.id, incident.revision)).reason).toBe('intervention_not_allowed')
  stalled(); now += options.pollMs * 2 + 1
  expect((await monitor.requestStatus(incident.id, incident.revision)).reason).toBe('fresh_observation_required')
  client.observe.mockRejectedValueOnce(new Error('offline')); await monitor.poll()
  expect((await monitor.requestStatus(incident.id, incident.revision)).reason).toBe('fresh_observation_required')
  snapshot.paused = true; await monitor.poll()
  expect((await monitor.requestStatus(incident.id, incident.revision)).reason).toBe('incident_changed')
  snapshot.paused = false; snapshot.tickets[0]!.stage = 'person/blocked'; snapshot.tickets[0]!.canNudge = false
  await monitor.poll(); const blocked = stalled()
  expect((await monitor.requestStatus(blocked.id, blocked.revision)).reason).toBe('intervention_not_allowed')
  expect(client.intervene).not.toHaveBeenCalled()
})

it('reuses the same intervention id after a lost acknowledgement, allowing server-side deduplication', async () => {
  await monitor.poll(); const incident = stalled()
  client.intervene.mockRejectedValueOnce(new Error('ack lost'))
  await expect(monitor.requestStatus(incident.id, incident.revision)).rejects.toThrow('ack lost')
  journal.close(); journal = new WatchdogJournal(join(directory, 'watchdog.sqlite')); monitor = create()
  expect((await monitor.requestStatus(incident.id, incident.revision)).accepted).toBe(true)
  expect(client.intervene.mock.calls[0]![0]).toEqual(client.intervene.mock.calls[1]![0])
})

it('reuses an unsent reservation after a delivery crash and caps assessment retries', async () => {
  assessor.send.mockRejectedValueOnce(new Error('flush failed'))
  await monitor.poll()
  const deliveryId = assessor.send.mock.calls[0]![0]
  expect(journal.status()!.modelError).toContain('flush failed')
  journal.close(); journal = new WatchdogJournal(join(directory, 'watchdog.sqlite')); monitor = create()
  await monitor.poll(); expect(assessor.send.mock.calls[1]![0]).toBe(deliveryId)
  expect(journal.open()[0]!.attempts).toBe(1)
  for (let index = 0; index < 5; index++) { now += options.retryMs; await monitor.poll() }
  expect(journal.open()[0]!.attempts).toBe(3)
  expect(assessor.send).toHaveBeenCalledTimes(4) // One failed flush, then three distinct deliveries.
  expect(journal.status()!.reachable).toBe(true)
})

it('reassesses unchanged long-running work only on its bounded review interval', async () => {
  await monitor.poll(); const incident = journal.open()[0]!
  expect(journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'progressing', evidence: 'A long test is running' }, now).accepted).toBe(true)
  now += options.retryMs; await monitor.poll(); expect(assessor.send).toHaveBeenCalledOnce()
  now += options.reviewEveryMs; await monitor.poll()
  expect(journal.open()[0]!.revision).not.toBe(incident.revision)
  expect(assessor.send).toHaveBeenCalledTimes(2)
})

it('rejects diagnoses for a changed revision, restarted service, and ended work', async () => {
  await monitor.poll(); const first = journal.open()[0]!
  snapshot.instance = 'process-2'; await monitor.poll()
  expect(journal.assess({ incidentId: first.id, incidentRevision: first.revision, finding: 'stalled', evidence: 'old' }, now).accepted).toBe(false)
  const second = journal.open()[0]!
  snapshot.tickets[0]!.revision = 'r2'; await monitor.poll()
  expect((await monitor.requestStatus(second.id, second.revision)).reason).toBe('incident_changed')
  snapshot.tickets = []; await monitor.poll(); expect(journal.open()).toEqual([])
  expect(journal.get(first.id)!.closedAt).toBe(now)
})

it('uses a new assessment revision after pause and resume even if the clock has not advanced', async () => {
  await monitor.poll(); const first = journal.open()[0]!
  snapshot.paused = true; await monitor.poll(); snapshot.paused = false; await monitor.poll()
  expect(journal.open()[0]!.revision).not.toBe(first.revision)
  expect(journal.assess({ incidentId: first.id, incidentRevision: first.revision, finding: 'stalled', evidence: 'old' }, now).accepted).toBe(false)
})

it('keeps incident history on unavailable or inconsistent observations and recovers when the service returns', async () => {
  await monitor.poll(); const incident = journal.open()[0]!
  client.observe.mockRejectedValueOnce(new Error('snapshot changed while paging')); await monitor.poll()
  expect(journal.get(incident.id)!.closedAt).toBeUndefined()
  expect(journal.status()).toMatchObject({ reachable: false, error: expect.stringContaining('snapshot changed') })
  await monitor.poll(); expect(journal.status()!.reachable).toBe(true); expect(journal.status()!.error).toBeUndefined()
})

it('keeps polling while its own assessor is busy and enforces its deadline even during an outage', async () => {
  await monitor.poll(); assessor.busy.mockReturnValue(true)
  now += options.assessmentTimeoutMs; client.observe.mockRejectedValueOnce(new Error('offline'))
  await monitor.poll()
  expect(assessor.cancel).toHaveBeenCalledOnce()
  expect(journal.status()).toMatchObject({ reachable: false, modelError: expect.stringContaining('timed out') })
  expect(assessor.send).toHaveBeenCalledOnce()
})

it('coalesces concurrent polls and does not classify fresh or review-ready work as stalled', async () => {
  snapshot.tickets[0]!.updatedAt = new Date(now).toISOString()
  const first = monitor.poll(), second = monitor.poll(); expect(first).toBe(second)
  await first; expect(journal.open()).toEqual([])
  now += options.staleMs; snapshot.tickets[0]!.stage = 'person/review'; await monitor.poll()
  expect(journal.open()).toEqual([]); expect(assessor.send).not.toHaveBeenCalled()
})
