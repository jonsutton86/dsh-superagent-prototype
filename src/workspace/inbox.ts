import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { key, latestAssignment, ticketStage, hasPendingFollowup, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { workerSessionId } from '../executor/dsh.ts'
import type { Workspace } from './service.ts'
import type { Library } from './library.ts'
import { WorkspaceError } from './model.ts'
import type { Attachments } from '../attachments/service.ts'
import { InboxHistory, InboxQuery, InboxRead, InboxReply, InboxStart,
  type Conversation, type ConversationMessage, type InboxItem, type InboxPage } from './inbox-model.ts'

const MAX_TEXT = 8000
const bounded = (text: string) => ({ text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT })
const compare = (a: Pick<ConversationMessage, 'at' | 'id'>, b: Pick<ConversationMessage, 'at' | 'id'>) =>
  a.at.localeCompare(b.at) || a.id.localeCompare(b.id)

/** A durable display projection over Engine tickets and Harness messages; all work still enters through Workspace. */
export class Inbox {
  private readonly hydrated = new Set<string>()
  private readonly loading = new Map<string, Promise<boolean>>()
  constructor(private readonly store: Store, private readonly workspace: Workspace, private readonly library: Library,
    private readonly history: (sessionId: string) => Promise<readonly SessionEvent[]>, private readonly attachments?: Attachments) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_inbox_read (ticket TEXT PRIMARY KEY, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_inbox_message (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL, identity TEXT NOT NULL,
        seq INTEGER NOT NULL, at TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(ticket,identity));
      CREATE INDEX IF NOT EXISTS workspace_inbox_message_ticket ON workspace_inbox_message(ticket,at);
      CREATE TABLE IF NOT EXISTS workspace_inbox_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, ticket TEXT NOT NULL);`)
  }
  private require(id: string): Ticket {
    const ticket = this.store.tickets.get(id)
    if (!ticket) throw new WorkspaceError(404, 'Conversation not found')
    return ticket
  }
  /** Capture only append-origin visible text; tool payloads, reasoning, injected prompts and compaction replacements stay in Harness. */
  record(id: string, event: SessionEvent): void {
    if (!this.store.tickets.get(id)?.execution || !Number.isSafeInteger(event.seq) || !Number.isFinite(event.time)
      || event.surfaceOp !== 'append') return
    const message = event.type === 'assistant/message' ? event.data.message
      : event.type === 'user/message' && event.data.source.kind === 'user' ? event.data : undefined
    if (!message || typeof message.id !== 'string') return
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    if (!text) return
    const at = new Date(event.time).toISOString()
    const identity = key(message.id)
    const value: ConversationMessage = { id: `session:${identity}`, at, role: message.role === 'user' ? 'person' : 'agent',
      ...bounded(text), source: 'Harness' }
    this.store.db.prepare('INSERT OR IGNORE INTO workspace_inbox_message (ticket,identity,seq,at,value) VALUES (?,?,?,?,?)')
      .run(id, identity, event.seq, at, JSON.stringify(value))
  }
  item(id: string): InboxItem {
    const ticket = this.require(id), origin = this.store.triggers.get(ticket.origin.triggerId)
    const last = this.store.db.prepare('SELECT at,value FROM workspace_inbox_message WHERE ticket=? ORDER BY at DESC,seq DESC,id DESC LIMIT 1').get(id)
    const activity = this.store.db.prepare('SELECT MAX(id) AS revision FROM workspace_inbox_message WHERE ticket=?').get(id)?.revision
    const message = last ? JSON.parse(String(last.value)) as ConversationMessage : undefined
    const report = latestAssignment(ticket)?.report
    let mission: InboxItem['mission'], reviewed = false, definitionCurrent = false, outdated = false
    if (origin?.source === 'workspace' && typeof origin.meta.mission === 'string' && typeof origin.meta.action === 'string') {
      try {
        const value = this.workspace.get(origin.meta.mission, false)
        const action = value.actions.find(action => action.id === origin.meta.action)
        mission = { id: value.id, title: value.title, actionId: origin.meta.action, revision: value.revision, current: action?.ticket?.id === id }
        if (action) {
          reviewed = action.status === 'done'
          definitionCurrent = action.owner === 'agent' && !!action.ticket?.currentDefinition && action.status !== 'outdated'
          outdated = mission.current && !definitionCurrent
        }
      } catch (error) { if (!(error instanceof WorkspaceError && error.status === 404)) throw error }
    }
    const stage = ticketStage(ticket)
    const followup = hasPendingFollowup(ticket)
    const status: InboxItem['status'] = outdated ? 'outdated' : ticket.attention ? 'question' : followup ? 'working' : ticket.ended
      ? ['completed', 'merged'].includes(ticket.ended.outcome) ? mission?.current && !reviewed ? 'review' : 'done' : 'stopped'
      : stage.stage === 'person' ? stage.action === 'review' ? 'review' : 'blocked' : stage.stage === 'working' ? 'working' : 'idle'
    // Delivery bookkeeping and a read acknowledgement never create unread work. New messages, reports, questions and state do.
    const revision = key(JSON.stringify({ title: ticket.title, inputs: ticket.inputs.map(input => input.id), report,
      attention: ticket.attention, ended: ticket.ended, assignment: latestAssignment(ticket)?.id, message: activity,
      evidence: this.library.evidenceRevision(id), status }))
    const seen = this.store.db.prepare('SELECT revision FROM workspace_inbox_read WHERE ticket=?').get(id)
    const at = [ticket.updatedAt, message?.at ?? ''].sort().at(-1)!
    const canReply = !!mission?.current && definitionCurrent && ticket.ended?.by !== 'human' && this.workspace.get(mission.id, false).status === 'active'
      && this.store.settings().sources.workspace?.enabled !== false && this.workspace.executionAllowed(ticket)
    return { id, title: ticket.title, source: origin?.source ?? ticket.mandate.actor.source, at, revision,
      unread: seen?.revision !== revision, status, preview: (ticket.attention?.question || report?.summary || message?.text || origin?.text || '').slice(0, 300),
      ...(ticket.attention ? { question: ticket.attention.question } : {}), ...(ticket.execution ? { sessionId: workerSessionId(id) } : {}),
      ...(mission ? { mission } : {}), canReply }
  }
  list(input: unknown = {}): InboxPage {
    const query = InboxQuery.parse(input)
    const all = this.store.tickets.list().map(ticket => this.item(ticket.id))
    const counts = { unread: all.filter(item => item.unread).length, questions: all.filter(item => item.status === 'question').length,
      review: all.filter(item => item.status === 'review').length }
    const items = all.filter(item => (!query.q || `${item.title}\n${item.preview}\n${item.mission?.title ?? ''}`.toLowerCase().includes(query.q.toLowerCase()))
      && (query.filter === 'all' || query.filter === 'unread' && item.unread || query.filter === 'questions' && item.status === 'question'
        || query.filter === 'review' && item.status === 'review' || query.filter === 'working' && item.status === 'working'))
      .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    return { ...counts, items: items.slice(query.offset, query.offset + query.limit),
      nextOffset: items.length > query.offset + query.limit ? query.offset + query.limit : null }
  }
  /** Compare the exact rendered revision before marking it read; late acknowledgements cannot hide newer work. */
  read(id: string, input: unknown): { marked: boolean; unread: boolean } {
    const request = InboxRead.parse(input)
    return this.store.atomic(() => {
      const current = this.item(id)
      if (current.revision !== request.revision) return { marked: false, unread: current.unread }
      this.store.db.prepare('INSERT INTO workspace_inbox_read VALUES (?,?) ON CONFLICT(ticket) DO UPDATE SET revision=excluded.revision')
        .run(id, request.revision)
      return { marked: true, unread: false }
    })
  }
  private command(requestId: string, input: unknown, operation: () => string): InboxItem {
    return this.store.atomic(() => {
      const fingerprint = key(JSON.stringify(input))
      const receipt = this.store.db.prepare('SELECT fingerprint,ticket FROM workspace_inbox_command WHERE id=?').get(requestId)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This request ID was already used for another operation')
        return this.item(String(receipt.ticket))
      }
      const id = operation()
      this.store.db.prepare('INSERT INTO workspace_inbox_command VALUES (?,?,?)').run(requestId, fingerprint, id)
      return this.item(id)
    })
  }
  start(input: unknown): InboxItem {
    const request = InboxStart.parse(input), prefix = `inbox-${key(request.requestId)}`
    return this.command(request.requestId, { operation: 'start', ...request }, () => {
      if (request.attachments?.length && !this.attachments) throw new WorkspaceError(409, 'Attachments are unavailable')
      const files = this.attachments?.selection(request.attachments ?? []) ?? []
      let mission = this.workspace.create({ requestId: `${prefix}-mission`, title: request.title || request.text.split('\n')[0]!.slice(0, 160),
        objective: request.text, acceptance: 'The requested result is available with evidence and limitations, and has been explicitly reviewed.' })
      mission = this.workspace.add(mission.id, { requestId: `${prefix}-action`, revision: mission.revision, title: mission.title,
        instructions: request.text, owner: 'agent' })
      mission = this.workspace.act(mission.id, mission.actions[0]!.id, { requestId: `${prefix}-run`, revision: mission.revision, command: 'run' })
      const id = mission.actions[0]!.ticket!.id, ticket = this.require(id)
      this.attachments?.bind(id, `trigger:${ticket.origin.triggerId}`, files)
      return id
    })
  }
  reply(id: string, input: unknown): InboxItem {
    const request = InboxReply.parse(input)
    return this.command(request.requestId, { operation: 'reply', id, ...request }, () => {
      const item = this.item(id)
      if (item.revision !== request.revision) throw new WorkspaceError(409, 'Conversation changed. Review the latest update before sending.')
      if (!item.canReply || !item.mission) throw new WorkspaceError(409, 'This conversation cannot receive new work. Open its mission or original Session.')
      if (request.attachments?.length && !this.attachments) throw new WorkspaceError(409, 'Attachments are unavailable')
      const files = this.attachments?.selection(request.attachments ?? []) ?? []
      const prior = new Set(this.require(id).inputs.map(input => input.id))
      this.workspace.act(item.mission.id, item.mission.actionId, { requestId: `inbox-${key(request.requestId)}-reply`,
        revision: item.mission.revision, command: 'steer', text: request.text })
      if (files.length) {
        const added = this.require(id).inputs.filter(input => input.kind === 'trigger' && !prior.has(input.id))
        if (added.length !== 1 || added[0]!.kind !== 'trigger') throw new WorkspaceError(409, 'Could not bind attachments to the accepted reply')
        this.attachments!.bind(id, `trigger:${added[0]!.triggerId}`, files)
      }
      return id
    })
  }
  /** Backfill once per process and coalesce readers; subsequent visible messages arrive through the live event subscription. */
  private hydrate(id: string): Promise<boolean> {
    if (this.hydrated.has(id)) return Promise.resolve(true)
    const pending = this.loading.get(id)
    if (pending) return pending
    const read = (async () => {
      try {
        const events = await this.history(workerSessionId(id))
        this.store.atomic(() => { for (const event of events) this.record(id, event) })
        this.hydrated.add(id); return true
      } catch { return false }
      finally { this.loading.delete(id) }
    })()
    this.loading.set(id, read)
    return read
  }
  async conversation(id: string, input: unknown = {}): Promise<Conversation> {
    const query = InboxHistory.parse(input)
    const ticket = this.require(id)
    const historyAvailable = !ticket.execution || await this.hydrate(id)
    // Re-read after the asynchronous history call so messages and acknowledgement revision describe the same snapshot.
    const current = this.require(id), item = this.item(id)
    const messages = new Map<string, ConversationMessage>()
    for (const row of this.store.db.prepare('SELECT value FROM workspace_inbox_message WHERE ticket=?').all(id)) {
      const message = JSON.parse(String(row.value)) as ConversationMessage; messages.set(message.id, message)
    }
    const addTrigger = (triggerId: string, pending = false, context = false) => {
      const trigger = this.store.triggers.get(triggerId)
      if (trigger) messages.set(`trigger:${trigger.id}`, { id: `trigger:${trigger.id}`, at: trigger.at,
        role: context ? 'context' : trigger.human ? 'person' : 'context', ...bounded(trigger.text), pending, source: trigger.source,
        ...(this.attachments?.list(id, `trigger:${trigger.id}`).length ? { attachments: this.attachments.list(id, `trigger:${trigger.id}`) } : {}) })
    }
    current.origin.triggerIds.forEach(triggerId => addTrigger(triggerId))
    for (const value of current.inputs) {
      if (value.kind === 'trigger') addTrigger(value.triggerId, current.undelivered.includes(value.id), !!value.context)
      if (value.kind === 'text' || value.kind === 'note') messages.set(`input:${value.id}`, { id: `input:${value.id}`, at: value.at,
        role: 'context', ...bounded(value.text), pending: current.undelivered.includes(value.id) })
    }
    for (const assignment of current.assignments) if (assignment.report) messages.set(`report:${assignment.id}`, {
      id: `report:${assignment.id}`, at: assignment.report.at, role: 'status', ...bounded(assignment.report.summary) })
    let before: { at: string; id: string } | undefined
    if (query.before) {
      try {
        const parsed = JSON.parse(Buffer.from(query.before, 'base64url').toString()) as unknown
        if (!parsed || typeof parsed !== 'object' || !('at' in parsed) || typeof parsed.at !== 'string'
          || !('id' in parsed) || typeof parsed.id !== 'string') throw new Error('cursor')
        before = { at: parsed.at, id: parsed.id }
      } catch { throw new WorkspaceError(400, 'Invalid conversation cursor') }
    }
    const ordered = [...messages.values()].filter(value => !before || compare(value, before) < 0).sort(compare)
    const page = ordered.slice(-query.limit), first = page[0]
    const nextBefore = ordered.length > page.length && first ? Buffer.from(JSON.stringify({ at: first.at, id: first.id })).toString('base64url') : null
    const scope = item.mission ? `mission:${item.mission.id}` : `ticket:${id}`
    return { item, messages: page, nextBefore, historyAvailable,
      artifacts: this.library.list({ scope, limit: 20 }).items.map(({ id, title, kind }) => ({ id, title, kind })) }
  }
}
