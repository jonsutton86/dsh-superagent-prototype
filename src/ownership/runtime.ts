/** Persistent coordinator ownership binding under the Runtime's existing exclusive state lock. */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import s from '@deepseek-ai/schemastery'
import type { Store } from '../app/store.ts'
import { KV } from '../kv.ts'
import { inside } from '../remote/journal.ts'
import { CoordinatorOwnership, type CoordinatorOwnershipConfig } from './lease.ts'
import type { OwnershipAccess, OwnershipBinding } from './protocol.ts'

export const OwnershipConfig: s<Partial<CoordinatorOwnershipConfig>, CoordinatorOwnershipConfig> = s.object({ url: s.string().required(), authorityId: s.string().required(), coordinatorId: s.string().required(),
  credentialFile: s.string().pattern(/^\//).required(), timeoutMs: s.number().min(100).max(60_000).default(5000),
  leaseMs: s.number().min(1000).max(60_000).step(1).default(30_000), prepareTimeoutMs: s.number().min(1000).max(300_000).step(1).default(60_000) })

export function sameOwnership(a: OwnershipBinding | undefined, b: OwnershipBinding | undefined): boolean {
  return !a && !b || !!a && !!b && a.authorityId === b.authorityId && a.coordinatorId === b.coordinatorId
}
export function assertOwnership(expected: OwnershipBinding | undefined, actual: OwnershipBinding | undefined): void {
  if (!sameOwnership(expected, actual)) throw new Error('Execution resource must use the coordinator ownership authority and identity')
}
export function ownershipReady(ownership?: OwnershipAccess): boolean {
  try { ownership?.proof(); return true } catch { return false }
}
export function assertOwnershipCredential(config: CoordinatorOwnershipConfig | undefined, roots: string[]): void {
  if (!config) return
  const credential = realpathSync(config.credentialFile)
  if (roots.some(root => { let canonical = resolve(root); try { canonical = realpathSync(root) } catch { /* Check future roots too. */ }; return inside(canonical, credential) }))
    throw new Error('Coordinator ownership credential must be outside every execution workspace')
}
export function openRuntimeOwnership(store: Store, config: CoordinatorOwnershipConfig | undefined, roots: string[]): CoordinatorOwnership | undefined {
  const stored = store.get(KV.runtime.ownership)
  if (stored && !sameOwnership(stored, config)) throw new Error('Persisted coordinator ownership binding cannot be removed or replaced')
  if (!config) return
  assertOwnershipCredential(config, roots)
  const ownership = new CoordinatorOwnership(config)
  if (!stored) store.set(KV.runtime.ownership, { authorityId: config.authorityId, coordinatorId: config.coordinatorId })
  return ownership
}
