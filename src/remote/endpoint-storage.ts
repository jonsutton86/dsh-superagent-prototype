import { EndpointStorage } from './storage-model.ts'
import { StorageReservations, storageRoots } from './storage-journal.ts'
import { StorageProvisioning, type StorageHost } from './storage-provisioning.ts'
import { fingerprint, inside, type RemoteJournal } from './journal.ts'
import { RemoteError } from './protocol.ts'

export const STARTUP_STORAGE_WORKSPACE = '__dsh_startup'
export interface EndpointStorageConfig { endpointId: string; policy: EndpointStorage; host: StorageHost }

/** Original grants and startup proofs share the same host-enforced allocation/recovery path. */
export class EndpointStorageManager {
  readonly reservations: StorageReservations
  private readonly provisioning: StorageProvisioning
  constructor(private readonly journal: RemoteJournal, private readonly config: EndpointStorageConfig, root: string) {
    if (journal.id !== config.endpointId || root !== `${config.policy.mountRoot}/dsh-${journal.id}/workspaces`)
      throw new Error('Endpoint storage identity and protected workspace parent must match the host configuration')
    this.reservations = new StorageReservations(journal, config.policy)
    this.provisioning = new StorageProvisioning(this.reservations, config.host)
  }
  async startup(signal: AbortSignal): Promise<string> {
    return this.prepare(STARTUP_STORAGE_WORKSPACE, 'storage-startup', fingerprint({ endpointId: this.journal.id,
      purpose: 'endpoint-startup', policy: this.reservations.policy }), signal)
  }
  async prepare(workspace: string, requestId: string, requestHash: string, signal: AbortSignal): Promise<string> {
    const result = await this.provisioning.prepare({ workspace, requestId, requestHash }, signal)
    return storageRoots(this.reservations.policy, result)[0]!
  }
  async verify(workspace: string, root: string, signal: AbortSignal, startupChild = false): Promise<void> {
    const original = this.reservations.list().find(item => item.workspace === workspace)
    if (!original || original.phase !== 'provisioned') throw new RemoteError(503, 'storage_unverified', 'Original provisioned storage allocation is required')
    const roots = storageRoots(this.reservations.policy, original)
    if (root !== roots[0] && !(startupChild && workspace === STARTUP_STORAGE_WORKSPACE && inside(roots[0]!, root)))
      throw new RemoteError(403, 'storage_root_mismatch', 'Execution root differs from its assigned storage allocation')
    const observed = await this.config.host.observe(this.reservations.policy, original, roots, signal)
    signal.throwIfAborted()
    this.reservations.recordObservation({ requestId: original.requestId, requestHash: original.requestHash, workspace: original.workspace }, observed)
  }
  verificationRoot(workspace: string): string {
    const original = this.reservations.list().find(item => item.workspace === workspace)
    if (!original || original.phase !== 'provisioned') throw new RemoteError(503, 'storage_unverified', 'Original verification storage allocation is required')
    return storageRoots(this.reservations.policy, original)[1]!
  }
}
