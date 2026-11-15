import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteJournal, fingerprint } from '../src/remote/journal.ts'
import { EndpointStorageManager } from '../src/remote/endpoint-storage.ts'
import { StorageProvisioning, type StorageHost } from '../src/remote/storage-provisioning.ts'
import { EndpointStorage, type StorageObservation, type StorageReservation } from '../src/remote/storage-model.ts'
import { RemoteEndpoint, type EndpointHost } from '../src/remote/endpoint.ts'
import { StorageReservations, storageRoots } from '../src/remote/storage-journal.ts'

const policy: EndpointStorage = { kind: 'linux-xfs-project', filesystemUUID: 'a9b48006-3a5a-4238-a2c8-b64e1f6b530a',
  mountRoot: '/srv/storage', projectIds: { first: 100, last: 104 },
  pool: { bytes: 32 * 1024 ** 2, inodes: 256 }, workspace: { bytes: 16 * 1024 ** 2, inodes: 128 } }
const roots: string[] = [], journals: RemoteJournal[] = []
afterEach(() => { for (const journal of journals.splice(0)) journal.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(configured = policy) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-storage-')); roots.push(root)
  const open = () => { const journal = new RemoteJournal(join(root, 'state'), join(root, 'work')); journals.push(journal); return journal }
  const journal = open()
  return { journal, open, storage: new StorageReservations(journal, configured) }
}
const intent = (workspace: string) => ({ requestId: 'request-' + workspace, requestHash: fingerprint({ workspace }), workspace })

it('retains original allocation and uncertain provisioning after closing and reopening the actual endpoint journal', () => {
  const { journal, open, storage } = fixture(), request = intent('one')
  const original = storage.reserve(request)
  expect(original.projectId).toBe(100)
  expect(storage.beginProvisioning(request)).toBe(true)
  journal.close(); journals.splice(journals.indexOf(journal), 1)
  const recovered = new StorageReservations(open(), policy)
  expect(recovered.reserve(request)).toEqual({ ...original, phase: 'provisioning' })
  expect(recovered.beginProvisioning(request)).toBe(false)
  expect(recovered.reserve(intent('two')).projectId).toBe(101)
  expect(() => recovered.reserve(intent('three'))).toThrow('budget is exhausted')
})
it('rejects conflicting request replay and a new request trying to replace the original workspace reservation', () => {
  const { storage } = fixture(), request = intent('one')
  storage.reserve(request)
  expect(() => storage.reserve({ ...request, requestHash: fingerprint('other') })).toThrow('another payload')
  expect(() => storage.reserve({ ...request, workspace: 'other' })).toThrow('another payload')
  expect(() => storage.reserve({ ...request, requestId: 'replacement' })).toThrow('original storage allocation')
  expect(() => storage.beginProvisioning(intent('missing'))).toThrow('Original storage allocation')
  expect(storage.list()).toHaveLength(1)
})
it.each(['bytes', 'inodes', 'ids'] as const)('bounds allocations by %s while retaining unresolved capacity', bound => {
  const configured = structuredClone(policy)
  if (bound === 'ids') configured.projectIds.last = configured.projectIds.first
  else configured.pool[bound] = configured.workspace[bound]
  const { storage } = fixture(configured)
  storage.reserve(intent('one')); storage.beginProvisioning(intent('one'))
  expect(() => storage.reserve(intent('two'))).toThrow('budget is exhausted')
})
it('pins policy and refuses implicit migration of an existing grant', () => {
  const { journal } = fixture()
  expect(() => new StorageReservations(journal, { ...policy, mountRoot: '/replacement' })).toThrow('cannot be replaced')
  journal.db.prepare('DELETE FROM endpoint_meta WHERE key=?').run('storage-policy')
  journal.db.prepare('INSERT INTO remote_grant VALUES (?,?)').run('existing', JSON.stringify({ id: 'existing' }))
  expect(() => new StorageReservations(journal, policy)).toThrow('explicit storage migration')
})
it('rolls back reservation when its audit receipt cannot commit', () => {
  const { journal, storage } = fixture()
  journal.db.exec("CREATE TRIGGER reject_storage_audit BEFORE INSERT ON remote_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  expect(() => storage.reserve(intent('one'))).toThrow('audit unavailable')
  expect(storage.list()).toEqual([])
  journal.db.exec('DROP TRIGGER reject_storage_audit')
  expect(storage.reserve(intent('one')).projectId).toBe(100)
})
it('fails closed on corrupted identity instead of treating its allocation as free', () => {
  const { journal, storage } = fixture()
  const value = storage.reserve(intent('one'))
  journal.db.prepare('UPDATE remote_storage SET value=?').run(JSON.stringify({ ...value, projectId: 101 }))
  expect(() => storage.reserve(intent('two'))).toThrow('persisted identity')
  expect(() => new StorageReservations(journal, policy)).toThrow('persisted identity')
})
it('rejects unaligned, unlimited, traversing, reversed and unknown policy fields', () => {
  for (const change of [{ workspace: { ...policy.workspace, bytes: 1 } }, { workspace: { ...policy.workspace, inodes: 0 } },
    { mountRoot: '/srv/../storage' }, { mountRoot: '/' }, { mountRoot: '/srv//storage' },
    { projectIds: { first: 0, last: 5 } }, { projectIds: { first: 10, last: 5 } }, { extra: true }]) {
    expect(EndpointStorage.safeParse({ ...policy, ...change }).success).toBe(false)
  }
})

it('does not allow caller mutation to raise the pinned allocation budget', () => {
  const { storage } = fixture()
  expect(() => { storage.policy.pool.bytes *= 2 }).toThrow()
  expect(() => { storage.policy.projectIds.last = 999 }).toThrow()
})
it('refuses retained allocations whose policy is missing and never starts an unenforced endpoint', () => {
  const { journal, storage } = fixture()
  storage.reserve(intent('one'))
  journal.db.prepare('DELETE FROM endpoint_meta WHERE key=?').run('storage-policy')
  expect(() => new StorageReservations(journal, policy)).toThrow('Restore the original storage policy')
  journal.db.prepare('INSERT INTO endpoint_meta VALUES (?,?)').run('storage-policy', JSON.stringify(policy))
  const stateDir = journal.directory, root = journal.root
  journal.close(); journals.splice(journals.indexOf(journal), 1)
  expect(() => new RemoteEndpoint({ stateDir, root } as EndpointHost)).toThrow('requires storage enforcement')
})

function observed(reservation: StorageReservation): StorageObservation {
  return { mountId: 42, filesystemUUID: policy.filesystemUUID, mountRoot: policy.mountRoot, projectId: reservation.projectId,
    directories: storageRoots(policy, reservation).map((path, index) => ({ path, device: '8', inode: String(100 + index),
      projectId: reservation.projectId, inherits: true, realtime: false })),
    quota: { accounting: true, enforcement: true, usedBytes: 0, hardBytes: policy.workspace.bytes,
      usedInodes: 2, hardInodes: policy.workspace.inodes }, observedAt: new Date().toISOString() }
}
it('recovers a lost provisioning response by observing original roots, never repeating the host write', async () => {
  const { journal, open, storage } = fixture(), request = intent('one')
  const host: StorageHost = { provision: vi.fn(async () => { throw new Error('response lost after host write') }),
    observe: vi.fn(async (_, reservation) => observed(reservation)) }
  await expect(new StorageProvisioning(storage, host).prepare(request, AbortSignal.timeout(5000))).rejects.toThrow('response lost')
  expect(storage.list()[0]!.phase).toBe('provisioning')
  expect(host.observe).not.toHaveBeenCalled()
  journal.close(); journals.splice(journals.indexOf(journal), 1)
  const restored = new StorageReservations(open(), policy), service = new StorageProvisioning(restored, host)
  const result = await service.prepare(request, AbortSignal.timeout(5000))
  expect(result).toMatchObject({ projectId: 100, phase: 'provisioned', observation: { projectId: 100 } })
  await service.prepare(request, AbortSignal.timeout(5000))
  expect(host.provision).toHaveBeenCalledTimes(1)
  expect(host.observe).toHaveBeenCalledTimes(2) // Stored evidence is never substituted for a new observation.
})
it('serializes duplicate preparation and preserves one original host effect', async () => {
  const { storage } = fixture(), release = Promise.withResolvers<void>()
  const host: StorageHost = { provision: vi.fn(async () => release.promise), observe: vi.fn(async (_, reservation) => observed(reservation)) }
  const service = new StorageProvisioning(storage, host), request = intent('one'), signal = AbortSignal.timeout(5000)
  const first = service.prepare(request, signal), second = service.prepare(request, signal)
  release.resolve()
  expect((await Promise.all([first, second])).map(item => item.projectId)).toEqual([100, 100])
  expect(host.provision).toHaveBeenCalledTimes(1)
  expect(host.observe).toHaveBeenCalledTimes(2)
})
it('does not record provisioning success from mismatched or disabled quota evidence', () => {
  const { storage } = fixture(), request = intent('one'), reservation = storage.reserve(request)
  storage.beginProvisioning(request)
  for (const change of [
    { projectId: 101 }, { mountRoot: '/other' }, { directories: [observed(reservation).directories[0]!] },
    { quota: { ...observed(reservation).quota, hardBytes: policy.workspace.bytes * 2 } },
    { quota: { ...observed(reservation).quota, enforcement: false } },
  ]) expect(() => storage.recordObservation(request, { ...observed(reservation), ...change } as StorageObservation)).toThrow()
  expect(storage.list()[0]!.phase).toBe('provisioning')
})
it('refuses root identity replacement even when its new quota membership matches', () => {
  const { storage } = fixture(), request = intent('one'), reservation = storage.reserve(request)
  storage.beginProvisioning(request); storage.recordObservation(request, observed(reservation))
  const changed = observed(reservation); changed.directories[0]!.inode = '999'
  expect(() => storage.recordObservation(request, changed)).toThrow('changed identity')
  expect(storage.list()[0]!.observation!.directories[0]!.inode).toBe('100')
})
it('keeps original provisioning intent if observation receipt fails to commit', async () => {
  const { journal, storage } = fixture(), request = intent('one')
  const host: StorageHost = { provision: vi.fn(async () => {}), observe: vi.fn(async (_, reservation) => {
    journal.db.exec("CREATE TRIGGER reject_storage_observation BEFORE UPDATE ON remote_storage BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END")
    return observed(reservation)
  }) }
  const service = new StorageProvisioning(storage, host)
  await expect(service.prepare(request, AbortSignal.timeout(5000))).rejects.toThrow('receipt unavailable')
  expect(storage.list()[0]!.phase).toBe('provisioning')
  journal.db.exec('DROP TRIGGER reject_storage_observation')
  host.observe = vi.fn(async (_, reservation) => observed(reservation))
  expect((await service.prepare(request, AbortSignal.timeout(5000))).phase).toBe('provisioned')
  expect(host.provision).toHaveBeenCalledTimes(1)
})
it('retains uncertain capacity on cancellation at the effect boundary', async () => {
  const { storage } = fixture(), request = intent('one'), abort = new AbortController()
  const host: StorageHost = { provision: vi.fn(async () => { abort.abort() }), observe: vi.fn(async (_, reservation) => observed(reservation)) }
  await expect(new StorageProvisioning(storage, host).prepare(request, abort.signal)).rejects.toThrow()
  expect(storage.list()[0]!.phase).toBe('provisioning')
  expect(host.observe).not.toHaveBeenCalled()
})

it('rejects corrupted persisted observation on reopen', () => {
  const { journal, storage } = fixture(), request = intent('one'), reservation = storage.reserve(request)
  storage.beginProvisioning(request)
  const value = storage.recordObservation(request, observed(reservation))
  value.observation!.quota.hardInodes *= 2
  journal.db.prepare('UPDATE remote_storage SET value=?').run(JSON.stringify(value))
  expect(() => new StorageReservations(journal, policy)).toThrow('does not match original storage allocation')
})

it('pins an administrator-assigned endpoint identity on first creation and refuses replacement on reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-storage-')); roots.push(root)
  const state = join(root, 'state'), work = join(root, 'work'), original = randomUUID()
  let journal = new RemoteJournal(state, work, original)
  expect(journal.id).toBe(original); journal.close()
  expect(() => new RemoteJournal(state, work, randomUUID())).toThrow('differs from the original journal')
  journal = new RemoteJournal(state, work, original); journals.push(journal)
  expect(journal.id).toBe(original)
})
it('rejects a malformed assigned identity before initializing directories', () => {
  expect(() => new RemoteJournal('/unused-storage-state', '/unused-storage-root', 'not-an-id')).toThrow('canonical UUID')
})

