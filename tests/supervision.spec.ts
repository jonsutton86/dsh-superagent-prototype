import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { Supervision } from '../src/supervision/service.ts'
import { SupervisionClient } from '../src/supervision/client.ts'
import type { Intervention } from '../src/supervision/protocol.ts'
import type { Ticket } from '../src/core/index.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

let directory: string, store: Store, supervisor: Supervision
let configured = true
const note = vi.fn<(id: string, text: string) => Ticket>()
const ticket = (id = 't1'): Ticket => ({ id, title: 'Implement a bounded watchdog', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: 'Test supervision' },
  origin: { triggerId: 'origin', triggerIds: ['origin'] }, channels: [], inputs: [], undelivered: [],
  assignments: [{ id: `${id}-a1`, state: 'running', createdAt: '2026-01-01T00:00:00Z' }],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
const command = (requestId = 'request'): Intervention => ({ requestId, action: 'request_status', instance: supervisor.instance,
  ticketId: 't1', revision: supervisor.snapshot().tickets[0]!.revision })
const make = () => new Supervision({ store, engine: { note }, stateDir: directory, configured: () => configured,
  health: () => ({ runtime: { state: 'ready', detail: 'Ready' } }) })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-supervision-')); store = new Store(join(directory, 'orchestrator.sqlite'))
  store.tickets.save(ticket()); configured = true; note.mockReset().mockImplementation(() => store.tickets.get('t1')!)
  supervisor = make()
})
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  store.close(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true })
})

it('authenticates with a stable private token without including it in observations', () => {
  const token = readFileSync(join(directory, 'watchdog.token'), 'utf8')
  expect(statSync(join(directory, 'watchdog.token')).mode & 0o777).toBe(0o600)
  expect(supervisor.authorized(`Bearer ${token}`)).toBe(true)
  for (const header of [undefined, token, 'Bearer wrong', `Bearer ${token}x`]) expect(supervisor.authorized(header)).toBe(false)
  expect(make().authorized(`Bearer ${token}`)).toBe(true)
  expect(JSON.stringify(supervisor.snapshot())).not.toContain(token)
})

it('records one transactional nudge per assignment, deduplicates receipts after restart, and rejects key reuse', () => {
  const request = command()
  expect(supervisor.intervene(request)).toEqual({ accepted: true, reason: 'status_requested' })
  expect(supervisor.intervene(request)).toEqual({ accepted: true, reason: 'status_requested' })
  expect(supervisor.intervene({ ...request, ticketId: 't2' }).reason).toBe('request_id_conflict')
  expect(supervisor.intervene(command('another')).reason).toBe('intervention_not_allowed')
  store.close(); store = new Store(join(directory, 'orchestrator.sqlite')); supervisor = make()
  expect(supervisor.intervene(request)).toEqual({ accepted: true, reason: 'status_requested' })
  expect(supervisor.snapshot().tickets[0]!.canNudge).toBe(false)
  expect(note).toHaveBeenCalledOnce()
})

it('fences restarted processes, changed tickets, pauses, and withdrawn work', () => {
  const stale = command()
  store.tickets.save({ ...ticket(), title: 'Changed scope' })
  expect(supervisor.intervene(stale).reason).toBe('observation_changed')
  expect(supervisor.intervene({ ...command(), instance: 'previous-process' }).reason).toBe('instance_changed')
  configured = false; expect(supervisor.intervene(command()).reason).toBe('processing_paused'); configured = true
  store.saveSettings({ ...store.settings(), paused: true })
  expect(supervisor.intervene(command()).reason).toBe('processing_paused')
  store.saveSettings({ ...store.settings(), paused: false })
  const current = command()
  store.tickets.save({ ...ticket(), ended: { at: 'now', by: 'executor', reason: 'stop', outcome: 'closed' } })
  expect(supervisor.intervene(current).reason).toBe('ticket_ended')
  expect(note).not.toHaveBeenCalled()
})

it('rolls back the receipt and nudge when note delivery cannot be enqueued', () => {
  note.mockImplementationOnce(() => { store.tickets.save({ ...ticket(), title: 'Partial write' }); throw new Error('disk unavailable') })
  const request = command()
  expect(() => supervisor.intervene(request)).toThrow('disk unavailable')
  expect(store.tickets.get('t1')!.title).toBe(ticket().title)
  expect(supervisor.snapshot().tickets[0]!.canNudge).toBe(true)
  expect(supervisor.intervene(request).accepted).toBe(true)
})

