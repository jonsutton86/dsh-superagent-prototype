import { readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Environments } from '../src/environments/service.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { filesystem } from './fixtures/filesystem.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.restoreAllMocks() })
async function fixture() { host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true }); return host }
const enrollment = (env: Environments, extra = {}) => ({ requestId: 'enroll-next', name: 'Next workspace',
  root: env.list().currentRoot, mode: env.list().currentMode, ...extra })
const first = (env: Environments) => env.list().items.find(item => item.current)!
const command = (env: Environments, enabled: boolean, extra = {}) => ({ requestId: enabled ? 'enable' : 'revoke',
  revision: first(env).revision, enabled, reason: 'Operator changed execution grant', ...extra })
const task = (h: Host, id = 'task') => h.runtime.inbox.start({ requestId: id, title: 'Evidence task', text: 'Produce a brief' })

it('enrolls the initial profile, pairs both providers, and hides the identity marker from the API', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env)
  expect(env.ready()).toBe(true)
  expect(record).toMatchObject({ enabled: true, revision: 1, epoch: 1, capabilities: { remote: false, osIsolation: false } })
  expect(record).not.toHaveProperty('identity')
  expect((await h.api('GET', 'state')).body).toMatchObject({ environment: { ready: true }, health: { environment: { state: 'ready' } } })
  const result = await h.api('GET', 'environments')
  expect(result.status).toBe(200)
  expect(JSON.stringify(result.body)).not.toContain('identity')
  expect((await readdir(record.root)).filter(name => name.startsWith('.dsh-world-'))).toEqual([])
  const item = task(h), ticket = h.runtime.store.tickets.get(item.id)!
  expect(ticket.execution?.environment).toEqual({ environmentId: record.id, revision: 1, epoch: 1 })
  expect(ticket.mandate.environment).toEqual(ticket.execution?.environment)
  await h.runtime.idle()
  await expect(env.validate(h.runtime.store.tickets.get(item.id)!)).resolves.toBeUndefined()
})

it('revokes running and follow-up work, refuses old grants after reauthorizing, and does not resume stopped tasks', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env)
  const running = task(h, 'running'), waiting = task(h, 'waiting')
  await h.runtime.idle()
  await h.runTool(waiting.sessionId!, 'orchestrator_report', { state: 'blocked', summary: 'Need a choice', human_action: 'Which format?' })
  const grant = h.runtime.store.tickets.get(running.id)!.mandate.environment
  const request = command(env, false)
  const revoked = await env.update(record.id, request)
  expect(revoked).toMatchObject({ enabled: false, revision: 2, epoch: 2, openTickets: 0 })
  expect(env.ready()).toBe(false); expect(env.allows(grant)).toBe(false)
  for (const item of [running, waiting]) expect(h.runtime.inbox.item(item.id)).toMatchObject({ canReply: false, status: 'stopped' })
  expect(() => task(h, 'refused')).toThrow()
  expect(await env.update(record.id, request)).toMatchObject({ revision: 2 })
  await expect(env.update(record.id, { ...request, reason: 'Changed payload' })).rejects.toThrow('already used')
  const enabled = await env.update(record.id, command(env, true))
  expect(enabled).toMatchObject({ revision: 3, epoch: 3, enabled: true })
  expect(env.allows(grant)).toBe(false)
  expect(h.runtime.inbox.item(running.id).status).toBe('stopped')
  const next = task(h, 'fresh')
  expect(h.runtime.store.tickets.get(next.id)!.mandate.environment?.epoch).toBe(3)
})

it('requires reviewed root and mode on explicit enrollment and preserves old ticket bindings when defaults change', async () => {
  const h = await fixture(), env = h.runtime.environments, original = first(env), old = task(h)
  await h.runtime.idle()
  const oldTicket = h.runtime.store.tickets.get(old.id)!, settings = h.runtime.store.settings()
  const stale = enrollment(env)
  const next = join(h.directory, 'second-world')
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, directory: next } })
  expect(env.ready()).toBe(false); expect(env.list().needsEnrollment).toBe(true)
  expect(() => task(h, 'premature')).toThrow()
  await expect(env.enroll(stale)).rejects.toThrow('profile changed')
  await expect(env.enroll(enrollment(env, { mode: 'repository' }))).rejects.toThrow('profile changed')
  const request = enrollment(env), enrolled = await env.enroll(request)
  expect(enrolled.id).not.toBe(original.id)
  expect((await env.enroll(request)).id).toBe(enrolled.id)
  expect(env.list().items).toHaveLength(2)
  await expect(env.validate(oldTicket)).resolves.toBeUndefined()
  const newer = task(h, 'new-world')
  expect(h.runtime.store.tickets.get(newer.id)!.execution?.environment?.environmentId).toBe(enrolled.id)
  expect(h.runtime.store.tickets.get(old.id)!.execution).toEqual(oldTicket.execution)
})

