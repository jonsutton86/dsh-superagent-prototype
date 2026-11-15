import { EndpointStorage, StorageIntent, StorageReservation, StorageObservation } from './storage-model.ts'
import { RemoteJournal, timestamp } from './journal.ts'
import { RemoteError } from './protocol.ts'

/** Durable allocation boundary only. A reservation is never evidence of kernel enforcement. */
export class StorageReservations {
  readonly policy: EndpointStorage
  constructor(private readonly journal: RemoteJournal, configured: EndpointStorage) {
    this.policy = EndpointStorage.parse(configured)
    Object.freeze(this.policy.projectIds); Object.freeze(this.policy.pool); Object.freeze(this.policy.workspace); Object.freeze(this.policy)
    journal.atomic(() => {
      const saved = journal.db.prepare('SELECT value FROM endpoint_meta WHERE key=?').get('storage-policy')?.value
      if (saved && JSON.stringify(EndpointStorage.parse(JSON.parse(String(saved)))) !== JSON.stringify(this.policy))
        throw new RemoteError(409, 'storage_policy_changed', 'Persisted storage policy cannot be replaced')
      if (!saved && (journal.grants().length || journal.jobs().length || journal.operations().length))
        throw new RemoteError(409, 'storage_migration_required', 'Existing endpoint state needs explicit storage migration')
      journal.db.exec(`CREATE TABLE IF NOT EXISTS remote_storage (
        workspace TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, project_id INTEGER NOT NULL UNIQUE, value TEXT NOT NULL)`)
      if (!saved && journal.db.prepare('SELECT 1 FROM remote_storage LIMIT 1').get())
        throw new RemoteError(409, 'storage_policy_missing', 'Restore the original storage policy before using retained allocations')
      if (!saved) journal.db.prepare('INSERT INTO endpoint_meta VALUES (?,?)').run('storage-policy', JSON.stringify(this.policy))
      this.list() // Corrupt or out-of-policy rows must not become free capacity.
    })
  }
  list(): StorageReservation[] {
    const rows = this.journal.db.prepare('SELECT * FROM remote_storage ORDER BY project_id').all()
    const values = rows.map(row => {
      const value = StorageReservation.parse(JSON.parse(String(row.value)))
      if (value.endpointId !== this.journal.id || value.workspace !== row.workspace || value.requestId !== row.request_id
        || value.projectId !== row.project_id || value.projectId < this.policy.projectIds.first || value.projectId > this.policy.projectIds.last)
        throw new RemoteError(409, 'storage_record_invalid', 'Storage allocation does not match its persisted identity')
      if (value.observation) this.validateObservation(value, value.observation)
      return value
    })
    if (values.length > this.capacity()) throw new RemoteError(409, 'storage_record_invalid', 'Persisted storage allocations exceed policy')
    return values
  }
  private capacity(): number {
    return Math.min(Math.floor(this.policy.pool.bytes / this.policy.workspace.bytes),
      Math.floor(this.policy.pool.inodes / this.policy.workspace.inodes), this.policy.projectIds.last - this.policy.projectIds.first + 1)
  }
  reserve(input: StorageIntent): StorageReservation {
    const intent = StorageIntent.parse(input)
    return this.journal.atomic(() => {
      const allocations = this.list()
      const replay = allocations.find(item => item.requestId === intent.requestId)
      if (replay) {
        if (replay.workspace !== intent.workspace || replay.requestHash !== intent.requestHash)
          throw new RemoteError(409, 'request_conflict', 'Storage request ID already has another payload')
        return replay
      }
      if (allocations.some(item => item.workspace === intent.workspace))
        throw new RemoteError(409, 'storage_workspace_reserved', 'Workspace already has an original storage allocation')
      if (allocations.length >= this.capacity()) throw new RemoteError(409, 'storage_capacity', 'Storage allocation budget is exhausted')
      // IDs are not recycled. Revocation, process exit, and unlinks do not establish reclaimed storage.
      const projectId = allocations.length ? allocations[allocations.length - 1]!.projectId + 1 : this.policy.projectIds.first
      if (projectId > this.policy.projectIds.last) throw new RemoteError(409, 'storage_capacity', 'Project ID allocation range is exhausted')
      const value: StorageReservation = { ...intent, endpointId: this.journal.id, projectId, phase: 'reserved', createdAt: timestamp() }
      this.journal.db.prepare('INSERT INTO remote_storage VALUES (?,?,?,?)').run(value.workspace, value.requestId, value.projectId, JSON.stringify(value))
      this.journal.audit({ action: 'storage-reserved', requestId: value.requestId, workspace: value.workspace, projectId })
      return value
    })
  }
  /** Persist before the first host effect. False means inspect the original effect; never repeat it blindly. */
  beginProvisioning(input: StorageIntent): boolean {
    const intent = StorageIntent.parse(input)
    return this.journal.atomic(() => {
      const value = this.list().find(item => item.requestId === intent.requestId)
      if (!value || value.workspace !== intent.workspace || value.requestHash !== intent.requestHash)
        throw new RemoteError(409, 'storage_intent_missing', 'Original storage allocation is required')
      if (value.phase !== 'reserved') return false
      value.phase = 'provisioning'
      this.journal.db.prepare('UPDATE remote_storage SET value=? WHERE workspace=?').run(JSON.stringify(value), value.workspace)
      this.journal.audit({ action: 'storage-provisioning', requestId: value.requestId, workspace: value.workspace, projectId: value.projectId })
      return true
    })
  }
  private validateObservation(value: StorageReservation, observation: StorageObservation): void {
    const roots = storageRoots(this.policy, value)
    if (observation.filesystemUUID.toLowerCase() !== this.policy.filesystemUUID.toLowerCase() || observation.mountRoot !== this.policy.mountRoot
      || observation.projectId !== value.projectId || observation.quota.hardBytes !== this.policy.workspace.bytes
      || observation.quota.hardInodes !== this.policy.workspace.inodes || observation.directories.length !== roots.length
      || new Set(observation.directories.map(item => item.path)).size !== roots.length
      || observation.directories.some(item => !roots.includes(item.path) || item.projectId !== value.projectId)
      || new Set(observation.directories.map(item => item.device)).size !== 1)
      throw new RemoteError(409, 'storage_observation_mismatch', 'Host observation does not match original storage allocation')
  }
  /** Observation settles provisioning only; later dispatch still requires fresh host validation. */
  recordObservation(input: StorageIntent, observed: StorageObservation): StorageReservation {
    const intent = StorageIntent.parse(input), observation = StorageObservation.parse(observed)
    return this.journal.atomic(() => {
      const value = this.list().find(item => item.requestId === intent.requestId)
      if (!value || value.workspace !== intent.workspace || value.requestHash !== intent.requestHash || value.phase === 'reserved')
        throw new RemoteError(409, 'storage_intent_missing', 'Original provisioning intent is required')
      this.validateObservation(value, observation)
      if (value.observation && (value.observation.mountId !== observation.mountId || value.observation.directories.some(before => {
        const after = observation.directories.find(item => item.path === before.path)
        return !after || before.device !== after.device || before.inode !== after.inode
      }))) throw new RemoteError(409, 'storage_identity_changed', 'Previously observed storage roots changed identity')
      value.phase = 'provisioned'; value.observation = observation
      this.journal.db.prepare('UPDATE remote_storage SET value=? WHERE workspace=?').run(JSON.stringify(value), value.workspace)
      this.journal.audit({ action: 'storage-observed', requestId: value.requestId, workspace: value.workspace, projectId: value.projectId })
      return value
    })
  }

}


/** Separate host-protected parents: agents must not rename these roots or access other workspaces. */
export function storageRoots(policy: EndpointStorage, reservation: StorageReservation): string[] {
  const base = `${policy.mountRoot}/dsh-${reservation.endpointId}`
  return [`${base}/workspaces/${reservation.workspace}`, `${base}/verification/${reservation.workspace}`]
}
