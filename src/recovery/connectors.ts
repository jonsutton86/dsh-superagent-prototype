/** Validate retained built-in connector state without polling, admitting messages or moving a cursor. */
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { KV } from '../kv.ts'
import { fingerprint } from '../remote/journal.ts'
import { conversationKey } from '../publication/inbound.ts'
import { ConversationMessage, DestinationView, Digest, ExternalReceipt, PublicationId } from '../publication/protocol.ts'
import type { Trigger, TriggerDisposition, Ticket } from '../core/index.ts'

const id = z.string().min(1).max(4096), at = z.iso.datetime({ offset: true }), count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const strings = z.array(id).max(100000).refine(value => new Set(value).size === value.length)
const timestamps = z.record(id, at).refine(value => Object.keys(value).length <= 100000)
const destination = DestinationView.refine(value => value.kind !== 'github-pr-review')
const bindingSchema = z.looseObject({ id: PublicationId, missionId: PublicationId, revision: count.min(1), enabled: z.boolean(),
  grantId: PublicationId.optional(), ticketId: id.optional(), destination: destination.optional(), senders: strings.max(100),
  startsAt: at, revokedAt: at.optional(), lastPoll: at.optional(), problem: z.string().max(8192).optional(), received: count, unsupported: count,
  nextPoll: count, failures: count, watermark: at, cycle: z.looseObject({ since: at, startedAt: at, cursor: z.string().min(1).max(4096).optional(),
    seen: z.array(Digest).max(1000).refine(value => new Set(value).size === value.length) }).optional() })
const messageSchema = z.looseObject({ id: Digest, nativeId: ExternalReceipt.shape.id.optional(), bindingId: PublicationId, ticketId: id, sender: id, at, url: z.string().max(4096), hash: Digest,
  status: z.enum(['received', 'unsupported']), triggerId: id.optional(), problem: z.string().max(8192).optional() })
const grantSchema = z.looseObject({ id: PublicationId, missionId: PublicationId, revision: count.min(1), planVersion: count.min(1),
  enabled: z.boolean(), createdAt: at, revokedAt: at.optional(), destination: destination.optional() })
type Binding = z.infer<typeof bindingSchema>
export interface ConnectorStateVerification {
  version: 1; records: number; github: number; feishu: number; bindings: number; messages: number; nativeMessages: number; legacyMessages: number; cycles: number; digest: string
}
/** Connector diagnostics expose a relation code and bounded identity, never cursor contents or message text. */
export class ConnectorStateError extends Error {
  constructor(readonly code: string, readonly record: string) { super(`recovery_connector_${code}: ${record.slice(0, 200)}`) }
}

