import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Store } from '../app/store.ts'
import type { ChannelRef, OutboundMessage, Ticket } from '../core/index.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { Mission, MissionAction, MissionView } from '../workspace/model.ts'
import type { CoordinatorOwnership } from '../ownership/lease.ts'
import type { OwnershipStamp } from '../ownership/protocol.ts'
import { sameOwner } from '../ownership/gate.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { PublicationClient, type PublicationConnection } from './client.ts'
import { contentHash } from './github.ts'
import { Digest, PublicationId, PublicationReceipt, PublicationError, type DestinationView, type Publication } from './protocol.ts'

export const ConfigureDelivery = z.object({ requestId: PublicationId, revision: z.number().int().nonnegative(), missionRevision: z.number().int().positive(),
  enabled: z.boolean(), destination: z.string().max(100).optional(), destinationHash: Digest.optional() }).strict()
  .refine(value => !value.enabled || !!value.destination && !!value.destinationHash, 'Select an exact destination when enabling delivery')
export type ConfigureDelivery = z.infer<typeof ConfigureDelivery>
export interface DeliveryGrant { id: string; missionId: string; revision: number; planVersion: number; enabled: boolean; createdAt: string; revokedAt?: string; destination?: DestinationView }
export interface ChannelDelivery { id: string; messageId: string; ticketId: string; missionId: string; grantId: string; destination: string; createdAt: string;
  phase: 'pending' | 'unknown' | 'observed'; withdrawn?: boolean; receipt?: PublicationReceipt; problem?: string }
interface StoredDelivery extends ChannelDelivery { publication: Publication; original: OutboundMessage; attempts: OwnershipStamp[] }
export interface MissionDelivery { configured: boolean; grant?: DeliveryGrant; current: boolean; items: ChannelDelivery[] }
interface Host {
  store: Store; ownership?: CoordinatorOwnership; connection?: PublicationConnection; lifetime: AbortSignal;
  mission(id: string): MissionView; destinations(): Promise<{ configured: boolean; items: DestinationView[] }>;
  authorized(ticket: Ticket): boolean
}
const view = ({ publication: _, original: __, attempts: ___, ...item }: StoredDelivery): ChannelDelivery => item

