/** Cross-check separately captured records. Never imports state or treats historical quotas as live proof. */
import { z } from 'zod'
import { EndpointStorage, StorageIntent, StorageReservation } from '../remote/storage-model.ts'
import { storageRoots } from '../remote/storage-journal.ts'
import { GrantMetadata } from '../environments/endpoint-model.ts'

const identity = z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
const hostOperation = z.object({ intent: StorageIntent.extend({ endpointId: z.string().uuid(),
  projectId: z.number().int().positive().max(2 ** 32 - 1) }).strict(), roots: z.tuple([identity.nullable(), identity.nullable()]) }).strict()
const hostSnapshot = z.object({ endpointId: z.string().uuid(), policy: EndpointStorage,
  operations: z.array(hostOperation).max(20000) }).strict()
const endpointSnapshot = z.object({ endpointId: z.string().uuid(), policy: EndpointStorage,
  reservations: z.array(StorageReservation).max(20000), grants: z.array(GrantMetadata).max(20000) }).strict()
function requireBinding(condition: unknown): asserts condition {
  if (!condition) throw new Error('Storage recovery records do not share their original allocation binding')
}
function unique<T>(values: T[], keys: ((value: T) => string | number)[]) {
  for (const key of keys) requireBinding(new Set(values.map(key)).size === values.length)
}

/** Inputs must still be authenticated as recovery-image members by the caller. No restore authorization. */
export function auditStorageRecoveryBindings(endpointInput: unknown, hostInput: unknown) {
  const endpoint = endpointSnapshot.parse(endpointInput), host = hostSnapshot.parse(hostInput)
  requireBinding(endpoint.endpointId === host.endpointId && JSON.stringify(endpoint.policy) === JSON.stringify(host.policy))
  const policy = endpoint.policy, capacity = Math.min(Math.floor(policy.pool.bytes / policy.workspace.bytes),
    Math.floor(policy.pool.inodes / policy.workspace.inodes), policy.projectIds.last - policy.projectIds.first + 1)
  requireBinding(endpoint.reservations.length <= capacity)
  unique(endpoint.reservations, [value => value.requestId, value => value.workspace, value => value.projectId])
  unique(host.operations, [value => value.intent.requestId, value => value.intent.workspace, value => value.intent.projectId])
  unique(endpoint.grants, [value => value.id, value => value.workspace])
  const allocations = new Map(endpoint.reservations.map(value => [value.workspace, value]))
  const operations = new Map(host.operations.map(value => [value.intent.workspace, value]))
  let reserved = 0, provisioning = 0, provisioned = 0, hostMissing = 0
  for (const value of endpoint.reservations) {
    requireBinding(value.endpointId === endpoint.endpointId && value.projectId >= policy.projectIds.first && value.projectId <= policy.projectIds.last)
    const operation = operations.get(value.workspace)
    if (value.phase === 'reserved') { requireBinding(!operation); reserved++; continue }
    if (value.phase === 'provisioning') provisioning++; else provisioned++
    if (!operation) { requireBinding(value.phase === 'provisioning'); hostMissing++; continue }
    const intent = operation.intent
    requireBinding(intent.endpointId === value.endpointId && intent.requestId === value.requestId && intent.requestHash === value.requestHash
      && intent.projectId === value.projectId)
    if (value.phase === 'provisioned') {
      const observed = value.observation!, roots = storageRoots(policy, value)
      requireBinding(observed.filesystemUUID === policy.filesystemUUID && observed.mountRoot === policy.mountRoot && observed.projectId === value.projectId
        && observed.quota.hardBytes === policy.workspace.bytes && observed.quota.hardInodes === policy.workspace.inodes
        && observed.directories.length === 2 && new Set(observed.directories.map(item => item.path)).size === 2
        && new Set(observed.directories.map(item => item.device)).size === 1)
      for (const [index, path] of roots.entries()) {
        const directory = observed.directories.find(item => item.path === path), original = operation.roots[index]
        requireBinding(directory && original && directory.projectId === value.projectId && directory.device === original.device && directory.inode === original.inode)
      }
    }
  }
  // A newer host snapshot must not silently add allocations omitted from the endpoint snapshot.
  for (const operation of host.operations) requireBinding(allocations.has(operation.intent.workspace))
  for (const grant of endpoint.grants) {
    const allocation = allocations.get(grant.workspace)
    requireBinding(allocation?.phase === 'provisioned')
    const path = storageRoots(policy, allocation)[0]!, directory = allocation.observation!.directories.find(item => item.path === path)!
    requireBinding(grant.root === path && /^\d+:\d+:\d+$/.test(grant.rootIdentity)
      && grant.rootIdentity.startsWith(`${directory.device}:${directory.inode}:`))
  }
  return { allocations: endpoint.reservations.length, reserved, provisioning, provisioned, hostMissing,
    recordBindingsVerified: true as const, liveFilesystemVerified: false as const, restoreVerified: false as const }
}
