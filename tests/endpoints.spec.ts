import { chmod, link, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Endpoints } from '../src/environments/endpoints.ts'
import { RemoteClient } from '../src/remote/client.ts'
import type { GrantReceipt, RemoteGrant } from '../src/remote/protocol.ts'
import { remoteFixture } from './fixtures/remote.ts'
import { startRuntime } from './fixtures/host.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; vi.restoreAllMocks() })
const create = (workspace = 'operator-work') => ({ op: 'grant.create' as const, requestId: randomUUID(), owner: 'coordinator', workspace,
  operations: ['fs.read', 'fs.write', 'process.spawn'] as RemoteGrant['operations'], leaseMs: 300_000 })
async function fixture() {
  const h = await remoteFixture(cleanup), database = join(h.directory, 'operator.sqlite'), stateDir = join(h.directory, 'operator')
  let store = new Store(database), endpoints = new Endpoints({ store, stateDir, lifetime: new AbortController().signal, workerRoots: () => [h.enrolled.grant.root] })
  const input = { requestId: randomUUID(), endpointId: h.endpoint.journal.id, url: h.url, name: 'Research endpoint', credentialFile: h.connection.credentialFile, revision: 0 }
  const record = await endpoints.register(input)
  cleanup.push(async () => { await endpoints.stop(); store.close() })
  return Object.assign(h, { stateDir, input, record, getStore: () => store, registry: () => endpoints,
    restartOperator: async () => {
      await endpoints.stop(); store.close(); store = new Store(database)
      endpoints = new Endpoints({ store, stateDir, lifetime: new AbortController().signal, workerRoots: () => [h.enrolled.grant.root] })
    } })
}

it('registers a pinned administrator, paginates metadata and denies administration to execution credentials', async () => {
  const h = await fixture(), registry = h.registry()
  expect(await registry.register(h.input)).toEqual(h.record)
  expect(registry.list().items).toHaveLength(1)
  expect(await registry.catalog(h.record.id)).toMatchObject({ grants: { items: [h.enrolled.grant], nextOffset: null }, jobs: { items: [] } })
  expect(await registry.catalog(h.record.id, { offset: 100 })).toMatchObject({ grants: { items: [], nextOffset: null } })
  for (const op of ['grant.list', 'operation.list', 'job.catalog'] as const) await expect(h.client.call({ op })).rejects.toMatchObject({ code: 'admin_required' })
  await expect(h.client.call({ op: 'grant.get', id: h.enrolled.grant.id })).rejects.toMatchObject({ code: 'admin_required' })
  await expect(registry.register({ ...h.input, requestId: randomUUID(), revision: 1, credentialFile: join(h.directory, 'grant.token') })).rejects.toThrow('administrator')
  await expect(registry.register({ ...h.input, requestId: randomUUID(), revision: 0 })).rejects.toThrow('registration changed')
  await expect(registry.register({ ...h.input, name: 'changed' })).rejects.toThrow('another payload')
  expect(JSON.stringify(registry.list())).not.toContain(await readFile(h.connection.credentialFile, 'utf8'))
})

