/** Real loopback receiver tests: durable identities, strict receipt observation, and no replay after uncertain dispatch. */
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WatchdogJournal } from '../src/supervision/journal.ts'
import { WatchdogAlerts } from '../src/supervision/alerts.ts'
import { ALERT_LIMIT, AlertRoutesSchema, alertDestinationHash, type AlertCandidate, type AlertRoute } from '../src/supervision/alert-protocol.ts'
import { watchdogHttp } from '../src/supervision/http.ts'
import { DEFAULT_RETENTION } from '../src/supervision/protocol.ts'

let directory: string, journal: WatchdogJournal, now: number
const servers: Server[] = []
const credential = 'local-receiver-test-token-only'
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'watchdog-alerts-')); now = Date.parse('2026-11-10T14:00:00Z')
  writeFileSync(join(directory, 'alert.token'), credential, { mode: 0o600 })
  journal = new WatchdogJournal(join(directory, 'watchdog.sqlite'))
})
afterEach(async () => {
  journal.close()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) })))
  rmSync(directory, { recursive: true, force: true })
})
type Envelope = { version: 1; id: string; payloadHash: string; payload: { evidence: string } }
async function listen(server: Server): Promise<string> {
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function receiver() {
  const stored = new Map<string, Envelope>(), calls: { method: string; id?: string }[] = []
  const control = { mode: 'accepted' as 'accepted' | 'rejected' | 'pending' | 'lost' | 'malformed' | 'oversized' | 'redirect' | 'http_error', auth: true }
  const url = await listen(createServer(async (req, res) => {
    control.auth &&= req.headers.authorization === `Bearer ${credential}`
    if (req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Envelope
      calls.push({ method: 'POST', id: body.id }); stored.set(body.id, body)
      expect(req.headers['idempotency-key']).toBe(body.id)
      if (control.mode === 'lost') { req.socket.destroy(); return }
      if (control.mode === 'redirect') { res.writeHead(307, { location: '/redirected' }); res.end(); return }
      if (control.mode === 'oversized') { res.end('x'.repeat(8193)); return }
      res.writeHead(control.mode === 'http_error' ? 500 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ version: 1, id: body.id, payloadHash: control.mode === 'malformed' ? '0'.repeat(64) : body.payloadHash,
        status: ['rejected', 'pending'].includes(control.mode) ? control.mode : 'accepted' }))
    } else {
      const id = new URL(req.url!, 'http://127.0.0.1').searchParams.get('alertId')!
      calls.push({ method: 'GET', id }); const body = stored.get(id)
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body ? { version: 1, id, payloadHash: body.payloadHash, status: 'accepted' } : { error: 'missing' }))
    }
  }))
  const route: AlertRoute = { id: 'operations', name: 'Operations receiver', url: url + '/alerts', tokenFile: join(directory, 'alert.token'), cooldownMs: 1000 }
  const alerts = () => new WatchdogAlerts(journal, [route], undefined, () => now)
  return { route, alerts, stored, calls, control }
}
function observe(stage = 'person/blocked', revision = 'r1') {
  journal.reconcile({ instance: 'main', version: 'v1', at: new Date(now).toISOString(), configured: true, paused: false,
    health: {}, tickets: [{ id: 'task', assignmentId: 'assignment', revision, title: 'Review task', scope: 'Do the requested work',
      stage, updatedAt: new Date(now - 60000).toISOString(), report: null, canNudge: false }] }, now, 1000, 3600000)
}
const candidate = (id: string, evidenceKey = 'r1'): AlertCandidate => ({ subjectId: id, evidenceKey, title: id,
  finding: 'blocked', evidence: 'bounded evidence', observedAt: now })

