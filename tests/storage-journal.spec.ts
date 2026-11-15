import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RemoteJournal, fingerprint } from '../src/remote/journal.ts'
import { EndpointStorage } from '../src/remote/storage-model.ts'
import { RemoteEndpoint, type EndpointHost } from '../src/remote/endpoint.ts'
import { StorageReservations } from '../src/remote/storage-journal.ts'

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
