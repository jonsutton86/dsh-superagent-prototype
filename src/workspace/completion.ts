import type { Store } from '../app/store.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { WorkspaceError, type MissionCommandInput, type MissionView } from './model.ts'

export interface CompletionAttempt {
  id: string; missionId: string; command: MissionCommandInput; target: string; createdAt: string; updatedAt: string
  status: 'preparing' | 'held' | 'completed'; problem?: string; reviews: { actionId: string; id: string }[]
}
/** Keep every whole-mission preparation and its original capture-review IDs recoverable across response loss and restart. */
export class MissionCompletions {
  private readonly pending = new Map<string, Promise<MissionView>>()
  constructor(private readonly store: Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS mission_completion (id TEXT PRIMARY KEY, mission TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL)')
  }
  get(id: string): CompletionAttempt {
    const row = this.store.db.prepare('SELECT value FROM mission_completion WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Mission completion attempt not found')
    return JSON.parse(String(row.value))
  }
  list(id: string) {
    return { items: this.store.db.prepare('SELECT value FROM mission_completion WHERE mission=? ORDER BY rowid DESC LIMIT 100').all(id)
      .map(row => JSON.parse(String(row.value)) as CompletionAttempt) }
  }
  private save(value: CompletionAttempt): void {
    value.updatedAt = timestamp()
    this.store.db.prepare('UPDATE mission_completion SET value=? WHERE id=?').run(JSON.stringify(value), value.id)
  }
  complete(id: string): void { const attempt = this.get(id); attempt.status = 'completed'; delete attempt.problem; this.save(attempt) }
  run(missionId: string, command: MissionCommandInput, target: string, actions: readonly string[], operation: (attempt: CompletionAttempt) => Promise<MissionView>): Promise<MissionView> {
    const hash = fingerprint({ missionId, command, target })
    const attempt = this.store.atomic(() => {
      const prior = this.store.db.prepare('SELECT fingerprint FROM mission_completion WHERE id=?').get(command.requestId)
      if (prior && prior.fingerprint !== hash) throw new WorkspaceError(409, 'Completion request ID belongs to another mission review')
      if (prior) return this.get(command.requestId)
      const unresolved = this.store.db.prepare(`SELECT id FROM mission_completion WHERE mission=? AND json_extract(value,'$.command.revision')=?
        AND json_extract(value,'$.status')!='completed' LIMIT 1`).get(missionId, command.revision)
      if (unresolved) throw new WorkspaceError(409, `Resume original mission completion ${unresolved.id} before starting a replacement`)
      const at = timestamp(), value: CompletionAttempt = { id: command.requestId, missionId, command, target, createdAt: at, updatedAt: at,
        status: 'preparing', reviews: actions.map(actionId => ({ actionId, id: `closure-${fingerprint({ request: command.requestId, mission: missionId, action: actionId })}` })) }
      this.store.db.prepare('INSERT INTO mission_completion VALUES (?,?,?,?)').run(value.id, missionId, hash, JSON.stringify(value))
      const size = this.store.db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM mission_completion').get()!
      if (Number(size.n) > 10000 || Number(size.bytes) > 256 * 1024 * 1024) throw new WorkspaceError(409, 'Mission completion journal capacity reached')
      return value
    })
    const prior = this.pending.get(attempt.id); if (prior) return prior
    attempt.status = 'preparing'; delete attempt.problem; this.save(attempt)
    const pending = operation(attempt).catch(error => {
      const current = this.get(attempt.id)
      if (current.status !== 'completed') { current.status = 'held'; current.problem = String(error).slice(0, 4000); this.save(current) }
      throw error
    }).finally(() => this.pending.delete(attempt.id))
    this.pending.set(attempt.id, pending); return pending
  }
  async stop(): Promise<void> { await Promise.allSettled([...this.pending.values()]) }
}
