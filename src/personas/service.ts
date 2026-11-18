import { createHash, randomUUID } from 'node:crypto'
import type { Store } from '../app/store.ts'
import { WorkspaceError } from '../workspace/model.ts'
import { ArchivePersona, CreatePersona, PersonaQuery, PersonaRef, SavePersona, type PersonaDefinition, type PersonaList,
  type PersonaRecord, type PersonaSnapshot, type PersonaSummary, type PersonaVersion } from './model.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stamp = () => new Date().toISOString()
const summary = ({ definition, digest: _, ...record }: PersonaRecord): PersonaSummary => ({ ...record, name: definition.name,
  description: definition.description, model: definition.model, capabilities: definition.capabilities })

/** Versioned operator-authored personas with transactional request receipts and explicit archive semantics. */
export class Personas {
  constructor(private readonly store: Store, private readonly validateModel: (model: NonNullable<PersonaDefinition['model']>) => Promise<void> = async () => {}) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS persona (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS persona_version (id TEXT, version INTEGER, value TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS persona_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS persona_event (id INTEGER PRIMARY KEY, persona TEXT NOT NULL, value TEXT NOT NULL);`)
  }
  get(id: string): PersonaRecord {
    const row = this.store.db.prepare('SELECT value FROM persona WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Persona not found')
    return JSON.parse(String(row.value)) as PersonaRecord
  }
  version(id: string, version: number): PersonaVersion {
    const row = this.store.db.prepare('SELECT value FROM persona_version WHERE id=? AND version=?').get(id, version)
    if (!row) throw new WorkspaceError(404, 'Persona version not found')
    return JSON.parse(String(row.value)) as PersonaVersion
  }
  list(input: unknown = {}): PersonaList {
    const { offset, q, active } = PersonaQuery.parse(input)
    const rows = this.store.db.prepare(`SELECT value FROM persona WHERE instr(lower(value ->> '$.definition.name'),lower(?))>0
      AND (? IS NULL OR (value ->> '$.archived')=?) ORDER BY rowid DESC LIMIT 31 OFFSET ?`).all(q, active ?? null, active === 'true' ? 0 : 1, offset)
    return { items: rows.slice(0, 30).map(row => summary(JSON.parse(String(row.value)) as PersonaRecord)), nextOffset: rows.length > 30 ? offset + 30 : null }
  }
  snapshot(input: unknown): PersonaSnapshot {
    const ref = PersonaRef.parse(input), record = this.get(ref.id)
    if (record.archived) throw new WorkspaceError(409, 'This persona is archived; select an available persona before starting a new run')
    return this.version(ref.id, ref.version)
  }
  verify(snapshot: PersonaSnapshot): void {
    const version = this.version(snapshot.id, snapshot.version)
    if (digest(snapshot) !== digest(version)) throw new WorkspaceError(409, 'The execution persona differs from its immutable version')
  }
  private replay(id: string, fingerprint: string): PersonaRecord | undefined {
    const row = this.store.db.prepare('SELECT fingerprint,value FROM persona_command WHERE id=?').get(id)
    if (!row) return
    if (row.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This persona request ID already has another payload')
    return JSON.parse(String(row.value)) as PersonaRecord
  }
  private save(record: PersonaRecord, requestId: string, fingerprint: string, reason: string, newVersion: boolean): PersonaRecord {
    this.store.db.prepare('INSERT INTO persona VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record))
    if (newVersion) {
      const { revision: _, archived: __, updatedAt: ___, ...version } = record
      this.store.db.prepare('INSERT INTO persona_version VALUES (?,?,?)').run(record.id, record.version, JSON.stringify(version))
    }
    this.store.db.prepare('INSERT INTO persona_command VALUES (?,?,?)').run(requestId, fingerprint, JSON.stringify(record))
    this.store.db.prepare('INSERT INTO persona_event(persona,value) VALUES (?,?)').run(record.id, JSON.stringify({ at: record.updatedAt, revision: record.revision, version: record.version, archived: record.archived, reason }))
    return record
  }
  async create(input: unknown): Promise<PersonaRecord> {
    const request = CreatePersona.parse(input), fingerprint = digest({ op: 'create', ...request }), replay = this.replay(request.requestId, fingerprint)
    if (replay) return replay
    if (request.definition.model) await this.validateModel(request.definition.model)
    return this.store.atomic(() => {
      const replay = this.replay(request.requestId, fingerprint); if (replay) return replay
      const at = stamp(), id = randomUUID(), version = 1, definition = request.definition
      return this.save({ id, version, definition, digest: digest({ id, version, definition }), revision: 1, archived: false, createdAt: at, updatedAt: at },
        request.requestId, fingerprint, 'Created persona', true)
    })
  }
  async update(id: string, input: unknown): Promise<PersonaRecord> {
    const request = SavePersona.parse(input), fingerprint = digest({ op: 'update', id, ...request }), replay = this.replay(request.requestId, fingerprint)
    if (replay) return replay
    if (request.definition.model) await this.validateModel(request.definition.model)
    return this.store.atomic(() => {
      const replay = this.replay(request.requestId, fingerprint); if (replay) return replay
      const previous = this.get(id)
      if (previous.revision !== request.revision) throw new WorkspaceError(409, 'Persona changed; refresh before saving')
      const at = stamp(), version = previous.version + 1, definition = request.definition
      return this.save({ ...previous, version, definition, digest: digest({ id, version, definition }), revision: previous.revision + 1, createdAt: at, updatedAt: at },
        request.requestId, fingerprint, 'Saved persona version', true)
    })
  }
  archive(id: string, input: unknown): PersonaRecord {
    const request = ArchivePersona.parse(input), fingerprint = digest({ op: 'archive', id, ...request })
    return this.store.atomic(() => {
      const replay = this.replay(request.requestId, fingerprint); if (replay) return replay
      const previous = this.get(id)
      if (previous.revision !== request.revision) throw new WorkspaceError(409, 'Persona changed; refresh before archiving')
      return this.save({ ...previous, archived: request.archived, revision: previous.revision + 1, updatedAt: stamp() }, request.requestId, fingerprint, request.reason, false)
    })
  }
}