it('recovers an accepted grant by its original request after response loss and operator restart, then composes a private profile', async () => {
  const h = await fixture(), request = create()
  h.failResponse()
  expect(await h.registry().submit(h.record.id, { revision: 1, request })).toMatchObject({ phase: 'unknown', id: request.requestId })
  const grant = h.endpoint.journal.grants().find(grant => grant.workspace === request.workspace)!
  expect(grant.epoch).toBe(1)
  await h.restartOperator()
  expect(h.registry().commands(h.record.id).items[0]).toMatchObject({ phase: 'unknown', request })
  const observed = await h.registry().submit(h.record.id, { revision: 1, request })
  expect(observed.phase).toBe('unknown')
  const done = await h.registry().retry(h.record.id, request.requestId)
  expect(done).toMatchObject({ phase: 'done', result: { grant: { id: grant.id, epoch: 1 } } })
  expect(h.endpoint.journal.grants().filter(grant => grant.workspace === request.workspace)).toHaveLength(1)
  vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const profile = await h.registry().profile(h.record.id, request.requestId, { port: 3084 })
  expect(profile).toMatchObject({ grantId: grant.id, epoch: 1, port: 3084 })
  expect(JSON.parse(await readFile(profile.patchFile, 'utf8'))).toEqual(profile.patch)
  const insertion = profile.patch.find((item: any) => item.insert) as any, config = insertion.insert[0].config
  const token = await readFile(config.credentialFile, 'utf8'), client = new RemoteClient(config)
  expect(await client.call({ op: 'grant.status' })).toMatchObject({ authorized: true, grant: { id: grant.id } })
  expect(JSON.stringify(h.registry().commands(h.record.id))).not.toContain(token)
  expect(JSON.stringify(h.registry().commands(h.record.id))).not.toContain('credentialPin')
  expect(JSON.stringify(profile)).not.toContain(token)
  expect(JSON.stringify(profile)).not.toContain(h.connection.credentialFile)
  expect(profile.patch).toContainEqual({ id: 'fs-sandbox', disabled: true })
  expect(profile.patch).toContainEqual({ id: 'subprocess', disabled: true })
  expect(await h.registry().profile(h.record.id, request.requestId, { port: 3084 })).toEqual(profile)
  const rpc = vi.spyOn(h.endpoint, 'rpc').mockClear()
  expect(await h.registry().retry(h.record.id, request.requestId)).toEqual(done)
  expect(rpc).not.toHaveBeenCalled()
})

it('never adopts a newer generation returned by replay of a lost grant creation', async () => {
  const h = await fixture(), request = create()
  h.failResponse(); await h.registry().submit(h.record.id, { revision: 1, request })
  const grant = h.endpoint.journal.grants().find(grant => grant.workspace === request.workspace)!
  await h.admin.call({ op: 'grant.change', id: grant.id, revision: grant.revision, requestId: randomUUID(), enabled: true, leaseMs: 300_000, reason: 'Independent new authorization' })
  await h.restartOperator()
  expect(await h.registry().retry(h.record.id, request.requestId)).toMatchObject({ phase: 'superseded', result: { grant: { epoch: 2 } } })
  expect(existsSync(join(h.stateDir, 'operator-endpoints', h.record.id, `${grant.id}-2`, 'grant.token'))).toBe(false)
  await expect(h.registry().profile(h.record.id, request.requestId, { port: 3084 })).rejects.toThrow('confirmed enabled')
})

it('pins administrator files through changes and restarts, requires explicit re-registration and preserves old command bindings', async () => {
  const h = await fixture(), request = create()
  const original = await readFile(h.connection.credentialFile, 'utf8')
  h.offline(true)
  expect(await h.registry().submit(h.record.id, { revision: 1, request })).toMatchObject({ phase: 'unknown' })
  h.offline(false)
  await writeFile(h.connection.credentialFile, randomBytes(32).toString('base64url'))
  await expect(h.registry().catalog(h.record.id)).rejects.toThrow('pinned credential file changed')
  expect(await h.registry().retry(h.record.id, request.requestId)).toMatchObject({ phase: 'unknown' })
  await writeFile(h.connection.credentialFile, original)
  const copy = join(h.directory, 'new-admin.token'); await writeFile(copy, original, { mode: 0o600 })
  const updated = await h.registry().register({ ...h.input, requestId: randomUUID(), revision: 1, credentialFile: copy })
  expect(updated.revision).toBe(2)
  await h.restartOperator()
  expect(await h.registry().retry(h.record.id, request.requestId)).toMatchObject({ phase: 'done', enrollmentRevision: 1 })
  await expect(h.registry().submit(h.record.id, { revision: 1, request: create('new') })).rejects.toThrow('registration changed')
  await expect(h.registry().submit(h.record.id, { revision: 2, request: { ...request, workspace: 'new' } })).rejects.toThrow('another payload')
})

