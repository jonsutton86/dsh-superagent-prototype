import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AuditLog } from '../src/security/audit.ts'
import { Emergency } from '../src/app/emergency.ts'
import { Store } from '../src/app/store.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.restoreAllMocks() })

const engage = (h: Host, id = 'engage-1', reason = 'Operator emergency') => h.api('POST', 'emergency',
  { requestId: id, action: 'engage', reason, actor: 'operator' })
const release = (h: Host, id = 'release-1', reason = 'Resolved') => h.api('POST', 'emergency',
  { requestId: id, action: 'release', reason, actor: 'operator' })

it('engages a durable emergency stop that halts original work and blocks new dispatch until released', async () => {
  const h = host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const item = h.runtime.inbox.start({ requestId: 'emergency-task', title: 'Emergency work', text: 'Do the work' })
  await h.runtime.idle()
  const worker = h.agents.get(item.sessionId!)!
  expect(worker).toBeDefined()

  const engaged = await engage(h)
  expect(engaged.status).toBe(200)
  expect(engaged.body).toMatchObject({ engaged: true, revision: 1, actor: 'operator' })
  await h.runtime.executor.stops.idle()
  expect(worker.cancel).toHaveBeenCalled()

  // Distinct from the ordinary processing pause and durable before any replacement can start.
  expect(h.runtime.store.settings().paused).toBe(false)
  const restored = new Emergency({ store: h.runtime.store, audit: h.runtime.audit,
    hooks: { haltAll: async () => ({ total: 0, failed: 0 }), resume: () => {} } })
  expect(restored.engaged()).toBe(true)

  // Admission refuses new work while engaged; this is the same boundary the ordinary pause uses.
  expect(() => h.runtime.inbox.start({ requestId: 'emergency-task-2', title: 'Held work', text: 'Must wait' }))
    .toThrow('Configure execution and resume the executor before running an action.')

  // A replayed engage is idempotent: no second halt and no second audit fact for one operator decision.
  const before = h.runtime.audit.list(100).items.length
  expect((await engage(h)).body).toMatchObject({ engaged: true, revision: 1 })
  expect(h.runtime.audit.list(100).items.length).toBe(before)
  expect(h.runtime.audit.verify()).toBe(true)
  expect(h.runtime.audit.list(10).items[0]).toMatchObject({ action: 'emergency.engage', actor: 'operator', resource: 'runtime', outcome: 'completed' })

  const released = await release(h)
  expect(released.status).toBe(200)
  expect(released.body).toMatchObject({ engaged: false, revision: 2 })
  const next = h.runtime.inbox.start({ requestId: 'emergency-task-3', title: 'Resumed work', text: 'Run after release' })
  await vi.waitFor(() => expect(h.agents.get(next.sessionId!)).toBeDefined(), { timeout: 5000 })
  expect(h.runtime.store.settings().paused).toBe(false)
})

it('does not clear an independent processing pause when the emergency stop is released', async () => {
  const h = host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  await h.runtime.settings.pause(true, 'panel')
  await engage(h)
  await release(h)
  expect(h.runtime.emergency.engaged()).toBe(false)
  expect(h.runtime.store.settings().paused).toBe(true)
  expect(() => h.runtime.inbox.start({ requestId: 'pause-task', title: 'Paused work', text: 'Must wait' }))
    .toThrow('Configure execution and resume the executor before running an action.')
  await h.runtime.settings.pause(false, 'panel')
  const held = h.runtime.inbox.start({ requestId: 'pause-task-2', title: 'Resumed work', text: 'Run after unpause' })
  await vi.waitFor(() => expect(h.agents.get(held.sessionId!)).toBeDefined(), { timeout: 5000 })
})

it('keeps the audit chain verifiable, redacts secret-shaped detail, and detects tampering', () => {
  const directory = mkdtempSync(join(tmpdir(), 'audit-log-'))
  const store = new Store(join(directory, 'audit.sqlite'))
  try {
    const audit = new AuditLog(store)
    audit.append({ actor: 'operator', action: 'connector.configure', resource: 'github', outcome: 'allowed',
      detail: { token: 'must-not-persist', nested: { password: 'also-secret' }, note: 'kept' } })
    audit.append({ actor: 'operator', action: 'task.start', resource: 'ticket:1', outcome: 'completed' })
    expect(audit.verify()).toBe(true)
    expect(audit.list(10).items[0]).toMatchObject({ seq: 2, action: 'task.start', prev: expect.any(String) })
    expect(audit.list(10).items[1]!.detail).toEqual({ token: '[redacted]', nested: { password: '[redacted]' }, note: 'kept' })
    store.db.prepare("UPDATE audit_event SET detail='{}' WHERE seq=1").run()
    expect(audit.verify()).toBe(false)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
