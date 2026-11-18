/** Original execution credentials are checked privately; recovery observes bindings without renewing or dispatching work. */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { credentialDigest, privateCredential } from '../environments/endpoint-files.ts'
import { RemoteClient } from '../remote/client.ts'
import { RemoteError } from '../remote/protocol.ts'
import { WorldConfigurationObservation } from '../remote/recovery.ts'
import { fingerprint, inside } from '../remote/journal.ts'
import { worldBinding, type WorldRecord } from '../remote/world-journal.ts'
import type { InventoryPage } from '../ownership/inventory.ts'
import { readRecoveryBindings } from './bindings.ts'

export const RecoveryWorldConnection = z.object({ binding: z.string().regex(/^[a-f0-9]{64}$/), endpointId: z.string().uuid(),
  url: z.string().min(1).max(2048), credentialFile: z.string().min(1).max(4096).refine(value => value.startsWith('/')),
  timeoutMs: z.number().int().min(100).max(60_000).optional() }).strict()
export type RecoveryWorldConnection = z.infer<typeof RecoveryWorldConnection>
export interface WorldConfigurationCheck { original: WorldRecord; binding: string; connection?: RecoveryWorldConnection; pin?: string }
interface ManagedConfiguration { id: string; credentialPin: string; grant: WorldRecord['grant']; config: RecoveryWorldConnection;
  enabled: boolean; revoke?: { requestId: string; reason: string } }
/** A missing or unusable original execution credential is a held recovery finding, not permission to replace it. */
export class ConfigurationMismatch extends Error {
  constructor(readonly code: 'configuration_missing' | 'configuration_mismatch' | 'configuration_unavailable') { super(code) }
}
export function worldConfigurations(inputs: readonly RecoveryWorldConnection[], db: DatabaseSync, worlds: readonly WorldRecord[]): WorldConfigurationCheck[] {
  const installed = readRecoveryBindings(db)
  const selected = new Map<string, RecoveryWorldConnection>(), originals = new Map(worlds.map(world => [worldBinding(world.endpointId, world.grant), world]))
  if (inputs.length > 20000) throw new Error('Recovery world connection catalog exceeds its bound')
  for (const input of inputs) {
    const value = RecoveryWorldConnection.parse(input)
    if (selected.has(value.binding) || !originals.has(value.binding)) throw new Error('Recovery connections must identify unique original worlds')
    selected.set(value.binding, value)
  }
  const managed = new Map<string, ManagedConfiguration>()
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_world'").get())
    for (const row of db.prepare('SELECT value FROM managed_world').iterate()) {
      const value = JSON.parse(String(row.value)) as ManagedConfiguration
      const original = originals.get(value.id)
      if (!original || value.id !== worldBinding(value.config.endpointId, value.grant)
        || value.id !== worldBinding(original.endpointId, original.grant) || !/^[a-f0-9]{64}$/.test(value.credentialPin)
        || value.enabled !== !original.revocation || fingerprint(value.revoke ?? null) !== fingerprint(original.revocation
          ? { requestId: original.revocation.requestId, reason: original.revocation.reason } : null))
        throw new Error('Managed recovery world configuration differs from its original journal')
      managed.set(value.id, value)
    }
  return [...originals].filter(([, world]) => !world.revocation).map(([binding, original]) => {
    const record = managed.get(binding), config = installed?.worlds.find(item => item.binding === binding)?.config ?? record?.config
    return { original, binding, connection: selected.get(binding) ?? (config ? RecoveryWorldConnection.parse({ binding,
      endpointId: config.endpointId, url: config.url, credentialFile: config.credentialFile, ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}) }) : undefined),
    ...(record ? { pin: record.credentialPin } : {}) }
  })
}

export async function verifyWorldConfiguration(check: WorldConfigurationCheck, resource: { identity: InventoryPage['identity']; revision: string } | undefined,
  workspaces: readonly string[], signal: AbortSignal): Promise<void> {
  const { original, connection } = check
  if (!connection || !resource) throw new ConfigurationMismatch('configuration_missing')
  if (connection.endpointId !== original.endpointId || resource.identity.id !== original.endpointId || resource.identity.kind !== 'endpoint')
    throw new ConfigurationMismatch('configuration_mismatch')
  let pin: string
  const credential = () => {
    try {
      const path = realpathSync(connection.credentialFile)
      if ([...workspaces, original.grant.root].some(root => {
        let canonical = resolve(root); try { canonical = realpathSync(root) } catch { /* Reject future roots too. */ }
        return inside(canonical, path)
      })) throw new Error('Execution credential is inside a workspace')
      return privateCredential(connection.credentialFile, pin ?? check.pin)
    } catch { throw new ConfigurationMismatch('configuration_unavailable') }
  }
  pin = credentialDigest(credential())
  const client = new RemoteClient(connection, undefined, undefined, credential)
  try {
    client.bindGrant(original.grant)
    const observed = WorldConfigurationObservation.parse(await client.call({ op: 'recovery.world', revision: resource.revision }, signal))
    if (observed.revision !== resource.revision || fingerprint(observed.identity) !== fingerprint(resource.identity)
      || observed.endpoint.id !== original.endpointId || observed.endpoint.confinement !== 'linux-bubblewrap'
      || !observed.endpoint.capabilities.effectOwnership || original.grant.credentials?.length && !observed.endpoint.capabilities.credentialBindings
      || fingerprint(observed.endpoint.ownership) !== fingerprint({ authorityId: resource.identity.authorityId,
        coordinatorId: resource.identity.coordinatorId, resourceId: resource.identity.resourceId })
      || worldBinding(original.endpointId, observed.grant) !== check.binding || !observed.grant.enabled || observed.grant.leaseUntil <= Date.now())
      throw new ConfigurationMismatch('configuration_mismatch')
    credential() // Recheck private mode, ownership and pinned contents after the asynchronous endpoint observation.
  } catch (error) {
    if (error instanceof RemoteError && ['unauthorized', 'grant_changed', 'grant_unavailable', 'grant_required', 'credential_unavailable', 'credential_file', 'credential_integrity', 'root_changed', 'recovery_busy'].includes(error.code))
      throw new ConfigurationMismatch('configuration_unavailable')
    throw error
  }
}