it('refuses unsafe administrator files and private files inside a local execution workspace', async () => {
  const h = await fixture(), registry = h.registry(), original = await readFile(h.connection.credentialFile, 'utf8')
  const register = (credentialFile: string) => registry.register({ ...h.input, requestId: randomUUID(), revision: 1, credentialFile })
  const linkFile = join(h.directory, 'symbolic.token'); await symlink(h.connection.credentialFile, linkFile)
  await expect(register(linkFile)).rejects.toThrow('private administrator')
  const hard = join(h.directory, 'hard.token'); await link(h.connection.credentialFile, hard)
  await expect(register(hard)).rejects.toThrow('hard links')
  const publicFile = join(h.directory, 'public.token'); await writeFile(publicFile, original); await chmod(publicFile, 0o644)
  await expect(register(publicFile)).rejects.toThrow('private, owned')
  const worker = join(h.enrolled.grant.root, 'admin.token'); await writeFile(worker, original, { mode: 0o600 })
  await expect(register(worker)).rejects.toThrow('outside every local execution workspace')
  await expect(register('relative.token')).rejects.toThrow('absolute path')
})

it('imports versioned credentials, binds and rotates grants, and refuses stale profiles after revocation', async () => {
  const h = await fixture(), submit = (request: unknown) => h.registry().submit(h.record.id, { revision: 1, request })
  const secret = randomBytes(32).toString('base64url')
  await writeFile(join(h.endpoint.credentials.imports, 'service'), secret, { mode: 0o600 })
  const imported = await submit({ op: 'credential.import', id: 'service', requestId: randomUUID(), revision: 0,
    variable: 'SERVICE_API_KEY', mode: 'env', file: 'service', reason: 'Service authorization' })
  const credential = imported.result!.credential!
  const first = await submit({ ...create(), credentials: [{ id: credential.id, version: credential.version }] }), grant = first.result!.grant!
  expect(grant.credentials).toEqual([{ id: credential.id, version: credential.version, variable: credential.variable, mode: 'env' }])
  const changed = await submit({ op: 'grant.change', requestId: randomUUID(), id: grant.id, revision: grant.revision, enabled: true,
    leaseMs: 300_000, reason: 'Explicit replacement authorization', credentials: [] })
  expect(changed).toMatchObject({ phase: 'done', result: { grant: { epoch: 2, credentials: [] } } })
  vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  await expect(h.registry().profile(h.record.id, first.id, { port: 3084 })).rejects.toThrow('grant expired or changed')
  const composed = await h.registry().profile(h.record.id, changed.id, { port: 3084 })
  const config = (composed.patch.find((item: any) => item.insert) as any).insert[0].config
  await writeFile(config.credentialFile, 'tampered')
  await expect(h.registry().profile(h.record.id, changed.id, { port: 3085 })).rejects.toThrow('Credential must be')
  await submit({ op: 'credential.revoke', requestId: randomUUID(), id: credential.id, revision: credential.revision, reason: 'Service retired' })
  expect(JSON.stringify(await h.registry().catalog(h.record.id))).not.toContain(secret)
  expect(JSON.stringify(h.registry().commands(h.record.id))).not.toContain(secret)
})

it('records explicit operator reconciliation while keeping unknown outcomes and excluding command payloads', async () => {
  const h = await fixture(), id = randomUUID(), at = new Date().toISOString(), request = h.spawn('printf private-command-payload')
  h.endpoint.journal.saveJob({ id, grantId: h.enrolled.grant.id, epoch: 1, revision: 1, fingerprint: 'test', phase: 'unknown',
    request, createdAt: at, updatedAt: at, cancelRequested: false, quiescent: null })
  const operation = randomUUID()
  h.endpoint.journal.saveOperation({ id: operation, grantId: h.enrolled.grant.id, epoch: 1, fingerprint: 'test', kind: 'fs.write', phase: 'unknown', at })
  expect(JSON.stringify(await h.registry().catalog(h.record.id))).not.toContain('private-command-payload')
  const reconcile = { op: 'job.reconcile', id, requestId: randomUUID(), note: 'Verified no remaining process range on the endpoint', quiescent: true }
  await expect(h.registry().submit(h.record.id, { revision: 1, request: { ...reconcile, quiescent: false } })).rejects.toThrow()
  expect(h.registry().commands(h.record.id).items).toHaveLength(0)
  expect(await h.registry().submit(h.record.id, { revision: 1, request: reconcile })).toMatchObject({ phase: 'done', result: { job: { phase: 'unknown', quiescent: true } } })
  expect(await h.registry().submit(h.record.id, { revision: 1, request: { op: 'operation.reconcile', id: operation, requestId: randomUUID(), note: 'Verified file state and stopped all prior helpers' } }))
    .toMatchObject({ phase: 'done', result: { operation: { phase: 'unknown', reconciled: { note: 'Verified file state and stopped all prior helpers' } } } })
  await expect(h.registry().submit(h.record.id, { revision: 1, request: h.spawn('true') })).rejects.toThrow('not an operator')
  await expect(h.registry().submit(h.record.id, { revision: 1, request: { op: 'fs.write', path: 'test', content: 'x', requestId: randomUUID() } })).rejects.toThrow('not an operator')
})