/** Standing operator authority for exact mission plans, with immutable channel intents and original-receipt outbox recovery. */
export class ChannelPublications {
  private readonly client?: PublicationClient
  private readonly stopped = new AbortController()
  private readonly pending = new Map<string, Promise<ChannelDelivery>>()
  constructor(private readonly host: Host) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS delivery_grant (id TEXT PRIMARY KEY, mission TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delivery_grant_mission ON delivery_grant(mission);
      CREATE TABLE IF NOT EXISTS channel_publication (id TEXT PRIMARY KEY, message TEXT NOT NULL UNIQUE, mission TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_publication_mission ON channel_publication(mission);`)
    if (host.connection) this.client = new PublicationClient(host.connection, host.ownership)
  }
  readonly source: SourceKind = { kind: 'publication', title: { en: 'Mission delivery', zh: '任务交付' },
    description: { en: 'Replies to an operator-selected mission destination.', zh: '向用户指定的任务目标发送回复。' },
    schema: z.object({}).strict(), fields: [], health: [], scope: () => ({ listened: false, reason: 'Outbound-only mission channel' }),
    channel: { allowed: address => this.allowed(address.grantId ?? ''), send: async (_host, message) => {
      const result = await this.send(message)
      if (result === 'pending') throw new PublicationError(409, 'delivery_unknown', 'Delivery is unresolved; inspect its original receipt')
      return result
    }, link: address => ({ url: '', label: { en: `Mission delivery · ${address.destination ?? ''}`, zh: `任务交付 · ${address.destination ?? ''}` } }) } }
  private owner(): OwnershipStamp {
    this.host.lifetime.throwIfAborted(); this.stopped.signal.throwIfAborted(); this.host.ownership?.proof()
    const owner = this.host.ownership?.status().owner
    if (!owner || !this.client) throw new PublicationError(409, 'ownership_required', 'Mission delivery requires an owned coordinator and publication service')
    return owner
  }
  private grant(id: string): DeliveryGrant | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM delivery_grant WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as DeliveryGrant : undefined
  }
  private latest(missionId: string): DeliveryGrant | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM delivery_grant WHERE mission=? ORDER BY rowid DESC LIMIT 1').get(missionId)
    return row ? JSON.parse(String(row.value)) as DeliveryGrant : undefined
  }
  allowed(id: string): boolean {
    const grant = this.grant(id); if (!grant?.enabled || grant.revokedAt || !grant.destination) return false
    const mission = this.host.mission(grant.missionId), sources = this.host.store.settings().sources
    return mission.status === 'active' && mission.planVersion === grant.planVersion && sources.workspace?.enabled !== false && sources.publication?.enabled !== false
  }
  state(missionId: string): MissionDelivery {
    this.host.mission(missionId)
    const grant = this.latest(missionId), rows = this.host.store.db.prepare('SELECT value FROM channel_publication WHERE mission=? ORDER BY rowid DESC LIMIT 100').all(missionId)
    return { configured: !!this.client, ...(grant ? { grant } : {}), current: !!grant && this.allowed(grant.id), items: rows.map(row => view(JSON.parse(String(row.value)))) }
  }
  async configure(missionId: string, input: unknown): Promise<MissionDelivery> {
    const request = ConfigureDelivery.parse(input), digest = fingerprint({ missionId, ...request })
    this.owner()
    const old = this.host.store.db.prepare('SELECT fingerprint FROM delivery_grant WHERE id=?').get(request.requestId)
    if (old) { if (old.fingerprint !== digest) throw new PublicationError(409, 'intent_changed', 'Delivery request ID belongs to another configuration'); return this.state(missionId) }
    const destination = request.enabled ? (await this.host.destinations()).items.find(item => item.id === request.destination && item.hash === request.destinationHash) : undefined
    if (request.enabled && !destination) throw new PublicationError(409, 'destination_changed', 'Refresh and review the delivery destination')
    this.owner()
    return this.host.store.atomic(() => {
      const raced = this.host.store.db.prepare('SELECT fingerprint FROM delivery_grant WHERE id=?').get(request.requestId)
      if (raced) { if (raced.fingerprint !== digest) throw new PublicationError(409, 'intent_changed', 'Delivery request ID was reused'); return this.state(missionId) }
      const mission = this.host.mission(missionId), current = this.latest(missionId)
      if ((current?.revision ?? 0) !== request.revision || request.enabled && (mission.revision !== request.missionRevision || mission.status !== 'active'))
        throw new PublicationError(409, 'delivery_changed', 'Mission or delivery settings changed; review the current plan')
      if (request.enabled && mission.actions.some(action => action.ticket?.stoppable))
        throw new PublicationError(409, 'work_active', 'Configure delivery before starting work; stop active actions before changing their destination')
      const at = timestamp()
      if (current) { current.revokedAt = at; this.host.store.db.prepare('UPDATE delivery_grant SET value=? WHERE id=?').run(JSON.stringify(current), current.id) }
      const grant: DeliveryGrant = { id: request.requestId, missionId, revision: request.revision + 1, planVersion: mission.planVersion,
        enabled: request.enabled, createdAt: at, ...(destination ? { destination } : {}) }
      this.host.store.db.prepare('INSERT INTO delivery_grant VALUES (?,?,?,?)').run(grant.id, missionId, digest, JSON.stringify(grant))
      return this.state(missionId)
    })
  }
  channel(mission: Mission, _action: MissionAction): ChannelRef | undefined {
    const grant = this.latest(mission.id)
    if (!grant || !this.allowed(grant.id)) return
    return { source: 'publication', thread: `publication:${mission.id}:${grant.id}`, address: { grantId: grant.id, destination: grant.destination!.name } }
  }
  private find(messageId: string): StoredDelivery | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM channel_publication WHERE message=?').get(messageId)
    return row ? JSON.parse(String(row.value)) as StoredDelivery : undefined
  }
  private item(id: string): StoredDelivery {
    PublicationId.parse(id)
    const row = this.host.store.db.prepare('SELECT value FROM channel_publication WHERE id=?').get(id)
    if (!row) throw new PublicationError(404, 'delivery_missing', 'Channel delivery not found')
    return JSON.parse(String(row.value)) as StoredDelivery
  }
  private save(item: StoredDelivery): void { this.host.store.db.prepare('INSERT INTO channel_publication VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
    .run(item.id, item.messageId, item.missionId, JSON.stringify(item)) }
  private valid(message: OutboundMessage): DeliveryGrant {
    const grant = this.grant(message.channel.address.grantId ?? ''), ticket = message.ticketId ? this.host.store.tickets.get(message.ticketId) : undefined
    const origin = ticket ? this.host.store.triggers.get(ticket.origin.triggerId) : undefined
    if (!grant || !this.allowed(grant.id) || !ticket || ticket.ended?.by === 'human' || !this.host.authorized(ticket)
      || !origin?.channel || origin.meta.mission !== grant.missionId || fingerprint(origin.channel) !== fingerprint(message.channel))
      throw new PublicationError(409, 'delivery_revoked', 'This reply no longer has the mission’s exact delivery authority')
    return grant
  }
  private result(item: ChannelDelivery): 'sent' | 'gone' | 'pending' {
    return item.receipt?.phase === 'sent' ? 'sent' : ['failed', 'cancelled', 'not_delivered'].includes(item.receipt?.phase ?? '') ? 'gone' : 'pending'
  }
  private operation(item: StoredDelivery, dispatch: boolean): Promise<ChannelDelivery> {
    const running = this.pending.get(item.id); if (running) return running
    const operation = (async () => {
      try {
        const receipt = PublicationReceipt.parse(await this.client!.call(dispatch ? { op: 'publish', publication: item.publication } : { op: 'receipt.observe', id: item.id }, this.stopped.signal))
        if (receipt.id !== item.id || receipt.hash !== item.publication.hash || receipt.destinationHash !== item.publication.destinationHash
          || receipt.destination !== item.publication.destination || receipt.artifact || !receipt.message || fingerprint(receipt.message) !== fingerprint(item.publication.message)
          || !item.attempts.some(owner => sameOwner(owner, receipt.ownership))) throw new Error('Channel receipt does not belong to this intent')
        item.phase = 'observed'; item.receipt = receipt; delete item.problem
      } catch { item.phase = 'unknown'; item.problem = 'Delivery remains unresolved; inspect or retry the original request' }
      // Withdrawal may race an in-flight operation; never overwrite its durable prohibition on another dispatch.
      item.withdrawn ||= this.item(item.id).withdrawn; this.save(item)
      const result = this.result(item)
      if (result !== 'pending') this.host.store.receipts.settle(item.original, result === 'sent' ? 'sent' : 'channelGone')
      return view(item)
    })().finally(() => this.pending.delete(item.id))
    this.pending.set(item.id, operation); return operation
  }
  async send(message: OutboundMessage): Promise<'sent' | 'gone' | 'pending'> {
    const existing = this.find(message.id)
    if (existing) return this.result(await this.refresh(existing.id))
    const owner = this.owner(), grant = this.valid(message), destination = grant.destination!
    if (Buffer.byteLength(message.text) > destination.maxBytes || !message.text) throw new PublicationError(413, 'content_too_large', 'Reply exceeds the configured destination limit')
    const id = randomUUID(), item: StoredDelivery = { id, messageId: message.id, ticketId: message.ticketId!, missionId: grant.missionId, grantId: grant.id,
      destination: destination.id, createdAt: timestamp(), phase: 'pending', original: message, attempts: [owner], publication: {
        id, text: message.text, hash: contentHash(message.text), destination: destination.id, destinationHash: destination.hash,
        message: { id: message.id, ticketId: message.ticketId!, missionId: grant.missionId, grantId: grant.id, planVersion: grant.planVersion } } }
    this.save(item); return this.result(await this.operation(item, true))
  }
  /** An existing intent is observed before source/permission checks, so revocation cannot falsely erase an unknown send. */
  async observe(message: OutboundMessage): Promise<'sent' | 'gone' | 'pending' | undefined> {
    if (message.channel.source !== 'publication') return
    const item = this.find(message.id); if (!item) return
    return this.result(await this.refresh(item.id))
  }
  withdraw(messageId: string): boolean {
    const item = this.find(messageId); if (!item) return false
    item.withdrawn = true; this.save(item); return true
  }
  refresh(id: string): Promise<ChannelDelivery> { return this.operation(this.item(id), false) }
  retry(id: string): Promise<ChannelDelivery> {
    const item = this.item(id), owner = this.owner()
    if (item.withdrawn) throw new PublicationError(409, 'withdrawn', 'This reply was withdrawn; only receipt observation is allowed')
    this.valid(item.original)
    if (!item.attempts.some(old => sameOwner(old, owner))) {
      if (item.attempts.length >= 100) throw new PublicationError(409, 'attempt_limit', 'Channel delivery ownership attempt limit reached')
      item.attempts.push(owner); this.save(item)
    }
    return this.operation(item, true)
  }
  async stop(): Promise<void> { this.stopped.abort(); await Promise.allSettled([...this.pending.values()]) }
}