it('is opt-in, sends authenticated exact evidence, and deduplicates accepted work across restart', async () => {
  const remote = await receiver(); observe()
  await new WatchdogAlerts(journal).poll(); expect(remote.calls).toHaveLength(0)
  const alerts = remote.alerts(); await alerts.poll()
  const receipt = alerts.list().items[0]!
  expect(receipt).toMatchObject({ phase: 'accepted', reason: 'receiver_accepted', routeId: 'operations' })
  expect(remote.control.auth).toBe(true); expect(remote.stored.get(receipt.id)).toMatchObject({ id: receipt.id, payloadHash: receipt.payloadHash,
    payload: { incidentId: journal.open()[0]!.id, trust: 'untrusted-observation', finding: 'blocked' } })
  expect(JSON.stringify(alerts.list())).not.toContain(credential); expect(JSON.stringify(alerts.list())).not.toContain(remote.route.url)
  await alerts.poll(); await alerts.retry(receipt.id); expect(remote.calls).toHaveLength(1)
  journal.close(); journal = new WatchdogJournal(join(directory, 'watchdog.sqlite'))
  await remote.alerts().poll(); expect(remote.calls).toHaveLength(1)
  expect(remote.alerts().get(receipt.id).id).toBe(receipt.id)
})

it('migrates a schema-two journal without losing incidents, acknowledgement receipts, or audit sequence', async () => {
  observe(); const incident = journal.open()[0]!, command = { requestId: `wd-${now}-00000000-0000-4000-8000-000000000000`,
    incidentId: incident.id, revision: journal.view(incident).viewRevision, note: 'Existing review' }
  const original = journal.acknowledge(command, now), sequence = journal.recent()[0]!.seq
  journal.close()
  const old = new DatabaseSync(join(directory, 'watchdog.sqlite'))
  old.exec('DROP TABLE alert_receipts; DROP TABLE alert_sources; DROP TABLE alert_state; PRAGMA user_version=2;'); old.close()
  journal = new WatchdogJournal(join(directory, 'watchdog.sqlite'))
  expect(journal.acknowledge(command, now)).toEqual(original)
  expect(journal.view(journal.get(incident.id)!).acknowledged).toBe(true)
  expect(journal.recent()[0]!.seq).toBe(sequence); expect(journal.alerts.size()).toBe(0)
  const remote = await receiver(); journal.alerts.sync([candidate('migration')], [remote.route], now)
  expect(journal.recent()[0]!.seq).toBeGreaterThan(sequence)
})

it('retains the dispatched identity after response loss and recovers only by receiver observation', async () => {
  const remote = await receiver(); remote.control.mode = 'lost'; observe()
  const alerts = remote.alerts(); await alerts.poll(); const original = alerts.list().items[0]!
  expect(original.phase).toBe('unknown'); expect(remote.calls).toHaveLength(1)
  now += 10000; observe('person/blocked', 'changed'); await alerts.poll(); await alerts.retry(original.id)
  expect(remote.calls).toHaveLength(1); expect(alerts.list().items).toHaveLength(1)
  expect(() => alerts.cancel(original.id)).toThrow('dispatched_alert_cannot_be_cancelled')
})

it('concurrent and repeated observation settles one original unknown record without another POST', async () => {
  const remote = await receiver(); remote.control.mode = 'lost'; observe(); const alerts = remote.alerts()
  await alerts.poll(); const original = alerts.list().items[0]!
  expect(() => alerts.cancel(original.id)).toThrow('dispatched_alert_cannot_be_cancelled')
  journal.close(); journal = new WatchdogJournal(join(directory, 'watchdog.sqlite'))
  const restored = remote.alerts()
  const results = await Promise.all([restored.observe(original.id), restored.observe(original.id)])
  expect(results.map(value => value.phase)).toEqual(['accepted', 'accepted'])
  await restored.observe(original.id); await restored.retry(original.id)
  expect(remote.calls).toEqual([{ method: 'POST', id: original.id }, { method: 'GET', id: original.id }])
})

it('marks a crash after durable dispatch as unknown even when the receiver never saw the request', async () => {
  const remote = await receiver(); observe()
  journal.alerts.sync([candidate('crash-boundary')], [remote.route], now)
  const prepared = journal.alerts.pending()[0]!
  journal.alerts.dispatch(prepared.id, alertDestinationHash(remote.route), now)
  journal.close(); journal = new WatchdogJournal(join(directory, 'watchdog.sqlite'))
  const restored = remote.alerts()
  expect(restored.get(prepared.id)).toMatchObject({ phase: 'unknown', reason: 'watchdog_restarted_after_dispatch' })
  await restored.retry(prepared.id); await restored.observe(prepared.id)
  expect(restored.get(prepared.id).phase).toBe('unknown'); expect(remote.calls).toEqual([{ method: 'GET', id: prepared.id }])
})