it('exposes enrollment and administration through Runtime management routes without returning bearer credentials', async () => {
  const h = await remoteFixture(cleanup), host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  cleanup.push(() => host.stop())
  const registration = await host.api('POST', 'endpoints', { requestId: randomUUID(), endpointId: h.endpoint.journal.id, url: h.url,
    name: 'Runtime endpoint', credentialFile: h.connection.credentialFile, revision: 0 })
  expect(registration.status).toBe(200)
  const id = h.endpoint.journal.id, request = create(), path = `endpoints/${id}`
  expect((await host.api('GET', 'endpoints')).body).toMatchObject({ items: [{ id, revision: 1 }] })
  const result = await host.api('POST', `${path}/commands`, { revision: 1, request })
  expect(result.body).toMatchObject({ phase: 'done', result: { grant: { workspace: request.workspace } } })
  const token = h.endpoint.journal.credential((result.body as any).result.grant.id, 1)
  expect(JSON.stringify(result)).not.toContain(token)
  expect((await host.api('POST', `${path}/commands/${request.requestId}/retry`)).body).toEqual(result.body)
  expect((await host.api('GET', `${path}/commands`)).body).toMatchObject({ items: [result.body] })
  expect((await host.api('GET', `${path}/catalog`)).status).toBe(200)
  expect((await host.api('GET', `${path}/catalog?offset=-1`)).status).toBe(400)
  expect((await host.api('POST', `${path}/commands/${request.requestId}/profile`, { port: 3084 })).status).toBe(409)
  vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const profile = await host.api('POST', `${path}/commands/${request.requestId}/profile`, { port: 3084 })
  expect(profile.status).toBe(200)
  expect(String(profile.body.patchFile)).toContain(realpathSync(host.directory))
})

it('keeps administrative catalog pages below the transport cap even when command and file receipts contain large payloads', async () => {
  const h = await fixture(), at = new Date().toISOString(), payload = 'private-payload-'.repeat(32_768)
  for (let index = 0; index < 101; index++) {
    const id = `large-${index}`
    h.endpoint.journal.saveJob({ id, grantId: h.enrolled.grant.id, epoch: 1, revision: 1, fingerprint: 'test', phase: 'settled',
      request: { ...h.spawn('true'), stdin: index < 18 ? payload : '' }, createdAt: at, updatedAt: at, cancelRequested: false, quiescent: true })
    h.endpoint.journal.saveOperation({ id, grantId: h.enrolled.grant.id, epoch: 1, fingerprint: 'test', kind: 'fs.write', phase: 'settled', at,
      error: { code: 'test', message: index < 18 ? payload : '' } })
  }
  const first = await h.registry().catalog(h.record.id), last = await h.registry().catalog(h.record.id, { offset: 100 })
  expect(first.jobs.items).toHaveLength(100); expect(first.operations.items).toHaveLength(100)
  expect(first.jobs.nextOffset).toBe(100); expect(first.operations.nextOffset).toBe(100)
  expect(last.jobs.items).toHaveLength(1); expect(last.operations.items).toHaveLength(1)
  expect(last.jobs.nextOffset).toBeNull(); expect(last.operations.nextOffset).toBeNull()
  expect(JSON.stringify(first)).not.toContain('private-payload-')
  expect(JSON.stringify(first).length).toBeLessThan(100_000)
}, 20_000)
