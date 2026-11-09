import { z } from 'zod'
import type { Store } from '../app/store.ts'
import { followupOwners, type Engine, type Policy, type Ticket } from '../core/index.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { CoordinatorOwnership } from '../ownership/lease.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { PublicationClient, type PublicationConnection } from './client.ts'
import { ConversationPage, PublicationId, PublicationError, type ConversationMessage, type DestinationView } from './protocol.ts'
import type { ChannelPublications } from './channels.ts'

export const ConfigureInbound = z.object({ requestId: PublicationId, revision: z.number().int().nonnegative(), enabled: z.boolean(),
  grantId: PublicationId.optional(), ticketId: z.string().min(1).max(200).optional(), senders: z.array(z.string().trim().min(1).max(200)).max(100).default([]) }).strict()
  .refine(value => !value.enabled || !!value.grantId && !!value.ticketId && value.senders.length > 0, 'Choose an authorized task and participants')
export type ConfigureInbound = z.infer<typeof ConfigureInbound>
export interface InboundBinding { id: string; missionId: string; revision: number; enabled: boolean; grantId?: string; ticketId?: string;
  destination?: DestinationView; senders: string[]; startsAt: string; revokedAt?: string; lastPoll?: string; problem?: string; received: number; unsupported: number }
interface StoredBinding extends InboundBinding { nextPoll: number; failures: number; watermark: string; cycle?: { since: string; startedAt: string; cursor?: string; seen: string[] } }
export interface InboundRecord { id: string; bindingId: string; ticketId: string; sender: string; at: string; url: string; hash: string;
  status: 'received' | 'unsupported'; triggerId?: string; problem?: string }
export interface InboundState { configured: boolean; binding?: InboundBinding; active: boolean; items: InboundRecord[] }
interface Host { store: Store; ownership?: CoordinatorOwnership; connection?: PublicationConnection; lifetime: AbortSignal; channels: ChannelPublications;
  engine(): Engine; authorized(ticket: Ticket): boolean; requestPass(): void }
const SOURCE = 'conversation'
const view = ({ nextPoll: _, failures: __, watermark: ___, cycle: ____, ...value }: StoredBinding): InboundBinding => value
// Configuration aliases and credential/display changes do not make a second physical conversation.
const conversationKey = (destination: DestinationView): string => fingerprint(destination.kind === 'feishu-reply'
  ? { kind: destination.kind, brand: destination.brand, chat: destination.chatId, root: destination.messageId }
  : { kind: destination.kind, repository: destination.repository.toLowerCase(), issue: destination.issue,
    ...(destination.kind === 'github-review' ? { root: destination.comment } : {}) })