it('fails closed on missing or changed identity and replaces enrollment without transferring old work', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env), item = task(h)
  await h.runtime.idle()
  await writeFile(join(record.root, `.dsh-environment-${record.id}`), 'another identity')
  await expect(env.validate(h.runtime.store.tickets.get(item.id)!)).rejects.toThrow('identity')
  expect(env.ready()).toBe(false)
  await expect(env.enroll(enrollment(env))).rejects.toThrow('identity')
  const request = enrollment(env, { requestId: 'replace', replaceId: record.id, revision: record.revision })
  const replacement = await env.enroll(request)
  expect(replacement.id).not.toBe(record.id); expect(env.ready()).toBe(true)
  expect(env.list().items.find(item => item.id === record.id)).toMatchObject({ retired: true, enabled: false, current: false })
  expect(h.runtime.inbox.item(item.id).status).toBe('stopped')
  await expect(env.update(record.id, { ...command(env, true), revision: 2 })).rejects.toThrow()
  expect((await env.enroll(request)).id).toBe(replacement.id)
  expect(env.list().items).toHaveLength(2)
})

it('rejects a symlink to a different task even when its target is inside the enrolled root', async () => {
  const h = await fixture(), env = h.runtime.environments, item = task(h)
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(item.id)!, directory = ticket.execution!.directory
  await rename(directory, `${directory}-other`); await symlink(`${directory}-other`, directory)
  await expect(env.validate(ticket)).rejects.toThrow('assigned location')
  await unlink(directory)
  await symlink(h.directory, directory)
  await expect(env.validate(ticket)).rejects.toThrow('assigned location')
})

it('rechecks revocation after asynchronous provider validation', async () => {
  const h = await fixture(), env = h.runtime.environments, item = task(h)
  await h.runtime.idle()
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), original = filesystem.readText
  vi.spyOn(filesystem, 'readText').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return original(...args) })
  const proof = env.validate(h.runtime.store.tickets.get(item.id)!)
  await entered.promise
  await env.update(first(env).id, command(env, false)); gate.resolve()
  await expect(proof).rejects.toThrow('revoked during validation')
  expect(env.ready()).toBe(false)
})

it('refuses filesystem or subprocess mismatches and removes temporary proof files', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env)
  const read = vi.spyOn(filesystem, 'readText').mockResolvedValueOnce('wrong world')
  await expect(env.enroll(enrollment(env))).rejects.toThrow()
  expect(env.ready()).toBe(false); read.mockRestore()
  await env.enroll(enrollment(env))
  expect(env.ready()).toBe(true)
  h.subprocess.spawn.mockImplementationOnce(() => ({ done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: { stdout: { readFrom: () => ({ text: 'wrong process world', nextOffset: 0, lossy: false }) } } } as never))
  await expect(env.enroll(enrollment(env, { requestId: 'verify-process' }))).rejects.toThrow()
  expect(env.ready()).toBe(false)
  expect((await readdir(record.root)).filter(name => name.startsWith('.dsh-world-'))).toEqual([])
})

it('does not commit an enrollment if the reviewed profile changes while the proof is running', async () => {
  const h = await fixture(), env = h.runtime.environments, settings = h.runtime.store.settings()
  const newRoot = join(h.directory, 'new-root')
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, directory: newRoot } })
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), original = filesystem.readText
  vi.spyOn(filesystem, 'readText').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return original(...args) })
  const enroll = env.enroll(enrollment(env))
  await entered.promise
  h.runtime.store.saveSettings(settings); gate.resolve()
  await expect(enroll).rejects.toThrow('profile changed during verification')
  expect(env.list().items).toHaveLength(1)
  expect((await readdir(newRoot)).filter(name => name.startsWith('.dsh-environment-'))).toEqual([])
})

