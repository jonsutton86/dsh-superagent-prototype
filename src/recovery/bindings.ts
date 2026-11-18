/** Operational locations survive another backup without changing historical requests or grant identities. */
import type { DatabaseSync } from 'node:sqlite'
import type { RemoteWorldConfig } from '../remote/world.ts'
import { fingerprint } from '../remote/journal.ts'
import { KV } from '../kv.ts'
export interface RecoveryBindings {
  worlds: { binding: string; managed: boolean; config: RemoteWorldConfig }[]
  registrations: { original: string; url: string; credentialFile: string }[]
}
export function readRecoveryBindings(db: DatabaseSync): RecoveryBindings | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.deployment)
  return row ? JSON.parse(String(row.value)) as RecoveryBindings : undefined
}
export function resolveRecoveryRegistration<T extends { url: string; credentialFile: string }>(bindings: RecoveryBindings | undefined, record: T): T {
  const selected = bindings?.registrations.find(item => item.original === fingerprint(record))
  return selected ? { ...record, url: selected.url, credentialFile: selected.credentialFile } : record
}
export const resolveRecoveryWorld = (bindings: RecoveryBindings | undefined, binding: string, config: RemoteWorldConfig): RemoteWorldConfig =>
  bindings?.worlds.find(item => item.binding === binding)?.config ?? config