it('never nudges work awaiting a person, a completed assignment, or queued work', () => {
  for (const state of ['ready', 'blocked', 'failed', 'waiting'] as const) {
    const value = ticket(); value.assignments[0]!.report = { state, summary: 'Waiting', at: '2026-01-02T00:00:00Z' }
    store.tickets.save(value)
    expect(supervisor.snapshot().tickets[0]!.canNudge, state).toBe(false)
  }
  for (const state of ['pending', 'ended'] as const) {
    const value = ticket(); value.assignments[0]!.state = state; store.tickets.save(value)
    expect(supervisor.intervene(command(state)).accepted).toBe(false)
  }
  expect(note).not.toHaveBeenCalled()
})

async function serve() {
  const server = createServer(); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port, url = `http://127.0.0.1:${port}`
  registerHttp({ webServer: { host: '127.0.0.1', port, register: ({ handler }: { handler: RequestListener }) => {
    server.on('request', handler); return () => server.off('request', handler)
  } } } as never, { store, supervision: supervisor, ready: new Promise(() => {}) } as unknown as HttpHost)
  return { url, client: new SupervisionClient(url, join(directory, 'watchdog.token'), new AbortController().signal),
    headers: { 'x-orchestrator-request': '1', authorization: `Bearer ${readFileSync(join(directory, 'watchdog.token'), 'utf8')}` } }
}

it('serves the independent client before normal startup and validates authenticated commands over real HTTP', async () => {
  const { url, client, headers } = await serve()
  expect((await client.observe()).tickets[0]!.id).toBe('t1')
  const path = url + '/orchestrator/api/supervision'
  expect((await fetch(path, { headers: { 'x-orchestrator-request': '1' } })).status).toBe(403)
  expect((await fetch(path, { headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403)
  expect((await fetch(path + '/intervene', { method: 'POST', headers, body: JSON.stringify({ ...command(), action: 'retry' }) })).status).toBe(400)
  expect((await fetch(path + '/intervene', { method: 'POST', headers, body: 'x'.repeat(5000) })).status).toBe(400)
  expect((await client.intervene(command())).accepted).toBe(true)
  expect(note).toHaveBeenCalledOnce()
})

it('collects consistent bounded pages and refuses a changed snapshot', async () => {
  for (let index = 2; index <= 101; index++) store.tickets.save(ticket(`t${index}`))
  const { client } = await serve()
  expect((await client.observe()).tickets).toHaveLength(101)
  const original = supervisor.snapshot.bind(supervisor)
  vi.spyOn(supervisor, 'snapshot').mockImplementation(offset => ({ ...original(offset), ...(offset ? { version: 'changed' } : {}) }))
  await expect(client.observe()).rejects.toThrow('changed during pagination')
})

it('refuses credential forwarding, non-loopback targets, and oversized responses', async () => {
  for (const url of ['https://evil.example', 'http://127.0.0.1:3082/path', 'http://user:pass@127.0.0.1:3082', 'http://127.0.0.1:3082/?x=y'])
    expect(() => new SupervisionClient(url, '', new AbortController().signal)).toThrow('origin')
  const { client } = await serve()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(1_048_577))))
  try { await expect(client.observe()).rejects.toThrow('exceeds 1 MiB') } finally { vi.unstubAllGlobals() }
  writeFileSync(join(directory, 'watchdog.token'), 'invalid')
  await expect(client.observe()).rejects.toThrow('token')
})

it('delivers a real engine note through existing worker effects without changing the mandate', async () => {
  const host = await startRuntime()
  try {
    const { ticket: active, sessionId } = await host.acceptedTicket(feishu('1', 'Fix the regression'))
    const observation = host.runtime.supervision.snapshot().tickets.find(item => item.id === active.id)!
    expect(host.runtime.supervision.intervene({ requestId: 'watchdog-runtime', action: 'request_status', instance: host.runtime.supervision.instance,
      ticketId: active.id, revision: observation.revision }).accepted).toBe(true)
    await host.runtime.idle()
    const after = host.runtime.store.tickets.get(active.id)!
    expect(after.mandate).toEqual(active.mandate)
    expect(after.assignments).toHaveLength(active.assignments.length)
    expect(after.inputs.at(-1)).toMatchObject({ kind: 'note', text: expect.stringContaining('independent watchdog') })
    expect(host.deliveries.mock.calls.some(([item]) => item.sessionId === sessionId && item.text.includes('independent watchdog'))).toBe(true)
  } finally { await host.stop() }
})
