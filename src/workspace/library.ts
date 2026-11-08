import { createHash, randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { types } from 'node:util'
import { key, latestAssignment, liveTicket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { WorkspaceError, type Mission } from './model.ts'
import { ArchiveRecord, CreateRecord, LibraryId, LibraryPage, LibraryQuery, LIBRARY_MAX_BYTES, PublishRecord,
  type LibraryActor, type LibraryContent, type LibraryEntry, type LibraryList, type LibraryRead, type LibraryRecord } from './library-model.ts'

const OPERATOR: LibraryActor = { role: 'operator' }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const isText = (mime: string) => mime.startsWith('text/') || mime === 'application/json'
type Row = { value: string; revision: number; archived: number }

/** Transactional content-addressed library with host-derived worker scopes and bounded, provenance-aware recall. */
export class Library {
  constructor(private readonly store: Store, private readonly now = () => new Date().toISOString()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_blob (hash TEXT PRIMARY KEY, data BLOB NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_library (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
        expires_at TEXT, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_library_scope ON workspace_library(scope,kind,archived);
      CREATE INDEX IF NOT EXISTS workspace_library_ticket ON workspace_library(json_extract(value,'$.provenance.ticketId'));
      CREATE TABLE IF NOT EXISTS workspace_library_edge (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL,
        PRIMARY KEY(source,target,relation));
      CREATE INDEX IF NOT EXISTS workspace_library_target ON workspace_library_edge(target,relation);
      CREATE VIRTUAL TABLE IF NOT EXISTS workspace_library_search USING fts5(title,summary,body,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS workspace_library_command (actor TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        record TEXT NOT NULL, PRIMARY KEY(actor,id));`)
  }
  private scope(actor: LibraryActor, writing = false): string[] | undefined {
    if (actor.role === 'operator') return undefined
    if (actor.role === 'router') return ['workspace']
    const ticket = this.store.tickets.get(actor.ticketId)
    if (!ticket || (writing && !liveTicket(ticket))) throw new WorkspaceError(409, 'An active ticket is required to publish results')
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    if (writing && trigger && this.store.settings().sources[trigger.source]?.enabled === false)
      throw new WorkspaceError(409, 'The disabled source no longer authorizes this worker')
    const missionId = trigger?.source === 'workspace' ? trigger.meta.mission : undefined
    if (typeof missionId === 'string') {
      const row = this.store.db.prepare('SELECT value FROM workspace_mission WHERE id=?').get(missionId)
      const mission = row && JSON.parse(String(row.value)) as Mission | undefined
      const action = mission?.actions.find(action => action.runs.includes(ticket.id))
      if (!action || (writing && (mission?.status !== 'active' || action.runs.at(-1) !== ticket.id
        || this.store.settings().sources.workspace?.enabled === false))) throw new WorkspaceError(409, 'Mission no longer authorizes this worker')
      return [`mission:${missionId}`, 'workspace']
    }
    return [`ticket:${ticket.id}`, 'workspace']
  }
  private allowed(scope: string, actor: LibraryActor): void {
    const scopes = this.scope(actor)
    if (scopes && !scopes.includes(scope)) throw new WorkspaceError(404, 'Library record not found')
  }
  private require(id: string, actor: LibraryActor): { record: LibraryRecord; row: Row } {
    LibraryId.parse(id)
    const row = this.store.db.prepare('SELECT value,revision,archived FROM workspace_library WHERE id=?').get(id) as Row | undefined
    if (!row) throw new WorkspaceError(404, 'Library record not found')
    const record = JSON.parse(row.value) as LibraryRecord
    this.allowed(record.scope, actor)
    return { record, row }
  }
  private incoming(id: string, actor: LibraryActor, activeOnly: boolean, relation?: string) {
    const scopes = this.scope(actor), values: SQLInputValue[] = [id]
    let where = 'e.target=?'
    if (relation) { where += ' AND e.relation=?'; values.push(relation) }
    if (scopes) { where += ` AND l.scope IN (${scopes.map(() => '?').join(',')})`; values.push(...scopes) }
    if (activeOnly) { where += ' AND l.archived=0 AND (l.expires_at IS NULL OR l.expires_at>?)'; values.push(this.now()) }
    return this.store.db.prepare(`SELECT e.source AS id,e.relation,json_extract(l.value,'$.hash') AS hash
      FROM workspace_library_edge e JOIN workspace_library l ON l.id=e.source WHERE ${where} ORDER BY l.rowid DESC LIMIT 51`).all(...values) as
      { id: string; relation: LibraryRecord['sources'][number]['relation']; hash: string }[]
  }
  private view(record: LibraryRecord, row: Row, actor: LibraryActor): LibraryEntry {
    return { ...record, revision: Number(row.revision), archived: !!row.archived,
      expired: !!record.expiresAt && record.expiresAt <= this.now(),
      superseded: this.incoming(record.id, actor, true, 'supersedes').length > 0,
      conflicted: this.incoming(record.id, actor, true, 'contradicts').length > 0 || record.sources.some(edge => edge.relation === 'contradicts'),
      verification: 'not_verified', staleSources: record.sources.filter(edge => {
        const source = this.require(edge.id, actor)
        return source.row.archived || (source.record.expiresAt && source.record.expiresAt <= this.now())
          || this.incoming(edge.id, actor, true, 'supersedes').length > 0
      }).map(edge => edge.id) }
  }
  /** Receipt, blob, provenance, metadata and search index commit together, including within a caller's savepoint. */
  private command(actor: LibraryActor, id: string, input: unknown, operation: () => string): LibraryEntry {
    return this.store.atomic(() => {
      const identity = actor.role === 'worker' ? `worker:${actor.ticketId}` : actor.role, fingerprint = key(JSON.stringify(input))
      const receipt = this.store.db.prepare('SELECT fingerprint,record FROM workspace_library_command WHERE actor=? AND id=?').get(identity, id)
      let recordId: string
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This request ID was already used for another operation')
        recordId = String(receipt.record)
      } else {
        recordId = operation()
        this.store.db.prepare('INSERT INTO workspace_library_command VALUES (?,?,?,?)').run(identity, id, fingerprint, recordId)
      }
      const { record, row } = this.require(recordId, actor)
      return this.view(record, row, actor)
    })
  }
  publish(input: unknown, actor: LibraryActor = OPERATOR): LibraryEntry {
    if (actor.role === 'router') throw new WorkspaceError(409, 'The router cannot publish knowledge')
    const request = actor.role === 'operator' ? CreateRecord.parse(input) : PublishRecord.parse(input)
    return this.command(actor, request.requestId, { operation: 'publish', ...request }, () => {
      const scopes = this.scope(actor, true)
      const scope = actor.role === 'operator' ? (request as ReturnType<typeof CreateRecord.parse>).scope : scopes![0]!
      if (scope.startsWith('mission:')) {
        if (!this.store.db.prepare('SELECT id FROM workspace_mission WHERE id=?').get(scope.slice(8))) throw new WorkspaceError(404, 'Mission not found')
      } else if (scope.startsWith('ticket:') && !this.store.tickets.get(scope.slice(7))) throw new WorkspaceError(404, 'Ticket not found')
      const expiresAt = request.expiresAt ? new Date(request.expiresAt).toISOString() : undefined
      if (expiresAt && expiresAt <= this.now()) throw new WorkspaceError(400, 'Expiry must be in the future')
      if (request.kind === 'memory' && (request.encoding !== 'utf8' || !['text/plain', 'text/markdown'].includes(request.mime)))
        throw new WorkspaceError(400, 'Memory must contain UTF-8 plain text or Markdown')
      const bytes = Buffer.from(request.content, request.encoding === 'utf8' ? 'utf8' : 'base64')
      if (request.encoding === 'base64' && bytes.toString('base64') !== request.content) throw new WorkspaceError(400, 'Invalid canonical base64')
      if (!bytes.length || bytes.length > (request.kind === 'memory' ? 64 * 1024 : LIBRARY_MAX_BYTES))
        throw new WorkspaceError(400, 'Content exceeds the limit: 64 KiB memory, 512 KiB artifact')
      if (isText(request.mime) && !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new WorkspaceError(400, 'Text must be valid UTF-8')
      const sources = request.sources.map(edge => {
        const { record } = this.require(edge.id, actor)
        if (record.scope !== scope && (record.scope !== 'workspace' || edge.relation === 'supersedes'))
          throw new WorkspaceError(409, 'Provenance cannot expose another private scope; supersession must stay in its scope')
        return { ...edge, hash: record.hash }
      })
      const hash = digest(bytes), ticket = actor.role === 'worker' ? this.store.tickets.get(actor.ticketId)! : undefined
      const trigger = ticket && this.store.triggers.get(ticket.origin.triggerId)
      const record: LibraryRecord = { id: randomUUID(), kind: request.kind, scope, title: request.title, summary: request.summary,
        mime: request.mime, filename: request.filename, hash, bytes: bytes.length, text: isText(request.mime), createdAt: this.now(),
        ...(expiresAt ? { expiresAt } : {}), sources,
        provenance: { actor: actor.role, trust: actor.role === 'worker' ? 'agent_submission' : 'operator_submission',
          ...(ticket ? { ticketId: ticket.id, sessionId: workerSessionId(ticket.id), assignmentId: latestAssignment(ticket)?.id } : {}),
          ...(trigger ? { triggerId: trigger.id, triggerHash: key(JSON.stringify(trigger)) } : {}) } }
      const count = Number(this.store.db.prepare('SELECT count(*) AS count FROM workspace_library').get()!.count)
      if (count >= 50_000) throw new WorkspaceError(409, 'Library record capacity reached')
      const exists = this.store.db.prepare('SELECT hash FROM workspace_blob WHERE hash=?').get(hash)
      if (!exists && Number(this.store.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM workspace_blob').get()!.bytes) + bytes.length > 512 * 1024 * 1024)
        throw new WorkspaceError(409, 'Library content capacity reached (512 MiB)')
      this.store.db.prepare('INSERT OR IGNORE INTO workspace_blob VALUES (?,?,?)').run(hash, bytes, bytes.length)
      const result = this.store.db.prepare('INSERT INTO workspace_library(id,scope,kind,expires_at,value) VALUES (?,?,?,?,?)')
        .run(record.id, scope, record.kind, record.expiresAt ?? null, JSON.stringify(record))
      this.store.db.prepare('INSERT INTO workspace_library_search(rowid,title,summary,body) VALUES (?,?,?,?)')
        .run(result.lastInsertRowid, record.title, record.summary, record.text ? bytes.toString('utf8').slice(0, 65536) : '')
      for (const edge of sources) this.store.db.prepare('INSERT OR IGNORE INTO workspace_library_edge VALUES (?,?,?)').run(record.id, edge.id, edge.relation)
      return record.id
    })
  }
  list(input: unknown = {}, actor: LibraryActor = OPERATOR): LibraryList {
    const query = LibraryQuery.parse(input), scopes = this.scope(actor), values: SQLInputValue[] = []
    if (query.scope) this.allowed(query.scope, actor)
    let where = '1=1', from = 'workspace_library l'
    if (query.q) {
      const tokens = query.q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 16)
      if (!tokens?.length) return { items: [], nextOffset: null }
      from += ' JOIN workspace_library_search ON workspace_library_search.rowid=l.rowid'
      where += ' AND workspace_library_search MATCH ?'; values.push(tokens.map(token => `"${token}"`).join(' AND '))
    }
    if (query.scope) { where += ' AND l.scope=?'; values.push(query.scope) }
    else if (scopes) { where += ` AND l.scope IN (${scopes.map(() => '?').join(',')})`; values.push(...scopes) }
    if (query.kind) { where += ' AND l.kind=?'; values.push(query.kind) }
    if (query.includeInactive !== 'true') {
      where += ` AND l.archived=0 AND (l.expires_at IS NULL OR l.expires_at>?) AND NOT EXISTS
        (SELECT 1 FROM workspace_library_edge e JOIN workspace_library n ON n.id=e.source
          WHERE e.target=l.id AND e.relation='supersedes' AND n.scope=l.scope AND n.archived=0 AND (n.expires_at IS NULL OR n.expires_at>?))`
      values.push(this.now(), this.now())
    }
    const rows = this.store.db.prepare(`SELECT l.value,l.revision,l.archived FROM ${from} WHERE ${where}
      ORDER BY ${query.q ? 'rank,' : ''} l.rowid DESC LIMIT ? OFFSET ?`).all(...values, query.limit + 1, query.offset) as Row[]
    return { items: rows.slice(0, query.limit).map(row => this.view(JSON.parse(row.value) as LibraryRecord, row, actor)),
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null }
  }
  read(id: string, input: unknown = {}, actor: LibraryActor = OPERATOR): LibraryRead {
    const page = LibraryPage.parse(input), { record, row } = this.require(id, actor), incoming = this.incoming(id, actor, false)
    const text = record.text ? this.bytes(record).toString('utf8') : null
    return { ...this.view(record, row, actor), contextOnly: true, content: text?.slice(page.offset, page.offset + page.limit) ?? null,
      totalChars: text?.length ?? null, nextOffset: text && text.length > page.offset + page.limit ? page.offset + page.limit : null,
      incoming: incoming.slice(0, 50), incomingTruncated: incoming.length > 50 }
  }
  private bytes(record: LibraryRecord): Buffer {
    const row = this.store.db.prepare('SELECT data FROM workspace_blob WHERE hash=?').get(record.hash)
    const bytes = row && types.isUint8Array(row.data) ? Buffer.from(row.data) : undefined
    if (!bytes || digest(bytes) !== record.hash) throw new WorkspaceError(409, 'Library content integrity check failed')
    return bytes
  }
  content(id: string): LibraryContent {
    const { record } = this.require(id, OPERATOR)
    return { data: this.bytes(record).toString('base64'), encoding: 'base64', hash: record.hash, mime: record.mime, filename: record.filename }
  }
  archive(id: string, input: unknown): LibraryEntry {
    const request = ArchiveRecord.parse(input)
    return this.command(OPERATOR, request.requestId, { operation: 'archive', id, ...request }, () => {
      const { row } = this.require(id, OPERATOR)
      if (row.revision !== request.revision) throw new WorkspaceError(409, 'Library record changed. Refresh before trying again.')
      this.store.db.prepare('UPDATE workspace_library SET archived=?,revision=revision+1 WHERE id=?')
        .run(request.archived ? 1 : 0, id)
      return id
    })
  }
  /** Bind mission review to the submitted artifacts/memories and their visibility state, not to a model's success claim. */
  evidenceRevision(ticketId: string): string {
    const rows = this.store.db.prepare(`SELECT id,revision,(expires_at IS NOT NULL AND expires_at<=?) AS expired FROM workspace_library
      WHERE json_extract(value,'$.provenance.ticketId')=? ORDER BY id`).all(this.now(), ticketId)
    if (!rows.length) return ''
    // A new revision or contradiction can come from the operator or a different worker in the same mission.
    const related = this.store.db.prepare(`SELECT DISTINCT n.id,n.revision,(n.expires_at IS NOT NULL AND n.expires_at<=?) AS expired
      FROM workspace_library n JOIN workspace_library_edge e ON (e.source=n.id OR e.target=n.id)
      JOIN workspace_library root ON (root.id=e.source OR root.id=e.target)
      WHERE json_extract(root.value,'$.provenance.ticketId')=? ORDER BY n.id`).all(this.now(), ticketId)
    return key(JSON.stringify({ rows, related }))
  }
}