it('holds credential failures before dispatch and retries exactly once with the retained identity', async () => {
  const remote = await receiver(); observe(); chmodSync(remote.route.tokenFile, 0o644)
  const alerts = remote.alerts(); await alerts.poll(); const prepared = alerts.list().items[0]!
  expect(prepared).toMatchObject({ phase: 'prepared', reason: 'credential_unavailable_before_dispatch' }); expect(remote.calls).toHaveLength(0)
  await alerts.poll(); expect(remote.calls).toHaveLength(0)
  chmodSync(remote.route.tokenFile, 0o600)
  await Promise.all([alerts.retry(prepared.id), alerts.retry(prepared.id)])
  expect(remote.calls).toEqual([{ method: 'POST', id: prepared.id }]); expect(alerts.get(prepared.id).phase).toBe('accepted')
})

it('cancels only undispatched work and rechecks acknowledgements before a credential retry', async () => {
  const remote = await receiver(); observe(); chmodSync(remote.route.tokenFile, 0o644)
  const alerts = remote.alerts(); await alerts.poll(); const prepared = alerts.list().items[0]!
  const incident = journal.open()[0]!
  journal.acknowledge({ requestId: `wd-${now}-00000000-0000-4000-8000-000000000000`, incidentId: incident.id,
    revision: journal.view(incident).viewRevision, note: '' }, now)
  chmodSync(remote.route.tokenFile, 0o600); await alerts.retry(prepared.id)
  expect(alerts.get(prepared.id)).toMatchObject({ phase: 'cancelled', reason: 'evidence_changed_or_acknowledged' })
  expect(alerts.cancel(prepared.id).phase).toBe('cancelled'); expect(remote.calls).toHaveLength(0)
})

it('refuses retargeting an unknown delivery, then observes its original destination after restoration', async () => {
  const remote = await receiver(); remote.control.mode = 'lost'; observe(); const alerts = remote.alerts(); await alerts.poll()
  const original = alerts.list().items[0]!
  const changed = new WatchdogAlerts(journal, [{ ...remote.route, url: remote.route.url + '/new' }], undefined, () => now)
  await expect(changed.observe(original.id)).rejects.toThrow('alert_destination_changed')
  await changed.poll(); expect(remote.calls).toHaveLength(1)
  expect((await alerts.observe(original.id)).phase).toBe('accepted'); expect(remote.calls.at(-1)!.method).toBe('GET')
})

it.each(['pending', 'malformed', 'oversized', 'redirect', 'http_error'] as const)('keeps %s responses unknown without redirects or replay', async mode => {
  const remote = await receiver(); remote.control.mode = mode; observe(); const alerts = remote.alerts(); await alerts.poll()
  const original = alerts.list().items[0]!
  expect(original.phase).toBe('unknown'); await alerts.retry(original.id); await alerts.poll()
  expect(remote.calls).toEqual([{ method: 'POST', id: original.id }])
})

it('records explicit matching receiver rejection as terminal, without replay', async () => {
  const remote = await receiver(); remote.control.mode = 'rejected'; observe(); const alerts = remote.alerts(); await alerts.poll()
  const original = alerts.list().items[0]!; expect(original.phase).toBe('rejected'); await alerts.retry(original.id)
  expect(remote.calls).toHaveLength(1)
})

it('routes service outages independently and never exports raw exception or credential text', async () => {
  const remote = await receiver(); journal.unavailable(now, 'secret stack ' + credential); journal.modelError('model failed ' + credential)
  const alerts = remote.alerts(); await alerts.poll()
  expect(alerts.list().items.map(value => value.subjectId).sort()).toEqual(['service:assessor', 'service:main'])
  expect(JSON.stringify([...remote.stored.values()])).not.toContain(credential)
  now += 2000; journal.unavailable(now, 'secret stack ' + credential); await alerts.poll(); expect(remote.calls).toHaveLength(2)
  observe('working'); journal.modelError(); await alerts.poll()
  now += 2000; journal.unavailable(now, 'secret stack ' + credential); await alerts.poll()
  expect(remote.calls.filter(value => value.method === 'POST')).toHaveLength(3)
})

