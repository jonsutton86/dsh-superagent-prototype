import { z } from 'zod'
import { credentialDigest, privateCredential } from '../environments/endpoint-files.ts'
import { contentHash, publicationMarker, type PublicationAdapter, type PreparedPublication } from './github.ts'
import type { ConversationPage, ConversationRead, DestinationConfig, ExternalReceipt, Publication } from './protocol.ts'

type FeishuDestination = Extract<DestinationConfig, { kind: 'feishu-reply' }>
const Message = z.looseObject({ message_id: z.string(), chat_id: z.string(), parent_id: z.string().optional(), root_id: z.string().optional(),
  thread_id: z.string().optional(), msg_type: z.string(), deleted: z.boolean().optional(),
  sender: z.looseObject({ id: z.string(), id_type: z.string(), sender_type: z.string(), open_bot_id: z.string().optional() }).optional(),
  body: z.looseObject({ content: z.string() }).optional() })
const text = (publication: Publication) => `${publication.text}\n\n[${publicationMarker(publication)}]`

/** Fixed-origin self-built Feishu/Lark bot replies; tokens stay in memory and ambiguous sends are never automatically replayed. */
export class FeishuPublication implements PublicationAdapter {
  private readonly pins = new Map<string, string>()
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async request(destination: FeishuDestination, path: string, signal: AbortSignal, token?: string, data?: object): Promise<Record<string, unknown>> {
    const origin = destination.brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
    const response = await this.fetcher(origin + '/open-apis/' + path, { method: data ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) })
    if (!response.body) throw new Error('Feishu returned no response body')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length
      if (bytes > 2 * 1024 * 1024) throw new Error('Feishu response exceeds its bound'); chunks.push(next.value) }
    } finally { await reader.cancel() }
    const result = z.looseObject({ code: z.number() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    // A nonzero provider code after send remains unknown unless independent reconciliation establishes non-delivery.
    if (!response.ok || result.code !== 0) throw new Error('Feishu refused the request or returned an uncertain result')
    return result
  }
  private async token(destination: FeishuDestination, signal: AbortSignal): Promise<string> {
    const secret = privateCredential(destination.credentialFile, this.pins.get(destination.credentialFile))
    this.pins.set(destination.credentialFile, credentialDigest(secret))
    const result = await this.request(destination, 'auth/v3/tenant_access_token/internal', signal, undefined, { app_id: destination.appId, app_secret: secret })
    return z.string().min(20).max(4096).parse(result.tenant_access_token)
  }
  private async parent(destination: FeishuDestination, token: string, signal: AbortSignal) {
    const result = await this.request(destination, `im/v1/messages/${destination.messageId}?user_id_type=open_id`, signal, token)
    const { items } = z.object({ items: z.array(Message) }).parse(result.data)
    const parent = items.find(value => value.message_id === destination.messageId && value.chat_id === destination.chatId && !value.deleted)
    if (!parent || parent.root_id && parent.root_id !== parent.message_id) throw new Error('Feishu destination must name an existing root message in the pinned chat')
    return parent
  }
  private receipt(destination: FeishuDestination, publication: Publication, input: unknown): ExternalReceipt | undefined {
    const value = Message.safeParse(input); if (!value.success) return
    const message = value.data, sender = message.sender
    if (message.deleted || message.chat_id !== destination.chatId || message.parent_id !== destination.messageId
      || message.msg_type !== 'text' || !sender || sender.sender_type !== 'app'
      || sender.id_type !== 'app_id' || sender.id !== destination.appId || sender.open_bot_id && sender.open_bot_id !== destination.botId) return
    let content: unknown; try { content = JSON.parse(message.body?.content ?? '') } catch { return }
    const parsed = z.object({ text: z.string() }).safeParse(content)
    if (!parsed.success || parsed.data.text !== text(publication) || !/^om_[A-Za-z0-9]+$/.test(message.message_id)) return
    return { id: message.message_id, bodyHash: contentHash(parsed.data.text),
      url: `https://applink.${destination.brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${destination.chatId}` }
  }
  private async preflight(destination: FeishuDestination, signal: AbortSignal): Promise<string> {
    const token = await this.token(destination, signal)
    const bot = await this.request(destination, 'bot/v3/info', signal, token)
    if (z.object({ open_id: z.string() }).parse(bot.bot).open_id !== destination.botId) throw new Error('Feishu bot identity differs from the pinned account')
    await this.parent(destination, token, signal)
    privateCredential(destination.credentialFile, this.pins.get(destination.credentialFile))
    return token
  }
  async check(destination: DestinationConfig, signal: AbortSignal): Promise<void> {
    if (destination.kind !== 'feishu-reply') throw new Error('Feishu destination required')
    await this.preflight(destination, signal)
  }
  async prepare(destination: DestinationConfig, publication: Publication, signal: AbortSignal): Promise<PreparedPublication> {
    if (destination.kind !== 'feishu-reply') throw new Error('Feishu destination required')
    const token = await this.preflight(destination, signal)
    return { send: async signal => {
      const result = await this.request(destination, `im/v1/messages/${destination.messageId}/reply`, signal, token,
        { msg_type: 'text', content: JSON.stringify({ text: text(publication) }), reply_in_thread: true, uuid: publication.id })
      const receipt = this.receipt(destination, publication, result.data)
      if (!receipt) throw new Error('Feishu did not confirm the exact message, account and destination')
      return receipt
    } }
  }
  async observe(destination: DestinationConfig, publication: Publication, signal: AbortSignal, externalId?: string): Promise<ExternalReceipt | undefined> {
    if (destination.kind !== 'feishu-reply') throw new Error('Feishu destination required')
    const token = await this.token(destination, signal)
    if (externalId) {
      if (!/^om_[A-Za-z0-9]+$/.test(externalId)) throw new Error('Feishu message ID required')
      const result = await this.request(destination, `im/v1/messages/${externalId}?user_id_type=open_id`, signal, token)
      const { items } = z.object({ items: z.array(z.unknown()) }).parse(result.data)
      return items.flatMap(value => { const receipt = this.receipt(destination, publication, value); return receipt && receipt.id === externalId ? [receipt] : [] })[0]
    }
    const parent = await this.parent(destination, token, signal)
    let cursor = ''; const seen = new Set<string>()
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ container_id_type: parent.thread_id ? 'thread' : 'chat', container_id: parent.thread_id || destination.chatId,
        page_size: '50', sort_type: 'ByCreateTimeDesc', ...(cursor ? { page_token: cursor } : {}) })
      const result = await this.request(destination, `im/v1/messages?${query}`, signal, token)
      const list = z.object({ items: z.array(z.unknown()), has_more: z.boolean(), page_token: z.string().optional() }).parse(result.data)
      const matches = list.items.flatMap(value => { const receipt = this.receipt(destination, publication, value); return receipt ? [receipt] : [] })
      if (matches.length > 1) throw new Error('Multiple Feishu messages match the original publication')
      if (matches[0]) return matches[0]
      if (!list.has_more) return
      if (!list.page_token || seen.has(list.page_token)) throw new Error('Feishu pagination did not advance')
      cursor = list.page_token; seen.add(cursor)
    }
    throw new Error('Feishu observation reached its page limit; supply the external message ID')
  }

  /** Read only messages in the pinned root conversation, preserving unsupported content as an explicit non-executable record. */
  async read(destination: DestinationConfig, request: ConversationRead, signal: AbortSignal): Promise<ConversationPage> {
    if (destination.kind !== 'feishu-reply') throw new Error('Feishu destination required')
    const token = await this.token(destination, signal), parent = await this.parent(destination, token, signal)
    const query = new URLSearchParams({ container_id_type: parent.thread_id ? 'thread' : 'chat', container_id: parent.thread_id || destination.chatId,
      page_size: '10', sort_type: 'ByCreateTimeAsc', start_time: String(Math.floor(Date.parse(request.since) / 1000)),
      ...(request.cursor ? { page_token: request.cursor } : {}) })
    const response = await this.request(destination, `im/v1/messages?${query}`, signal, token)
    const page = z.object({ items: z.array(Message.extend({ create_time: z.string().regex(/^[0-9]{10,16}$/) })).max(10),
      has_more: z.boolean(), page_token: z.string().min(1).max(4096).optional() }).parse(response.data)
    if (page.has_more && (!page.page_token || page.page_token === request.cursor)) throw new Error('Feishu cursor did not advance')
    const items = page.items.filter(row => !row.deleted && row.chat_id === destination.chatId && row.message_id !== destination.messageId
      && (row.root_id === destination.messageId || row.parent_id === destination.messageId) && Number(row.create_time) >= Date.parse(request.since)).map(row => {
      let text = '', problem: 'unsupported_content' | 'content_too_large' | undefined
      try {
        if (row.msg_type !== 'text') throw new Error('Unsupported content')
        text = z.object({ text: z.string() }).parse(JSON.parse(row.body?.content ?? '')).text
        if (text.length > 16_000) { text = ''; problem = 'content_too_large' }
      } catch { problem = 'unsupported_content' }
      const sender = row.sender
      return { id: row.message_id, sender: sender?.id ?? 'unknown', human: sender?.sender_type === 'user' && sender.id_type === 'open_id'
        && /^ou_[A-Za-z0-9]+$/.test(sender.id), at: new Date(Number(row.create_time)).toISOString(), text,
        url: `https://applink.${destination.brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${destination.chatId}`,
        ...(problem ? { problem } : {}) }
    })
    return { destination: request.destination, destinationHash: request.destinationHash, items, ...(page.has_more ? { next: page.page_token! } : {}) }
  }
}
