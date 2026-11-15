/** Cross-check separately captured records. Never imports state or treats historical quotas as live proof. */
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import { StateReader } from './reader.ts'
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


/** Caller supplies authenticated, frozen databases; this does not open paths or initialize services. */
export async function readEndpointStorageSnapshot(db: DatabaseSync, signal: AbortSignal) {
  signal.throwIfAborted()
  const r = new StateReader(db, signal, 'endpoint_storage')
  for (const table of ['endpoint_meta', 'remote_storage', 'remote_grant'])
    if (!r.tables.has(table)) r.fail('reference', table)
  let endpointId: string | undefined, policy: z.infer<typeof EndpointStorage> | undefined
  for (const row of r.rows('endpoint_meta')) {
    if (row.key === 'id') { if (endpointId) r.fail('conflict', 'endpoint_id'); endpointId = r.parse(z.string().uuid(), row.value, 'endpoint_id') }
    if (row.key === 'storage-policy') { if (policy) r.fail('conflict', 'storage_policy'); policy = r.json(row.value, EndpointStorage, 'storage_policy') }
    await r.step()
  }
  if (!endpointId || !policy) r.fail('reference', 'storage_configuration')
  const reservations: z.infer<typeof StorageReservation>[] = [], grants: z.infer<typeof GrantMetadata>[] = []
  for (const row of r.rows('remote_storage')) {
    const value = r.json(row.value, StorageReservation, 'reservation')
    r.same([row.workspace, row.request_id, row.project_id], [value.workspace, value.requestId, value.projectId], 'reservation_keys')
    r.same(value.endpointId, endpointId, 'reservation_endpoint'); reservations.push(value)
    if (reservations.length > 20000) r.fail('limit', 'reservations')
    await r.step()
  }
  for (const row of r.rows('remote_grant')) {
    const value = r.json(row.value, GrantMetadata, 'grant')
    r.same(row.id, value.id, 'grant_key'); grants.push(value)
    if (grants.length > 20000) r.fail('limit', 'grants')
    await r.step()
  }
  return { snapshot: endpointSnapshot.parse({ endpointId, policy, reservations, grants }), records: r.records, digest: r.digest() }
}