it('does not alert on quiet productive work, and distinguishes an assessment limit from proven failure', async () => {
  const remote = await receiver(); observe('working'); const alerts = remote.alerts(), incident = journal.open()[0]!
  await alerts.poll(); expect(remote.calls).toHaveLength(0)
  journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'progressing', evidence: 'Build is progressing.' }, now)
  await alerts.poll(); expect(remote.calls).toHaveLength(0)
  now += 2000; observe('working', 'r2'); const changed = journal.open()[0]!
  for (let count = 0; count < 3; count++) {
    const delivery = journal.reserve(changed.id, now, 1000)!
    journal.delivered(delivery.id, delivery.delivery!.id); now += 1000
  }
  await alerts.poll()
  expect(alerts.list().items[0]).toMatchObject({ finding: 'assessment_delivery_limit_reached', phase: 'accepted' })
  expect([...remote.stored.values()][0]!.payload.evidence).toContain('may still be running')
})

it('applies cooldown to new evidence and uses a new identity only after earlier delivery is settled', async () => {
  const remote = await receiver(); observe(); const alerts = remote.alerts(); await alerts.poll()
  const first = alerts.list().items[0]!; now += 500; observe('person/blocked', 'r2'); await alerts.poll()
  expect(remote.calls).toHaveLength(1)
  now += 501; await alerts.poll(); expect(remote.calls).toHaveLength(2)
  const second = alerts.list().items[0]!
  expect(second.id).not.toBe(first.id); expect(second.evidenceRevision).not.toBe(first.evidenceRevision)
  expect(second.phase).toBe('accepted')
})

it('aborts a dispatched request into unknown and drains in-flight work before journal shutdown', async () => {
  let received!: () => void
  const arrived = new Promise<void>(resolve => { received = resolve })
  const url = await listen(createServer(async (req, _res) => { for await (const _chunk of req) { /* Read the whole committed request. */ } received() }))
  const controller = new AbortController(), route = { id: 'ops', name: 'Operations', url,
    tokenFile: join(directory, 'alert.token'), cooldownMs: 1000 }
  observe(); const alerts = new WatchdogAlerts(journal, [route], controller.signal, () => now)
  const polling = alerts.poll(); await arrived; controller.abort(); await polling; await alerts.idle()
  expect(alerts.list().items[0]).toMatchObject({ phase: 'unknown', reason: 'dispatch_response_unconfirmed' })
  expect(journal.recent().some(event => event.kind === 'alert_unknown')).toBe(true)
})

it('keeps unresolved receipts beyond retention, preserves deduplication after pruning, and bounds capacity', async () => {
  const remote = await receiver(), one = candidate('subject')
  journal.alerts.sync([one], [remote.route], now); const first = journal.alerts.pending()[0]!
  journal.alerts.dispatch(first.id, first.destinationHash, now); journal.alerts.outcome(first.id, 'accepted', 'receiver_accepted', now)
  now += 31 * 86400000; journal.alerts.sync([one], [remote.route], now)
  expect(journal.alerts.size()).toBe(0); journal.alerts.sync([one], [remote.route], now); expect(journal.alerts.size()).toBe(0)
  const many = Array.from({ length: ALERT_LIMIT + 1 }, (_, index) => candidate(`capacity-${index}`))
  journal.alerts.sync(many, [remote.route], now)
  // The earlier still-retained dedup floor shares the hard metadata bound, even after its receipt expired.
  expect(journal.alerts.size()).toBe(ALERT_LIMIT - 1)
  const unknown = journal.alerts.pending()[0]!; journal.alerts.dispatch(unknown.id, unknown.destinationHash, now)
  journal.alerts.outcome(unknown.id, 'unknown', 'lost', now)
  now += 31 * 86400000; journal.alerts.sync(many, [remote.route], now)
  expect(journal.alerts.get(unknown.id)?.phase).toBe('unknown'); expect(journal.alerts.size()).toBeLessThanOrEqual(ALERT_LIMIT)
  expect(journal.alerts.list([remote.route]).capacity).toMatchObject({ sourcesUsed: expect.any(Number), reservationsUsed: expect.any(Number) })
  const page = journal.alerts.list([remote.route]); expect(page.items).toHaveLength(50); expect(page.cursor).toBeTruthy()
  const older = journal.alerts.list([remote.route], page.cursor!); expect(older.items).toHaveLength(50)
  expect(new Set([...page.items, ...older.items].map(value => value.id)).size).toBe(100)
  journal.alerts.cancel(journal.alerts.pending()[0]!.id, now)
  expect(() => journal.alerts.list([remote.route], page.cursor!)).toThrow('alerts_changed_refresh')
})

