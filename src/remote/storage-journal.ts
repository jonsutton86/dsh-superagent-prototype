import { EndpointStorage, StorageIntent, StorageReservation } from './storage-model.ts'
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
      if (value.phase === 'provisioning') return false
      value.phase = 'provisioning'
      this.journal.db.prepare('UPDATE remote_storage SET value=? WHERE workspace=?').run(JSON.stringify(value), value.workspace)
      this.journal.audit({ action: 'storage-provisioning', requestId: value.requestId, workspace: value.workspace, projectId: value.projectId })
      return true
    })
  }
}
