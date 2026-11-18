import { afterEach, expect, it, vi } from 'vitest'
import { Access, readAccessConfig } from '../src/security/access.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
const KEYS = ['DSH_ORCHESTRATOR_ADMIN_TOKEN', 'DSH_ORCHESTRATOR_ROLE', 'DSH_ORCHESTRATOR_CONNECTORS'] as const
const TOKEN = 'admin-test-token-0123456789abcdef'

afterEach(async () => {
  await host?.stop(); host = undefined
  for (const key of KEYS) delete process.env[key]
  vi.restoreAllMocks()
})

const authorize = (value = TOKEN) => ({ authorization: `Bearer ${value}` })
const start = () => startRuntime(undefined, { executionMode: 'local', noAccounts: true })

it('keeps the single-owner loopback default when no administration token is configured', async () => {
  const h = host = await start()
  const state = await h.api('GET', 'state')
  expect(state.status).toBe(200)
  expect(state.body).toMatchObject({ access: { required: false, role: 'owner', connectors: {} } })
  expect(JSON.stringify(state.body)).not.toContain('token')
  // The loopback/same-origin guard still rejects an unmarked request before routing.
  const rejected = await h.api('GET', 'state', undefined, { 'x-orchestrator-request': '' })
  expect(rejected.status).toBe(403)
})

it('requires and accepts a bearer token when configured, without exposing it in state', async () => {
  process.env.DSH_ORCHESTRATOR_ADMIN_TOKEN = TOKEN
  const h = host = await start()
  const denied = await h.api('GET', 'state')
  expect(denied.status).toBe(401)
  expect(denied.body).toMatchObject({ error: 'Administration authentication required' })
  expect((await h.api('GET', 'state', undefined, authorize('wrong-token-wrong-token-wrong-token'))).status).toBe(401)
  const allowed = await h.api('GET', 'state', undefined, authorize())
  expect(allowed.status).toBe(200)
  expect(allowed.body).toMatchObject({ access: { required: true, role: 'owner' } })
  const serialized = JSON.stringify(allowed.body)
  expect(serialized).not.toContain(TOKEN)
  expect(serialized).not.toContain('admin-test-token')
  // Authentication failures are audited without the presented value.
  const audit = h.runtime.audit.list(10)
  expect(audit.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'access.authenticate', outcome: 'denied' })]))
  expect(JSON.stringify(audit.items)).not.toContain(TOKEN)
})

it('enforces role capabilities and audits a denied sensitive action', async () => {
  process.env.DSH_ORCHESTRATOR_ADMIN_TOKEN = TOKEN
  process.env.DSH_ORCHESTRATOR_ROLE = 'viewer'
  const h = host = await start()
  expect((await h.api('GET', 'state', undefined, authorize())).status).toBe(200)
  const denied = await h.api('POST', 'emergency', { requestId: 'viewer-stop', action: 'engage', reason: 'Should be denied', actor: 'viewer' }, authorize())
  expect(denied.status).toBe(403)
  expect(h.runtime.emergency.engaged()).toBe(false)
  expect(h.runtime.audit.list(10).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: 'access.capability', resource: 'runtime:operate', outcome: 'denied', actor: 'admin:viewer' })]))
})

it('denies connectors by default and grants only the explicit read/execute permission', () => {
  const closed = new Access({ token: TOKEN, role: 'owner', connectors: {} })
  expect(closed.connectorAllows('github', 'read')).toBe(false)
  expect(closed.connectorAllows('github', 'execute')).toBe(false)
  const readOnly = new Access({ token: TOKEN, role: 'owner', connectors: { github: { read: true, execute: false } } })
  expect(readOnly.connectorAllows('github', 'read')).toBe(true)
  expect(readOnly.connectorAllows('github', 'execute')).toBe(false)
  expect(readOnly.connectorAllows('calendar', 'read')).toBe(false)
  expect(readOnly.view().connectors).toEqual({ github: { read: true, execute: false } })
})

it('rejects malformed access configuration without echoing the secret', () => {
  expect(() => readAccessConfig({ DSH_ORCHESTRATOR_ADMIN_TOKEN: 'too-short' } as NodeJS.ProcessEnv))
    .toThrow(/Invalid administration access configuration/)
  let failure: unknown
  try { readAccessConfig({ DSH_ORCHESTRATOR_ADMIN_TOKEN: TOKEN, DSH_ORCHESTRATOR_CONNECTORS: '{not json' } as NodeJS.ProcessEnv) }
  catch (error) { failure = error }
  expect(String(failure)).toContain('DSH_ORCHESTRATOR_CONNECTORS')
  expect(String(failure)).not.toContain(TOKEN)
  expect(() => readAccessConfig({ DSH_ORCHESTRATOR_ADMIN_TOKEN: TOKEN, DSH_ORCHESTRATOR_ROLE: 'root' } as NodeJS.ProcessEnv))
    .toThrow(/Invalid administration access configuration/)
})