/** Explicit per-task inbound conversation authority, with durable provider cursors and atomic directed Engine delivery. */
export class ConversationInbox {
  private readonly client?: PublicationClient
  private readonly stopped = new AbortController()
  private readonly pending = new Map<string, Promise<InboundState>>()
  private timer?: ReturnType<typeof setInterval>
  constructor(private readonly host: Host) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS conversation_binding (id TEXT PRIMARY KEY, mission TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_binding_mission ON conversation_binding(mission);
      CREATE TABLE IF NOT EXISTS conversation_message (id TEXT PRIMARY KEY, binding TEXT NOT NULL, mission TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_message_mission ON conversation_message(mission);`)
    if (host.connection) this.client = new PublicationClient(host.connection, host.ownership)
  }
  readonly source: SourceKind = { kind: SOURCE, title: { en: 'External task replies', zh: '外部任务回复' },
    description: { en: 'Authorized participants replying to one selected task.', zh: '经授权的参与者向指定任务发送的回复。' },
    schema: z.object({}).strict(), fields: [], health: [], scope: ({ meta }) => {
      const item = typeof meta.inbound === 'string' ? this.record(meta.inbound) : undefined
      const binding = item && this.binding(item.bindingId)
      return binding && this.active(binding) ? { listened: true, observed: false } : { listened: false, reason: 'External reply authority is inactive' }
    } }
  /** Incoming participants can steer/stop their existing recipient, but returned messages never authorize another task. */
  policy(base: Policy): Policy {
    return { ...base, gate: (trigger, thread, tickets) => {
      if (trigger.source !== SOURCE) return base.gate(trigger, thread, tickets)
      const item = typeof trigger.meta.inbound === 'string' ? this.record(trigger.meta.inbound) : undefined, binding = item && this.binding(item.bindingId)
      return item && binding && this.active(binding) && item.sender === trigger.actor.id && item.triggerId === trigger.id
        && followupOwners(trigger, this.host.store).includes(item.ticketId)
        ? { admissible: true, strength: 'explicit', basis: { via: 'followup', tickets: [item.ticketId], source: SOURCE, scope: { inbound: item.id } } }
        : { admissible: false, reason: 'External replies can only steer their original task' }
    }, revalidate: mandate => mandate.actor.source !== SOURCE && base.revalidate(mandate) }
  }
  private owner(): void {
    this.host.lifetime.throwIfAborted(); this.stopped.signal.throwIfAborted(); this.host.ownership?.proof()
    if (!this.client || !this.host.ownership) throw new PublicationError(409, 'not_configured', 'An owned publication service is required')
  }
  private binding(id: string): StoredBinding | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM conversation_binding WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  private latest(missionId: string): StoredBinding | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM conversation_binding WHERE mission=? ORDER BY rowid DESC LIMIT 1').get(missionId)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  private record(id: string): InboundRecord | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM conversation_message WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) : undefined
  }
  private save(binding: StoredBinding): void { this.host.store.db.prepare('UPDATE conversation_binding SET value=? WHERE id=?').run(JSON.stringify(binding), binding.id) }
  private active(binding: StoredBinding): boolean {
    try { this.owner() } catch { return false }
    if (!binding.enabled || binding.revokedAt || !binding.grantId || !binding.ticketId || this.host.store.settings().sources[SOURCE]?.enabled === false) return false
    if (!this.host.channels.allowed(binding.grantId)) return false
    const ticket = this.host.store.tickets.get(binding.ticketId)
    return !!ticket && ticket.ended?.by !== 'human' && this.host.authorized(ticket)
  }
  state(missionId: string): InboundState {
    this.host.channels.state(missionId)
    const binding = this.latest(missionId), rows = this.host.store.db.prepare('SELECT value FROM conversation_message WHERE mission=? ORDER BY rowid DESC LIMIT 100').all(missionId)
    return { configured: !!this.client, ...(binding ? { binding: view(binding) } : {}), active: !!binding && this.active(binding), items: rows.map(row => JSON.parse(String(row.value))) }
  }
  configure(missionId: string, input: unknown): InboundState {
    const request = ConfigureInbound.parse(input), digest = fingerprint({ missionId, ...request }); this.owner()
    return this.host.store.atomic(() => {
      const saved = this.host.store.db.prepare('SELECT fingerprint FROM conversation_binding WHERE id=?').get(request.requestId)
      if (saved) { if (saved.fingerprint !== digest) throw new PublicationError(409, 'intent_changed', 'Listener request ID belongs to another configuration'); return this.state(missionId) }
      const old = this.latest(missionId), delivery = this.host.channels.state(missionId), grant = delivery.grant
      if ((old?.revision ?? 0) !== request.revision) throw new PublicationError(409, 'listener_changed', 'Refresh and review the current listener')
      const ticket = request.ticketId ? this.host.store.tickets.get(request.ticketId) : undefined
      const origin = ticket ? this.host.store.triggers.get(ticket.origin.triggerId) : undefined
      if (request.enabled && (!delivery.current || !grant || grant.id !== request.grantId || !grant.destination || !ticket || ticket.ended?.by === 'human'
        || origin?.meta.mission !== missionId || origin.channel?.address.grantId !== grant.id || !this.host.authorized(ticket)))
        throw new PublicationError(409, 'listener_scope', 'Choose a current task under the exact mission delivery grant')
      const destination = request.enabled ? grant!.destination! : undefined
      const senders = [...new Set(request.senders.map(sender => destination?.kind === 'feishu-reply' ? sender : sender.toLowerCase()))]
      if (request.enabled && senders.some(sender => !(destination!.kind === 'feishu-reply' ? /^ou_[A-Za-z0-9]+$/ : /^[a-z0-9-]+$/).test(sender)))
        throw new PublicationError(400, 'invalid_sender', 'Use exact GitHub logins or Feishu/Lark open user IDs')
      const configured = this.host.store.db.prepare("SELECT value FROM conversation_binding WHERE json_extract(value,'$.enabled')=1 AND json_extract(value,'$.revokedAt') IS NULL").all()
      if (request.enabled && configured.length >= 100 && !old?.enabled) throw new PublicationError(409, 'listener_limit', 'Disable an existing listener before adding another')
      if (request.enabled) for (const row of configured) {
        const other: StoredBinding = JSON.parse(String(row.value))
        if (other.missionId !== missionId && other.destination && conversationKey(other.destination) === conversationKey(destination!))
          throw new PublicationError(409, 'destination_busy', 'This conversation already steers another mission')
      }
      const at = timestamp(), startsAt = new Date((Math.floor(Date.now() / 1000) + 1) * 1000).toISOString()
      if (old) { old.revokedAt = at; this.save(old) }
      const binding: StoredBinding = { id: request.requestId, missionId, revision: request.revision + 1, enabled: request.enabled,
        ...(destination ? { destination, grantId: grant!.id, ticketId: ticket!.id } : {}), senders, startsAt, watermark: startsAt, failures: 0, nextPoll: 0, received: 0, unsupported: 0 }
      this.host.store.db.prepare('INSERT INTO conversation_binding VALUES (?,?,?,?)').run(binding.id, missionId, digest, JSON.stringify(binding))
      return this.state(missionId)
    })
  }
  private ingest(binding: StoredBinding, message: ConversationMessage): void {
    if (!message.human || !binding.senders.includes(message.sender) || Date.parse(message.at) < Date.parse(binding.startsAt)) return
    const id = fingerprint({ conversation: conversationKey(binding.destination!), message: message.id })
    // Provider edits and listener replacement cannot re-execute an already admitted native message.
    if (this.record(id)) return
    if (Number(this.host.store.db.prepare('SELECT count(*) AS n FROM conversation_message').get()!.n) >= 50_000)
      throw new PublicationError(409, 'capacity', 'Inbound receipt capacity reached; retain deduplication history when archiving')
    const unsupported = !!message.problem || !message.text.trim(), triggerId = `conversation:${id}`
    const item: InboundRecord = { id, bindingId: binding.id, ticketId: binding.ticketId!, sender: message.sender, at: message.at, url: message.url,
      hash: fingerprint(message), status: unsupported ? 'unsupported' : 'received', ...(unsupported ? { problem: message.problem ?? 'empty_content' } : { triggerId }) }
    this.host.store.db.prepare('INSERT INTO conversation_message VALUES (?,?,?,?)').run(id, binding.id, binding.missionId, JSON.stringify(item))
    if (unsupported) { binding.unsupported++; return }
    const ticket = this.host.store.tickets.get(binding.ticketId!)!, origin = this.host.store.triggers.get(ticket.origin.triggerId)!
    const result = this.host.engine().receiveForTicket({ id: triggerId, source: SOURCE, actor: { source: SOURCE, id: message.sender },
      human: true, addressed: 'direct', at: message.at, threads: origin.threads, channel: origin.channel, text: message.text, url: message.url,
      meta: { inbound: id, mission: binding.missionId, label: `Reply from ${message.sender}` } }, ticket.id)
    if (result === 'filtered') throw new Error('External reply scope changed before delivery')
    binding.received++
  }
  poll(missionId: string, rescan = false): Promise<InboundState> {
    this.owner()
    const selected = this.latest(missionId)
    if (!selected || !this.active(selected)) return Promise.resolve(this.state(missionId))
    const running = this.pending.get(selected.id)
    if (running) return rescan ? running.then(() => this.poll(missionId, true)) : running
    const operation = (async () => {
      let binding = this.binding(selected.id)!
      if (Date.now() < Date.parse(binding.startsAt)) return this.state(missionId)
      if (rescan) { delete binding.cycle; binding.watermark = binding.startsAt; this.save(binding) }
      try {
        for (let count = 0; count < 4; count++) {
          this.owner(); binding = this.binding(selected.id)!
          if (!this.active(binding)) break
          binding.cycle ??= { since: binding.watermark, startedAt: timestamp(), seen: [] }; this.save(binding)
          const cycle = binding.cycle, destination = binding.destination!
          const page = ConversationPage.parse(await this.client!.call({ op: 'conversation.read', destination: destination.id, destinationHash: destination.hash,
            since: cycle.since, ...(cycle.cursor ? { cursor: cycle.cursor } : {}) }, AbortSignal.any([this.stopped.signal, this.host.lifetime])))
          this.owner()
          if (page.destination !== destination.id || page.destinationHash !== destination.hash) throw new Error('Conversation identity changed')
          this.host.store.atomic(() => {
            const current = this.binding(binding.id)!
            if (!this.active(current)) return
            if (page.next && (cycle.seen.includes(fingerprint(page.next)) || cycle.seen.length >= 1000)) throw new Error('Conversation cursor did not advance or exceeded its bound')
            for (const message of page.items) this.ingest(current, message)
            if (page.next) current.cycle = { ...cycle, cursor: page.next, seen: [...cycle.seen, fingerprint(page.next)] }
            else { delete current.cycle; current.watermark = new Date(Math.max(Date.parse(current.startsAt), Date.parse(cycle.startedAt) - 60_000)).toISOString() }
            current.lastPoll = timestamp(); current.nextPoll = Date.now() + 60_000; current.failures = 0; delete current.problem
            this.save(current); binding = current
          })
          this.host.requestPass()
          if (!page.next) break
        }
      } catch {
        // Re-read after transport so a concurrent revocation or replacement is never overwritten.
        binding = this.binding(selected.id)!
        binding.failures++; binding.nextPoll = Date.now() + Math.min(300_000, 60_000 * 2 ** Math.min(binding.failures - 1, 4))
        binding.problem = 'Conversation read failed; the original cursor is retained. Check the provider, permissions and ownership.'; this.save(binding)
      }
      return this.state(missionId)
    })().finally(() => this.pending.delete(selected.id))
    this.pending.set(selected.id, operation); return operation
  }
  start(): void {
    if (!this.client || this.timer) return
    this.timer = setInterval(() => {
      if (this.host.lifetime.aborted || this.stopped.signal.aborted || this.pending.size) return
      const bindings = this.host.store.db.prepare('SELECT value FROM conversation_binding WHERE json_extract(value,\'$.enabled\')=1 AND json_extract(value,\'$.revokedAt\') IS NULL ORDER BY json_extract(value,\'$.nextPoll\')').all()
      for (const row of bindings) { const binding: StoredBinding = JSON.parse(String(row.value)); if (binding.nextPoll <= Date.now() && this.active(binding)) { void this.poll(binding.missionId).catch(() => {}); break } }
    }, 1000)
  }
  async stop(): Promise<void> { clearInterval(this.timer); this.stopped.abort(); await Promise.allSettled([...this.pending.values()]) }
}