/** Audit the whole shared registry before selecting an endpoint view. All records contribute to its digest. */
export async function readHostStorageSnapshot(db: DatabaseSync, endpointId: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const r = new StateReader(db, signal, 'host_storage')
  r.parse(z.string().uuid(), endpointId, 'endpoint_id')
  const schema = { endpoints: ['id', 'filesystem', 'first', 'last', 'config'], namespaces: ['endpoint', 'identities'],
    operations: ['endpoint', 'request', 'workspace', 'filesystem', 'project', 'intent', 'roots'], repairs: ['endpoint', 'id', 'request', 'intent', 'phase'] }
  r.same([...r.tables].sort(), Object.keys(schema).sort(), 'registry_tables')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') LIMIT 1").get()) r.fail('shape', 'registry_schema')
  for (const [table, columns] of Object.entries(schema))
    r.same(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name), columns, 'registry_columns')
  const configSchema = z.object({ endpointId: z.string().uuid(), uid: z.number().int().positive().max(2 ** 31 - 1),
    gid: z.number().int().positive().max(2 ** 31 - 1), policy: EndpointStorage }).strict()
  const policies = new Map<string, z.infer<typeof EndpointStorage>>(), ranges = new Map<string, { first: number; last: number }[]>()
  for (const row of r.rows('endpoints')) {
    const config = r.json(row.config, configSchema, 'host_configuration'), policy = config.policy
    if (config.endpointId !== config.endpointId.toLowerCase() || policy.filesystemUUID !== policy.filesystemUUID.toLowerCase()
      || !/^\/[A-Za-z0-9_/-]+$/.test(policy.mountRoot)) r.fail('shape', 'host_configuration')
    if (policies.has(config.endpointId)) r.fail('conflict', 'endpoint_id')
    r.same([row.id, row.filesystem, row.first, row.last], [config.endpointId, policy.filesystemUUID, policy.projectIds.first, policy.projectIds.last], 'host_configuration_keys')
    policies.set(config.endpointId, policy)
    const intervals = ranges.get(policy.filesystemUUID) ?? []; intervals.push(policy.projectIds); ranges.set(policy.filesystemUUID, intervals)
    if (policies.size > 20000) r.fail('limit', 'endpoints')
    await r.step()
  }
  for (const intervals of ranges.values()) {
    intervals.sort((a, b) => a.first - b.first)
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i - 1]!.last >= intervals[i]!.first) r.fail('conflict', 'project_ranges')
      await r.step()
    }
  }
  const selectedPolicy = r.needed(policies, endpointId, 'endpoint_id')
  const namespaces = new Map<string, z.infer<typeof identity>[] | null>()
  for (const row of r.rows('namespaces')) {
    const owner = r.parse(z.string().uuid(), row.endpoint, 'namespace_endpoint')
    r.needed(policies, owner, 'namespace_endpoint')
    if (namespaces.has(owner)) r.fail('conflict', 'namespace_endpoint')
    const roots = r.json(row.identities, z.tuple([identity.nullable(), identity.nullable(), identity.nullable()]), 'namespace_roots')
    namespaces.set(owner, roots.every(item => item !== null) ? roots : null)
    await r.step()
  }
  const allocations = new Map<string, z.infer<typeof hostOperation>>(), workspaces = new Set<string>(), projects = new Set<string>(), counts = new Map<string, number>()
  const operations: z.infer<typeof hostOperation>[] = []
  let incompleteRoots = 0
  for (const row of r.rows('operations')) {
    const intent = r.json(row.intent, hostOperation.shape.intent, 'host_intent'), roots = r.json(row.roots, hostOperation.shape.roots, 'host_roots')
    const policy = r.needed(policies, intent.endpointId, 'operation_endpoint'), key = `${intent.endpointId}:${intent.requestId}`
    r.same([row.endpoint, row.request, row.workspace, row.filesystem, row.project],
      [intent.endpointId, intent.requestId, intent.workspace, policy.filesystemUUID, intent.projectId], 'host_intent_keys')
    const workspaceKey = `${intent.endpointId}:${intent.workspace}`, projectKey = `${policy.filesystemUUID}:${intent.projectId}`
    if (!namespaces.get(intent.endpointId) || allocations.has(key) || workspaces.has(workspaceKey) || projects.has(projectKey)
      || intent.projectId < policy.projectIds.first || intent.projectId > policy.projectIds.last) r.fail('conflict', 'allocation_identity')
    allocations.set(key, { intent, roots }); workspaces.add(workspaceKey); projects.add(projectKey)
    const count = (counts.get(intent.endpointId) ?? 0) + 1; counts.set(intent.endpointId, count)
    if (count * policy.workspace.bytes > policy.pool.bytes || count * policy.workspace.inodes > policy.pool.inodes) r.fail('conflict', 'allocation_capacity')
    if (allocations.size > 20000) r.fail('limit', 'operations')
    if (roots.some(item => item === null)) incompleteRoots++
    if (intent.endpointId === endpointId) operations.push({ intent, roots })
    await r.step()
  }
  const repairIntent = z.object({ request: hostOperation.shape.intent, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    finishSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
  const repairs = new Set<string>(), repairedRequests = new Set<string>(); let unresolvedRepairs = 0
  for (const row of r.rows('repairs')) {
    const owner = r.parse(z.string().uuid(), row.endpoint, 'repair_endpoint'), id = r.parse(StorageIntent.shape.requestId, row.id, 'repair_id')
    const request = r.parse(StorageIntent.shape.requestId, row.request, 'repair_request'), phase = r.parse(z.enum(['started', 'finishing', 'complete']), row.phase, 'repair_phase')
    const saved = r.json(row.intent, repairIntent, 'repair_intent'), key = `${owner}:${request}`, repairKey = `${owner}:${id}`
    const original = r.needed(allocations, key, 'repair_allocation')
    r.same(saved.request, original.intent, 'repair_original_request')
    if (repairs.has(repairKey) || repairedRequests.has(key) || phase === 'started' && saved.finishSnapshotHash !== undefined
      || phase === 'finishing' && saved.finishSnapshotHash === undefined || phase !== 'started' && original.roots.some(item => item === null))
      r.fail('conflict', 'repair_state')
    repairs.add(repairKey); repairedRequests.add(key)
    if (phase !== 'complete') unresolvedRepairs++
    await r.step()
  }
  return { snapshot: hostSnapshot.parse({ endpointId, policy: selectedPolicy, operations }), records: r.records, digest: r.digest(),
    audit: { recordBindingsVerified: true as const, endpoints: policies.size, allocations: allocations.size, repairs: repairs.size,
      incompleteRoots, incompleteNamespaces: [...policies.keys()].filter(id => !namespaces.get(id)).length, unresolvedRepairs, liveFilesystemVerified: false as const, restoreVerified: false as const } }
}