it('creates no metadata while disabled and preserves bounded dedup floors across route disable/re-enable', async () => {
  const remote = await receiver(), many = Array.from({ length: 1500 }, (_, index) => candidate(`candidate-${index}`))
  journal.alerts.sync(many, [], now)
  expect(journal.alerts.list([]).capacity).toMatchObject({ used: 0, sourcesUsed: 0, reservationsUsed: 0 })
  journal.alerts.sync(many, [remote.route], now)
  expect(journal.alerts.list([remote.route]).capacity).toMatchObject({ used: ALERT_LIMIT, sourcesUsed: ALERT_LIMIT, reservationsUsed: ALERT_LIMIT })
  const original = journal.alerts.pending()[0]!
  journal.alerts.dispatch(original.id, original.destinationHash, now); journal.alerts.outcome(original.id, 'accepted', 'receiver_accepted', now)
  journal.alerts.sync(many, [], now); now += 2000; journal.alerts.sync(many, [remote.route], now)
  expect(journal.alerts.get(original.id)?.phase).toBe('accepted')
  expect(journal.alerts.list([remote.route]).capacity.sourcesUsed).toBe(ALERT_LIMIT)
  expect(journal.alerts.list([remote.route]).capacity.reservationsUsed).toBe(ALERT_LIMIT)
  // An ordinary host-configured route ID must not resolve inherited Object properties as reservation records.
  const inheritedName = { ...remote.route, id: 'constructor' }
  journal.alerts.sync(many, [inheritedName], now)
  expect(journal.alerts.list([inheritedName]).capacity.reservationsUsed).toBe(ALERT_LIMIT)
})

it('rejects insecure routes, duplicate identities, credentials in URLs, and nonlocal plaintext endpoints', () => {
  const good = { id: 'ops', name: 'Operations', url: 'https://receiver.example/alerts', tokenFile: '/private/token' }
  expect(AlertRoutesSchema.parse([good])[0]!.cooldownMs).toBe(300000)
  for (const url of ['http://example.com/', 'http://localhost/', 'https://user:pass@example.com/', 'https://example.com/?token=secret', 'https://example.com/#secret'])
    expect(() => AlertRoutesSchema.parse([{ ...good, url }])).toThrow()
  expect(() => AlertRoutesSchema.parse([good, good])).toThrow()
})

it('exposes bounded local management without granting cross-origin or model text delivery authority', async () => {
  const remote = await receiver(); observe(); chmodSync(remote.route.tokenFile, 0o644)
  const alerts = remote.alerts(); await alerts.poll(); const prepared = alerts.list().items[0]!
  let active = true
  const server = createServer(); const origin = await listen(server)
  server.on('request', watchdogHttp(journal, { port: Number(new URL(origin).port), sessionId: 'watchdog', mainUrl: 'http://127.0.0.1:1',
    pollMs: 1000, retention: DEFAULT_RETENTION, asset: () => '', active: () => active, alerts, now: () => now }))
  const headers = { 'x-orchestrator-request': '1', 'content-type': 'application/json' }
  expect((await fetch(origin + '/watchdog/api/alerts')).status).toBe(403)
  expect((await fetch(origin + '/watchdog/api/alerts', { headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403)
  const page = await (await fetch(origin + '/watchdog/api/alerts', { headers })).json()
  expect(page.items[0].id).toBe(prepared.id)
  const path = origin + '/watchdog/api/alerts/' + prepared.id + '/cancel'
  expect((await fetch(path, { method: 'POST', headers, body: JSON.stringify({ url: 'https://evil.example' }) })).status).toBe(400)
  expect((await fetch(path, { method: 'POST', headers, body: '{}' })).status).toBe(200)
  expect((await fetch(path, { method: 'POST', headers, body: '{}' })).status).toBe(200)
  active = false; expect((await fetch(origin + '/watchdog/api/alerts', { headers })).status).toBe(503)
  expect(remote.calls).toHaveLength(0)
})