it('reopens persistent grants and command receipts, but verifies identity anew before admission', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env)
  const request = command(env, false); await env.update(record.id, request)
  const store = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const reopened = new Environments({ store, filesystem: h.ctx.fs, subprocess: h.ctx.subprocess, lifetime: new AbortController().signal,
      root: () => record.configuredRoot, mode: () => 'local', engine: () => h.runtime.engine })
    expect(reopened.ready()).toBe(false)
    await reopened.initialize()
    expect(await reopened.update(record.id, request)).toMatchObject({ enabled: false, revision: 2 })
    await reopened.update(record.id, command(reopened, true))
    expect(reopened.ready()).toBe(true)
    await unlink(join(record.root, `.dsh-environment-${record.id}`))
    const failed = new Environments({ store, filesystem: h.ctx.fs, subprocess: h.ctx.subprocess, lifetime: new AbortController().signal,
      root: () => record.configuredRoot, mode: () => 'local', engine: () => h.runtime.engine })
    await failed.initialize()
    expect(failed.ready()).toBe(false); expect(first(failed).problem).toContain('ENOENT')
    expect(store.db.prepare('SELECT * FROM execution_environment_event').all()).toHaveLength(3)
  } finally { store.close() }
})

it('pins legacy execution without rewriting its historical mandate and includes legacy work in revocation', async () => {
  const h = await fixture(), env = h.runtime.environments, item = task(h)
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(item.id)!
  delete ticket.mandate.environment; delete ticket.execution!.environment
  h.runtime.store.tickets.save(ticket)
  const mandate = structuredClone(ticket.mandate), pinned = env.pin(ticket)
  expect(pinned.mandate).toEqual(mandate)
  expect(pinned.execution?.environment?.environmentId).toBe(first(env).id)
  delete pinned.execution!.environment; h.runtime.store.tickets.save(pinned)
  await env.update(first(env).id, command(env, false))
  expect(h.runtime.inbox.item(item.id).status).toBe('stopped')
})

it('returns validation, missing-record and stale-revision refusals through management routes', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env)
  expect((await h.api('POST', 'environments', { ...enrollment(env), identity: 'injected' })).status).toBe(400)
  expect((await h.api('PUT', 'environments/missing', command(env, false))).status).toBe(404)
  expect((await h.api('PUT', `environments/${record.id}`, command(env, false, { revision: 99 }))).status).toBe(409)
  expect(env.ready()).toBe(true)
  const result = await h.api('PUT', `environments/${record.id}`, command(env, false))
  expect(result.status).toBe(200)
  expect((await h.api('GET', 'state')).body).toMatchObject({ environment: { ready: false }, health: { environment: { state: 'paused' } } })
})

it('blocks a queued worker before preparing its directory when the enrolled identity changed after acceptance', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env), item = task(h)
  writeFileSync(join(record.root, `.dsh-environment-${record.id}`), 'substituted')
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(item.id)!
  expect(ticket.assignments.at(-1)?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('identity') })
  expect(h.agents.has(item.sessionId!)).toBe(false)
  expect(env.ready()).toBe(false)
  expect(h.runtime.health.environment?.state).toBe('paused')
})

it('rolls back the grant, stop requests, audit and receipt if revocation cannot stop every ticket', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env)
  task(h, 'one'); task(h, 'two'); await h.runtime.idle()
  const stop = h.runtime.engine.stopTicket.bind(h.runtime.engine)
  vi.spyOn(h.runtime.engine, 'stopTicket').mockImplementationOnce(stop).mockImplementationOnce(() => { throw new Error('Stop persistence failed') })
  await expect(env.update(record.id, command(env, false))).rejects.toThrow('Stop persistence failed')
  expect(first(env)).toMatchObject({ revision: 1, epoch: 1, enabled: true, openTickets: 2 })
  expect(h.runtime.store.db.prepare('SELECT * FROM execution_environment_event').all()).toHaveLength(1)
  expect(h.runtime.store.db.prepare('SELECT * FROM execution_environment_command WHERE id=?').get('revoke')).toBeUndefined()
  for (const ticket of h.runtime.store.tickets.list()) expect(ticket.ended).toBeUndefined()
})

it('refuses a root that now resolves to another location even when the original marker moved with it', async () => {
  const h = await fixture(), env = h.runtime.environments, record = first(env), item = task(h)
  await h.runtime.idle()
  await rename(record.configuredRoot, `${record.configuredRoot}-moved`)
  await symlink(`${record.configuredRoot}-moved`, record.configuredRoot)
  await expect(env.validate(h.runtime.store.tickets.get(item.id)!)).rejects.toThrow('another location')
  expect(env.ready()).toBe(false)
})