it('requires visible capacity for persistent startup qualification plus a worker workspace', () => {
  const { journal } = fixture()
  for (const constrained of [
    { ...policy, pool: { ...policy.pool, bytes: policy.workspace.bytes } },
    { ...policy, pool: { ...policy.pool, inodes: policy.workspace.inodes } },
    { ...policy, projectIds: { first: 100, last: 100 } },
  ]) expect(() => new EndpointStorageManager(journal, { endpointId: journal.id, policy: constrained, host: {} as StorageHost },
    `${policy.mountRoot}/dsh-${journal.id}/workspaces`)).toThrow('startup qualification and at least one worker')
})

it('observes live quota without settling uncertain intents or changing journal inventory', async () => {
  const { journal, storage } = fixture(), request = intent('one')
  const host: StorageHost = { provision: vi.fn(async () => {}), observe: vi.fn(async (_, reservation) => observed(reservation)) }
  const manager = new EndpointStorageManager(journal, { endpointId: journal.id, policy, host }, `${policy.mountRoot}/dsh-${journal.id}/workspaces`)
  storage.reserve(request)
  expect(await manager.status(request.workspace, AbortSignal.timeout(1000))).toMatchObject({ state: 'not-provisioned', reservedAllocations: 1 })
  expect(host.observe).not.toHaveBeenCalled()
  storage.beginProvisioning(request)
  const before = journal.db.prepare('SELECT value FROM remote_storage').all()
  const changes = journal.db.prepare('SELECT total_changes() AS count').get()
  expect(await manager.status(request.workspace, AbortSignal.timeout(1000))).toMatchObject({ state: 'observed', phase: 'provisioning', quota: { enforcement: true } })
  expect(journal.db.prepare('SELECT value FROM remote_storage').all()).toEqual(before)
  expect(journal.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
  expect(host.provision).not.toHaveBeenCalled()
  host.observe = vi.fn(async () => { throw new Error('private host diagnostic') })
  const unavailable = await manager.status(request.workspace, AbortSignal.timeout(1000))
  expect(unavailable).toMatchObject({ state: 'unavailable', reservedAllocations: 1 })
  expect(JSON.stringify(unavailable)).not.toContain('private host diagnostic')
  expect(unavailable).not.toHaveProperty('quota')
  await expect(manager.status(request.workspace, AbortSignal.abort())).rejects.toThrow()
})

it('refuses replaced roots in status and keeps previous observation historical', async () => {
  const { journal, storage } = fixture(), request = intent('one'), reserved = storage.reserve(request)
  storage.beginProvisioning(request); storage.recordObservation(request, observed(reserved))
  const changed = observed(reserved); changed.directories[0]!.inode = '999'
  const host: StorageHost = { provision: vi.fn(), observe: vi.fn(async () => changed) }
  const manager = new EndpointStorageManager(journal, { endpointId: journal.id, policy, host }, `${policy.mountRoot}/dsh-${journal.id}/workspaces`)
  expect(await manager.status(request.workspace, AbortSignal.timeout(1000))).toMatchObject({ state: 'unavailable' })
  expect(storage.list()[0]!.observation!.directories[0]!.inode).toBe('100')
  expect(await manager.status('missing', AbortSignal.timeout(1000))).toMatchObject({ state: 'unallocated', reservedAllocations: 1 })
})
