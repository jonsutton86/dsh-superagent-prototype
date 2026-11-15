import { expect, it } from 'vitest'
import { auditStorageRecoveryBindings } from '../src/recovery/storage.ts'

function fixture() {
  const endpointId = '11111111-1111-4111-8111-111111111111'
  const policy = { kind: 'linux-xfs-project', filesystemUUID: '22222222-2222-4222-8222-222222222222', mountRoot: '/srv/quota',
    projectIds: { first: 100, last: 109 }, pool: { bytes: 8192, inodes: 20 }, workspace: { bytes: 4096, inodes: 10 } }
  const intent = { endpointId, requestId: 'original', requestHash: 'a'.repeat(64), workspace: 'work', projectId: 100 }
  const roots = ['workspaces', 'verification'].map((name, i) => ({ path: `/srv/quota/dsh-${endpointId}/${name}/work`, device: '1', inode: String(i + 10),
    projectId: 100, inherits: true, realtime: false }))
  const reservation = { ...intent, phase: 'provisioned', createdAt: '2026-11-15T00:00:00.000Z', observation: {
    mountId: 1, filesystemUUID: policy.filesystemUUID, mountRoot: policy.mountRoot, projectId: 100, directories: roots,
    quota: { accounting: true, enforcement: true, usedBytes: 0, hardBytes: 4096, usedInodes: 2, hardInodes: 10 }, observedAt: '2026-11-15T00:00:00.000Z' } }
  const grant = { id: '33333333-3333-4333-8333-333333333333', owner: 'coordinator', workspace: 'work', root: roots[0]!.path,
    rootIdentity: '1:10:12345', operations: ['fs.read'], revision: 1, epoch: 1, enabled: true, leaseUntil: 1, createdAt: '', updatedAt: '' }
  return { endpoint: { endpointId, policy, reservations: [reservation], grants: [grant] },
    host: { endpointId, policy: structuredClone(policy), operations: [{ intent, roots: roots.map(({ device, inode }) => ({ device, inode })) }] } }
}

it('matches retained allocations and grant roots without claiming live enforcement or restore readiness', () => {
  const value = fixture(), before = structuredClone(value)
  expect(auditStorageRecoveryBindings(value.endpoint, value.host)).toMatchObject({ allocations: 1, provisioned: 1, recordBindingsVerified: true,
    liveFilesystemVerified: false, restoreVerified: false })
  expect(value).toEqual(before)
})

it.each(['request', 'project', 'policy', 'identity', 'missing', 'extra', 'grant', 'quota', 'duplicate'])(
  'refuses a mismatched %s binding', kind => {
    const { endpoint, host } = fixture()
    if (kind === 'request') host.operations[0]!.intent.requestHash = 'b'.repeat(64)
    if (kind === 'project') host.operations[0]!.intent.projectId++
    if (kind === 'policy') host.policy.workspace.inodes--
    if (kind === 'identity') host.operations[0]!.roots[0]!.inode = '99'
    if (kind === 'missing') host.operations = []
    if (kind === 'extra') host.operations.push({ ...structuredClone(host.operations[0]!), intent: { ...host.operations[0]!.intent, workspace: 'other', requestId: 'other', projectId: 101 } })
    if (kind === 'grant') endpoint.grants[0]!.rootIdentity = '1:99:12345'
    if (kind === 'quota') endpoint.reservations[0]!.observation.quota.hardBytes = 8192
    if (kind === 'duplicate') endpoint.reservations.push(structuredClone(endpoint.reservations[0]!))
    expect(() => auditStorageRecoveryBindings(endpoint, host)).toThrow()
  })

it('retains the provisioning-before-host-intent gap without inventing an allocation or success', () => {
  const { endpoint, host } = fixture()
  const { observation: _, ...pending } = endpoint.reservations[0]!
  const captured = { ...endpoint, grants: [], reservations: [{ ...pending, phase: 'provisioning' }] }
  expect(auditStorageRecoveryBindings(captured, { ...host, operations: [] })).toMatchObject({ provisioning: 1, hostMissing: 1, restoreVerified: false })
  expect(auditStorageRecoveryBindings({ ...captured, reservations: [{ ...pending, phase: 'reserved' }] }, { ...host, operations: [] })).toMatchObject({ reserved: 1 })
  expect(() => auditStorageRecoveryBindings({ ...captured, reservations: [{ ...pending, phase: 'reserved' }] }, host)).toThrow()
})