/** Requires an exclusively held prepared Store; provider cursors and message receipts remain byte-for-byte unchanged. */
export async function verifyConnectorState(db: DatabaseSync, signal: AbortSignal): Promise<ConnectorStateVerification> {
  function fail(code: string, record: string): never { throw new ConnectorStateError(code, record) }
  const hash = createHash('sha256'), tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
  let records = 0, bytes = 0, github = 0, feishu = 0, messages = 0, nativeMessages = 0, legacyMessages = 0, cycles = 0, ticks = 0
  const checkpoint = async () => { signal.throwIfAborted(); if (++ticks % 64 === 0) await setImmediate(undefined, { signal }) }
  const decode = (row: Record<string, unknown>, label: string): unknown => {
    signal.throwIfAborted(); const size = Buffer.byteLength(String(row.value)); bytes += size
    if (++records > 250000 || size > 4 * 1024 * 1024 || bytes > 128 * 1024 * 1024) fail('limit', label)
    let value: unknown
    try { value = JSON.parse(String(row.value)) } catch { fail('shape', label) }
    hash.update(JSON.stringify([label, row]) + '\n'); return value
  }
  const parse = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
    const result = schema.safeParse(value); if (!result.success) fail('shape', label); return result.data
  }
  const same = (left: unknown, right: unknown, label: string) => { if (!isDeepStrictEqual(left, right)) fail('conflict', label) }
  const cache = new Map<string, Record<string, unknown>>()
  const reference = <T>(table: string, key: string): T => {
    const label = `${table}:${key}`
    if (!cache.has(label)) {
      if (!tables.has(table)) fail('reference', label)
      const column = table === 'thread' ? 'key' : 'id', row = db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).get(key)
      if (!row) fail('reference', label)
      const value = parse(z.record(z.string(), z.unknown()), decode(row, label), label)
      if (table !== 'disposition') same(value[column], key, label)
      if (table === 'delivery_grant') { same(value.missionId, row.mission, label); parse(Digest, row.fingerprint, label) }
      cache.set(label, value)
    }
    return cache.get(label) as T
  }
  // Select only connector-owned keys; unrelated settings, maintenance intents and custom plugin values stay opaque.
  const exact = [KV.github.since, KV.github.retries, KV.github.branchCi, KV.feishu.chats]
  const prefixes = [KV.github.cursor, KV.github.ci, KV.github.stream, KV.feishu.history, KV.feishu.topics, KV.feishu.seen, KV.feishu.initialized].map(family => family.prefix)
  const selected = `SELECT key,value FROM kv WHERE key IN (${exact.map(() => '?').join(',')}) OR ${prefixes.map(() => 'substr(key,1,length(?))=?').join(' OR ')} ORDER BY key`
  for (const row of db.prepare(selected).iterate(...exact, ...prefixes.flatMap(prefix => [prefix, prefix]))) {
    await checkpoint()
    const key = String(row.key)
    let schema: z.ZodType | undefined, owner: 'github' | 'feishu' | undefined, thread: string | undefined
    if (key === KV.github.since) { owner = 'github'; schema = at }
    else if (key === KV.github.retries) { owner = 'github'; schema = z.record(z.string().regex(/^[1-9]\d*$/), z.looseObject({ since: at, pr: z.boolean(), failedAt: at.optional(), attempts: count.optional() })) }
    else if (key === KV.github.branchCi) { owner = 'github'; schema = z.looseObject({ branch: id.optional(), failures: z.array(z.string().max(4096)).max(100000).optional(), revision: count }) }
    else if (key.startsWith(KV.github.cursor.prefix) || key.startsWith(KV.github.ci.prefix)) {
      owner = 'github'; const cursor = key.startsWith(KV.github.cursor.prefix), suffix = key.slice((cursor ? KV.github.cursor : KV.github.ci).prefix.length)
      if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) fail('key', 'github-item')
      schema = cursor ? at : z.looseObject({ fingerprint: id, revision: count })
    } else if (key.startsWith(KV.github.stream.prefix)) {
      owner = 'github'; parse(id, key.slice(KV.github.stream.prefix.length), 'github-stream')
      schema = z.looseObject({ since: at, started: timestamps, etag: z.string().max(8192).optional() })
    } else if (key === KV.feishu.chats) { owner = 'feishu'; schema = z.record(id, z.boolean()) }
    else if (key.startsWith(KV.feishu.history.prefix) || key.startsWith(KV.feishu.topics.prefix)) {
      owner = 'feishu'; const topics = key.startsWith(KV.feishu.topics.prefix)
      parse(id, key.slice((topics ? KV.feishu.topics : KV.feishu.history).prefix.length), 'feishu-chat')
      schema = topics ? timestamps : at
    } else if (key.startsWith(KV.feishu.seen.prefix) || key.startsWith(KV.feishu.initialized.prefix)) {
      owner = 'feishu'; const seen = key.startsWith(KV.feishu.seen.prefix)
      thread = key.slice((seen ? KV.feishu.seen : KV.feishu.initialized).prefix.length)
      parse(id, thread, 'feishu-thread'); schema = seen ? strings : z.boolean()
    }
    if (!schema || !owner) continue
    parse(schema, decode(row, key), key); if (owner === 'github') github++; else feishu++
    if (thread) same(reference<{ ref?: { source?: string } }>('thread', thread).ref?.source, 'feishu', 'feishu-thread')
  }
  const bindings = new Map<string, Binding>(), latest = new Map<string, Binding>(), conversations = new Set<string>()
  if (tables.has('conversation_binding')) for (const row of db.prepare('SELECT rowid,* FROM conversation_binding ORDER BY rowid').iterate()) {
    await checkpoint()
    const label = `binding:${row.id}`, value = parse(bindingSchema, decode(row, label), label)
    same(value.id, row.id, label); same(value.missionId, row.mission, label); parse(Digest, row.fingerprint, label)
    const prior = latest.get(value.missionId)
    if (value.revision !== (prior?.revision ?? 0) + 1 || prior && !prior.revokedAt) fail('binding_revision', value.id)
    latest.set(value.missionId, value); bindings.set(value.id, value)
    const mission = parse(z.looseObject({ id: PublicationId, planVersion: count.min(1) }), reference('workspace_mission', value.missionId), label)
    if (Date.parse(value.watermark) < Date.parse(value.startsAt)) fail('watermark', value.id)
    if (value.cycle) {
      cycles++; same(value.cycle.since, value.watermark, `cycle:${value.id}`)
      if (value.cycle.cursor ? value.cycle.seen.at(-1) !== fingerprint(value.cycle.cursor) : value.cycle.seen.length > 0) fail('cycle', value.id)
    }
    if (value.enabled) {
      if (!value.ticketId || !value.grantId || !value.destination || !value.senders.length) fail('binding_authority', value.id)
      const grant = parse(grantSchema, reference('delivery_grant', value.grantId), `grant:${value.grantId}`)
      same(grant.missionId, value.missionId, `grant:${value.id}`); same(grant.destination, value.destination, `destination:${value.id}`)
      const { hash: destinationHash, ...metadata } = value.destination
      same(destinationHash, fingerprint(metadata), `destination_hash:${value.id}`)
      if (!grant.enabled || grant.planVersion > mission.planVersion) fail('binding_authority', value.id)
      const ticket = reference<Ticket>('ticket', value.ticketId), origin = reference<Trigger>('trigger', ticket.origin?.triggerId ?? '')
      if (origin.meta?.mission !== value.missionId || origin.channel?.source !== 'publication' || origin.channel.address.grantId !== grant.id) fail('binding_authority', value.id)
      const pattern = value.destination.kind === 'feishu-reply' ? /^ou_[A-Za-z0-9]+$/ : /^[a-z0-9-]+$/
      if (value.senders.some(sender => !pattern.test(sender))) fail('participants', value.id)
      if (!value.revokedAt) {
        const identity = conversationKey(value.destination)
        if (conversations.has(identity)) fail('conversation_overlap', value.id)
        conversations.add(identity)
      }
    } else if (value.ticketId || value.grantId || value.destination || value.cycle) fail('binding_authority', value.id)
  }
  const totals = new Map<string, { received: number; unsupported: number }>()
  if (tables.has('conversation_message')) for (const row of db.prepare('SELECT rowid,* FROM conversation_message ORDER BY rowid').iterate()) {
    await checkpoint(); messages++
    const label = `message:${row.id}`, value = parse(messageSchema, decode(row, label), label), binding = bindings.get(value.bindingId)
    same(value.id, row.id, label); same(value.bindingId, row.binding, label)
    if (!binding || !binding.enabled || !binding.senders.includes(value.sender) || Date.parse(value.at) < Date.parse(binding.startsAt)) fail('message_authority', value.id)
    same(binding.missionId, row.mission, label); same(value.ticketId, binding.ticketId, label)
    if (value.nativeId) {
      nativeMessages++; same(value.id, fingerprint({ conversation: conversationKey(binding.destination!), message: value.nativeId }), `native_identity:${value.id}`)
    } else legacyMessages++
    const tally = totals.get(binding.id) ?? { received: 0, unsupported: 0 }; tally[value.status]++; totals.set(binding.id, tally)
    if (value.status === 'received') {
      same(value.triggerId, `conversation:${value.id}`, label)
      const trigger = reference<Trigger>('trigger', value.triggerId!), disposition = reference<TriggerDisposition>('disposition', value.triggerId!)
      const ticket = reference<Ticket>('ticket', value.ticketId), origin = reference<Trigger>('trigger', ticket.origin.triggerId)
      if (trigger.source !== 'conversation' || !trigger.human || trigger.addressed !== 'direct' || trigger.actor?.source !== 'conversation'
        || trigger.actor.id !== value.sender || trigger.meta?.inbound !== value.id || trigger.meta?.mission !== binding.missionId
        || disposition.filtered || disposition.recipient !== ticket.id) fail('message_authority', value.id)
      same(trigger.threads, origin.threads, label); same(trigger.channel, origin.channel, label)
      same(Date.parse(trigger.at), Date.parse(value.at), label); same(trigger.url, value.url, label)
      if (value.nativeId) {
        const message = parse(ConversationMessage, { id: value.nativeId, sender: value.sender, human: true, at: value.at, text: trigger.text, url: value.url }, label)
        same(value.hash, fingerprint(message), `native_content:${value.id}`)
      }
    } else if (value.triggerId || !value.problem) fail('unsupported', value.id)
  }
  for (const binding of bindings.values()) {
    await checkpoint(); const tally = totals.get(binding.id) ?? { received: 0, unsupported: 0 }
    if (tally.received !== binding.received || tally.unsupported !== binding.unsupported) fail('message_count', binding.id)
  }
  // Every admitted conversation trigger needs its original deduplication receipt, not merely a plausible actor/channel.
  for (const row of db.prepare("SELECT id,value FROM trigger WHERE json_extract(value,'$.source')='conversation' ORDER BY id").iterate()) {
    await checkpoint(); const trigger = parse(z.looseObject({ id, meta: z.looseObject({ inbound: Digest }) }), decode(row, `inbound-trigger:${row.id}`), 'inbound-trigger')
    const receipt = reference<z.infer<typeof messageSchema>>('conversation_message', trigger.meta.inbound)
    if (receipt.status !== 'received' || receipt.triggerId !== trigger.id) fail('trigger_receipt', trigger.id)
  }
  signal.throwIfAborted()
  return { version: 1, records, github, feishu, bindings: bindings.size, messages, nativeMessages, legacyMessages, cycles, digest: hash.digest('hex') }
}
