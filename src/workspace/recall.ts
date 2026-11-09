import { randomUUID } from 'node:crypto'
import { key, latestAssignment } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { Library } from './library.ts'
import { LibraryQuery, type LibraryActor, type LibraryRead } from './library-model.ts'
import { WorkspaceError } from './model.ts'
import { DEFAULT_RECALL, RecallRead, SaveRecall, type RecallAttempt, type RecallConfiguration, type RecallMetrics,
  type RecallOwner, type RecallReceipt, type RecallState } from './recall-model.ts'

const zero = (): RecallMetrics => ({ calls: 0, pages: 0, bytes: 0, nodes: 0, millis: 0 })
const dimensions = ['calls', 'pages', 'bytes', 'nodes', 'millis'] as const
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** Durable allowances shared across a worker assignment or router UTC day; retrieval tools cannot mint or reset them. */
export class Recall {
  constructor(private readonly store: Store, private readonly library: Library,
    private readonly now: () => string = () => new Date().toISOString(), private readonly clock: () => number = () => performance.now()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_recall_config (revision INTEGER PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_recall_command (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_recall_attempt (id TEXT PRIMARY KEY,owner TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_recall_owner ON workspace_recall_attempt(owner);`)
    if (!store.db.prepare('PRAGMA table_info(workspace_recall_command)').all().some(row => row.name === 'request'))
      store.db.exec('ALTER TABLE workspace_recall_command ADD COLUMN request TEXT')
    if (!store.db.prepare('SELECT 1 FROM workspace_recall_config LIMIT 1').get()) store.db.prepare('INSERT INTO workspace_recall_config VALUES (0,?)')
      .run(JSON.stringify({ revision: 0, at: this.now(), policy: DEFAULT_RECALL } satisfies RecallConfiguration))
  }
  configuration(revision?: number): RecallConfiguration {
    const row = revision === undefined ? this.store.db.prepare('SELECT value FROM workspace_recall_config ORDER BY revision DESC LIMIT 1').get()
      : this.store.db.prepare('SELECT value FROM workspace_recall_config WHERE revision=?').get(revision)
    if (!row) throw new WorkspaceError(404, 'Recall configuration not found')
    return JSON.parse(String(row.value)) as RecallConfiguration
  }
  configure(input: unknown): RecallConfiguration {
    const request = SaveRecall.parse(input)
    this.store.atomic(() => {
      const fingerprint = key(JSON.stringify(request)), previous = this.store.db.prepare('SELECT fingerprint FROM workspace_recall_command WHERE id=?').get(request.requestId)
      if (previous) { if (previous.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This request ID was already used for another operation'); return }
      const current = this.configuration()
      if (current.revision !== request.revision) throw new WorkspaceError(409, 'Recall limits changed; reload before editing')
      const next = { revision: current.revision + 1, at: this.now(), policy: request.policy }
      this.store.db.prepare('INSERT INTO workspace_recall_config VALUES (?,?)').run(next.revision, JSON.stringify(next))
      this.store.db.prepare('INSERT INTO workspace_recall_command(id,fingerprint,request) VALUES (?,?,?)').run(request.requestId, fingerprint, JSON.stringify(request))
    })
    return this.configuration()
  }
  state(offset = 0, limit = 30): RecallState {
    const rows = this.store.db.prepare('SELECT value FROM workspace_recall_attempt ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit + 1, offset)
    return { configuration: this.configuration(), attempts: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as RecallAttempt), nextOffset: rows.length > limit ? offset + limit : null }
  }
  private owner(actor: LibraryActor): RecallOwner {
    if (actor.role === 'operator') throw new WorkspaceError(400, 'Operator browsing does not consume agent recall allowances')
    if (actor.role === 'router') { const day = this.now().slice(0, 10); return { id: `router:${day}`, role: 'router', day } }
    const ticket = this.store.tickets.get(actor.ticketId), assignment = ticket && latestAssignment(ticket)
    if (!ticket || !assignment) throw new WorkspaceError(409, 'Recall requires an assigned worker')
    return { id: `worker:${ticket.id}:${assignment.id}`, role: 'worker', ticketId: ticket.id, assignmentId: assignment.id }
  }
  private totals(owner: string): RecallMetrics {
    const row = this.store.db.prepare(`SELECT ${dimensions.map(name => `coalesce(sum(value ->> '$.charged.${name}'),0) AS ${name}`).join(',')}
      FROM workspace_recall_attempt WHERE owner=?`).get(owner)!
    return Object.fromEntries(dimensions.map(name => [name, Number(row[name])])) as unknown as RecallMetrics
  }
  private save(attempt: RecallAttempt): void { this.store.db.prepare('UPDATE workspace_recall_attempt SET value=? WHERE id=?').run(JSON.stringify(attempt), attempt.id) }
  private run<T extends object>(actor: LibraryActor, operation: RecallAttempt['operation'], signal: AbortSignal,
    retrieve: (context: { metrics: RecallMetrics; reserve: RecallMetrics; admit: (id: string) => boolean; time: () => boolean; depth: number }) => { result: T; trim: () => boolean; truncated: () => boolean }): T & { recall: RecallReceipt } {
    signal.throwIfAborted()
    const { attempt, config, before } = this.store.atomic(() => {
      const config = this.configuration(), owner = this.owner(actor), before = this.totals(owner.id), remaining = zero()
      for (const dimension of dimensions) remaining[dimension] = Math.max(0, config.policy.owner[dimension] - before[dimension])
      if (!remaining.calls || !remaining.pages || remaining.bytes < 4096 || !remaining.nodes || !remaining.millis)
        throw new WorkspaceError(409, 'Recall allowance exhausted. Continue with existing context or ask the operator to raise the limits.')
      const reserved: RecallMetrics = { calls: 1, pages: Math.min(config.policy.run.pages, remaining.pages), bytes: Math.min(config.policy.run.bytes, remaining.bytes),
        nodes: Math.min(config.policy.run.nodes, remaining.nodes), millis: Math.min(config.policy.run.millis, remaining.millis) }
      const attempt: RecallAttempt = { id: randomUUID(), owner, at: this.now(), revision: config.revision, operation, phase: 'reserved', charged: reserved, reserved }
      this.store.db.prepare('INSERT INTO workspace_recall_attempt VALUES (?,?,?)').run(attempt.id, owner.id, JSON.stringify(attempt))
      return { attempt, config, before }
    })
    const started = this.clock(), metrics = { ...zero(), calls: 1 }, reserve = attempt.reserved, seen = new Set<string>()
    const time = () => { signal.throwIfAborted(); return this.clock() - started < reserve.millis }
    const admit = (id: string) => { if (seen.has(id)) return true; if (metrics.nodes >= reserve.nodes || !time()) return false; seen.add(id); metrics.nodes++; return true }
    try {
      const loaded = retrieve({ metrics, reserve, admit, time, depth: config.policy.run.depth })
      let truncated = loaded.truncated(), output: T & { recall: RecallReceipt }
      const envelope = () => {
        metrics.millis = Math.max(1, Math.ceil(this.clock() - started))
        const remaining = zero()
        for (const dimension of dimensions) remaining[dimension] = Math.max(0, config.policy.owner[dimension] - before[dimension] - metrics[dimension])
        return { ...loaded.result, recall: { owner: attempt.owner, charged: metrics, remaining, truncated } }
      }
      // Metadata and the receipt count toward the exact serialized UTF-8 output ceiling as well as content.
      for (;;) {
        output = envelope()
        for (let n = 0; n < 8; n++) { const bytes = size(output); if (bytes === metrics.bytes) break; metrics.bytes = bytes; output = envelope() }
        if (size(output) <= reserve.bytes) break
        if (!loaded.trim()) throw new WorkspaceError(409, 'The record metadata cannot fit the remaining recall allowance')
        truncated = true
      }
      signal.throwIfAborted()
      attempt.phase = 'complete'; attempt.truncated = truncated; attempt.charged = { ...metrics, bytes: size(output) }
      this.save(attempt); return output
    } catch (error) {
      attempt.phase = 'failed'; attempt.charged = { ...metrics, bytes: 0, millis: Math.max(1, Math.ceil(this.clock() - started)) }
      this.save(attempt); throw error
    }
  }
  search(input: unknown, actor: LibraryActor, signal: AbortSignal) {
    const query = LibraryQuery.parse(input)
    return this.run(actor, 'search', signal, context => {
      context.metrics.pages++
      const result = this.library.list({ ...query, limit: Math.min(query.limit, context.reserve.nodes) }, actor, this.library.inspector(actor, context.admit))
      const first = result.items.findIndex(item => !context.admit(item.id))
      if (first === 0) throw new WorkspaceError(409, 'Recall inspection reached its time or node allowance before a result was available')
      if (first > 0) { result.items = result.items.slice(0, first); result.nextOffset = query.offset + first }
      return { result, truncated: () => !context.time() || result.items.some(item => item.freshness?.complete === false), trim: () => {
        if (result.items.length <= 1) return false
        result.items.pop(); result.nextOffset = query.offset + result.items.length; return true
      } }
    })
  }
  read(input: unknown, actor: LibraryActor, signal: AbortSignal) {
    const { id, depth: requested, ...page } = RecallRead.parse(input)
    return this.run(actor, 'read', signal, context => {
      const inspector = this.library.inspector(actor, context.admit), chain: LibraryRead[] = [], seen = new Set<string>([id])
      if (!context.admit(id)) throw new WorkspaceError(409, 'Recall inspection reached its time or node allowance')
      context.metrics.pages++
      const root = this.library.read(id, page, actor, inspector), depth = Math.min(requested, context.depth)
      const links = (record: LibraryRead) => [...record.sources.map(edge => edge.id), ...record.incoming.filter(edge => edge.relation === 'supersedes' || edge.relation === 'contradicts').map(edge => edge.id)]
      const queue = links(root).map(id => ({ id, level: 1 })); let incomplete = requested > depth || root.freshness?.complete === false || root.nextOffset !== null
      while (queue.length) {
        const next = queue.shift()!
        if (seen.has(next.id)) continue
        if (next.level > depth) { incomplete = true; continue }
        if (context.metrics.pages >= context.reserve.pages || !context.time() || !context.admit(next.id)) { incomplete = true; break }
        seen.add(next.id); context.metrics.pages++
        try {
          const record = this.library.read(next.id, { limit: page.limit }, actor, inspector)
          chain.push(record); if (!record.freshness?.complete || record.nextOffset !== null) incomplete = true
          for (const id of links(record)) if (!seen.has(id)) queue.push({ id, level: next.level + 1 })
        } catch { incomplete = true }
      }
      const result = { ...root, chain }
      return { result, truncated: () => incomplete || !context.time(), trim: () => {
        if (chain.length) { chain.pop(); return true }
        if (result.content && result.content.length > 1) {
          result.content = result.content.slice(0, Math.floor(result.content.length / 2)); result.nextOffset = page.offset + result.content.length; return true
        }
        return false
      } }
    })
  }
}
