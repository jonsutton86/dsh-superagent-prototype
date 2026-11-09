/** Generate the actual Harness launch patch from authenticated installation bindings, without copying provider secrets. */
import type { Installation } from './installation.ts'
import { remoteProfile } from '../environments/remote-profile.ts'
import type { WorldRecord } from '../remote/world-journal.ts'
import type { CoordinatorOwnershipConfig } from '../ownership/lease.ts'
import type { PublicationConnection } from '../publication/client.ts'

export interface InstallationLaunch { port?: number; sessionRoot?: string }
interface Patch { id?: string; disabled?: boolean; config?: Record<string, unknown>; insert?: Patch[]; name?: string }

export function installationProfile(value: Installation, keyFile: string) {
  return { executionMode: 'local' as const, stateDir: value.stateDir, ownership: value.ownership as CoordinatorOwnershipConfig,
    ...(value.publication ? { publication: value.publication as PublicationConnection } : {}), restore: { directory: value.root, keyFile } }
}

/** Other Session backends remain selectable in the base profile; startup verifies their real history through Harness. */
export function installationPatch(value: Installation, keyFile: string, launch: InstallationLaunch = {}): Patch[] {
  const dedicated = value.worlds.find(item => !item.managed)
  const patches: Patch[] = dedicated ? remoteProfile({ ...dedicated.config, directory: value.root, grant: (dedicated.original as WorldRecord).grant,
    port: launch.port ?? 3000, ownership: value.ownership, publication: value.publication }) as Patch[] : [{ id: 'dsh-superagent' }, { id: 'session-title-llm', disabled: true }]
  for (const patch of patches) {
    if (patch.id === 'dsh-superagent') { patch.disabled = false; patch.config = installationProfile(value, keyFile) }
    for (const child of patch.insert ?? []) if (child.id === 'operator-remote-world')
      child.config = { ...dedicated!.config, ownership: { authorityId: value.ownership.authorityId, coordinatorId: value.ownership.coordinatorId } }
  }
  const result = patches.filter(patch => patch.id !== 'webserver')
  if (launch.port !== undefined) result.unshift({ id: 'webserver', config: { host: '127.0.0.1', port: launch.port } })
  if (launch.sessionRoot) result.push({ id: 'session-persistence-jsonl', disabled: false, config: { root: launch.sessionRoot, compression: 'none' } })
  return result
}
