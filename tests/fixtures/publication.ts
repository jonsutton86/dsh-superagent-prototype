import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { PublicationService } from '../../src/publication/service.ts'
import { publicationHandler } from '../../src/publication/http.ts'
import { PublicationProviders } from '../../src/publication/providers.ts'
import { PublicationClient } from '../../src/publication/client.ts'
import type { OwnershipAccess } from '../../src/ownership/protocol.ts'
import type { ResourceOwnershipConfig } from '../../src/ownership/gate.ts'
import type { DestinationConfig } from '../../src/publication/protocol.ts'

/** Real HTTP at both boundaries, with local GitHub and Feishu/Lark contract servers; never publishes to an external account. */
export async function publicationFixture(cleanup: (() => Promise<unknown>)[], ownership: ResourceOwnershipConfig, access?: OwnershipAccess, kind: DestinationConfig['kind'] = 'github-comment') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-publication-'))), credentialFile = join(directory, 'account.token')
  const secret = randomBytes(32).toString('base64url'); await writeFile(credentialFile, secret, { mode: 0o600 })
  const comments: { id: number; body: string; user: { login: string; type?: string }; created_at?: string; issue_url: string; pull_request_url?: string; in_reply_to_id?: number }[] = []
  const messages: Record<string, unknown>[] = [], tenantToken = randomBytes(32).toString('base64url')
  let botId = 'ou_bot', parentChat = 'oc_chat'
  let loseProviderReply: boolean | string = false
  const shouldLose = (body: string) => loseProviderReply === true || typeof loseProviderReply === 'string' && body.includes(`dsh-publication:${loseProviderReply}:`)
  let posts = 0, reads = 0, inspections = 0, refuse = false, unavailable = false, login = 'agent-bot', hold: Promise<void> | undefined, prepareHold: Promise<void> | undefined, readHold: Promise<void> | undefined
  const provider = createServer((req, res) => { void (async () => {
    res.setHeader('content-type', 'application/json')
    const url = new URL(req.url!, 'http://127.0.0.1'), path = url.pathname
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.end(JSON.stringify(body.app_id === 'cli_agent' && body.app_secret === secret ? { code: 0, tenant_access_token: tenantToken, expire: 7200 } : { code: 1 })); return
    }
    if (path.startsWith('/open-apis/')) {
      if (req.headers.authorization !== `Bearer ${tenantToken}`) { res.writeHead(401); res.end('{"code":1}'); return }
      if (path === '/open-apis/bot/v3/info') { inspections++; await prepareHold; res.end(JSON.stringify({ code: 0, bot: { open_id: botId } })); return }
      if (path === '/open-apis/im/v1/messages/om_root') { res.end(JSON.stringify({ code: 0, data: { items: [{ message_id: 'om_root', chat_id: parentChat, msg_type: 'text', thread_id: 'omt_thread' }] } })); return }
      if (path === '/open-apis/im/v1/messages/om_root/reply') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
        posts++; await hold
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const message = { message_id: `om_reply${messages.length + 1}`, chat_id: parentChat, parent_id: 'om_root', root_id: 'om_root', thread_id: 'omt_thread',
          create_time: String(Date.now()), msg_type: body.msg_type, body: { content: body.content }, sender: { id: 'cli_agent', id_type: 'app_id', sender_type: 'app', open_bot_id: botId } }
        messages.push(message)
        if (shouldLose(body.content)) { loseProviderReply = false; res.destroy(); return }
        res.end(JSON.stringify({ code: 0, data: message })); return
      }
      if (path === '/open-apis/im/v1/messages') {
        reads++; await readHold
        const size = Number(url.searchParams.get('page_size') ?? 50), offset = Number(url.searchParams.get('page_token') ?? 0)
        const since = Number(url.searchParams.get('start_time') ?? 0) * 1000, selected = messages.filter(row => !since || Number(row.create_time) >= since)
        res.end(JSON.stringify({ code: 0, data: { items: selected.slice(offset, offset + size), has_more: offset + size < selected.length,
          ...(offset + size < selected.length ? { page_token: String(offset + size) } : {}) } })); return
      }
      const message = messages.find(value => path.endsWith('/' + value.message_id))
      res.end(JSON.stringify({ code: 0, data: { items: message ? [message] : [] } })); return
    }
    if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); res.end('{}'); return }
    if (path === '/user') { inspections++; await prepareHold; res.end(JSON.stringify({ login })); return }
    if (path === '/repos/acme/project/issues/7') { res.end(JSON.stringify({ number: 7 })); return }
    if (path === '/repos/acme/project/pulls/comments/11') { res.end(JSON.stringify({ id: 11, body: 'Review question', user: { login: 'reviewer' }, pull_request_url: 'https://api.github.com/repos/acme/project/pulls/7' })); return }
    if (path === '/repos/acme/project/issues/7/comments' || path === '/repos/acme/project/pulls/7/comments' || path === '/repos/acme/project/pulls/7/comments/11/replies') {
      if (req.method === 'GET') {
        reads++; await readHold
        const size = Number(url.searchParams.get('per_page') ?? 100), offset = (Number(url.searchParams.get('page') ?? 1) - 1) * size
        const since = url.searchParams.get('since'), selected = comments.filter(row => !since || Date.parse(row.created_at ?? '') >= Date.parse(since))
        res.end(JSON.stringify(selected.slice(offset, offset + size))); return
      }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      posts++
      if (refuse) { res.writeHead(403); res.end('{}'); return }
      if (unavailable) { unavailable = false; res.writeHead(503); res.end('{}'); return }
      await hold
      const { body } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const comment = { id: comments.length + 1, body, user: { login, type: 'User' }, created_at: new Date().toISOString(), issue_url: 'https://api.github.com/repos/acme/project/issues/7',
        ...(path.includes('/pulls/') ? { pull_request_url: 'https://api.github.com/repos/acme/project/pulls/7', in_reply_to_id: 11 } : {}) }
      comments.push(comment)
      if (shouldLose(body)) { loseProviderReply = false; res.destroy(); return }
      res.writeHead(201); res.end(JSON.stringify(comment)); return
    }
    const match = /\/(?:issues|pulls)\/comments\/(\d+)$/.exec(path), comment = match && comments.find(value => value.id === Number(match[1]))
    if (comment) { res.end(JSON.stringify(comment)); return }
    res.writeHead(404); res.end('{}')
  })().catch(() => res.destroy()) })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input)); if (!['https://api.github.com', 'https://open.feishu.cn', 'https://open.larksuite.com'].includes(url.origin)) throw new Error('Unexpected publication origin')
    return fetch(origin + url.pathname + url.search, init)
  }
  const common = { id: 'project-updates', name: 'Project updates', maxBytes: 30_000, credentialFile }
  const destination: DestinationConfig = kind === 'feishu-reply' ? { ...common, kind, brand: 'feishu', appId: 'cli_agent', botId: 'ou_bot', chatId: 'oc_chat', messageId: 'om_root' }
    : { ...common, kind, repository: 'acme/project', issue: 7, login: 'agent-bot', ...(kind === 'github-review' ? { comment: 11 } : {}) } as DestinationConfig
  const config = { stateDir: join(directory, 'service'), ownership, destinations: [destination] }
  let service = new PublicationService(config, new PublicationProviders(fetcher)); service.start()
  let loseServiceReply = false
  const server = createServer((req, res) => {
    if (loseServiceReply) { loseServiceReply = false; res.end = (() => { res.destroy(); return res }) as typeof res.end }
    void publicationHandler(service)(req, res).catch(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const connection = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, serviceId: service.journal.id,
    credentialFile: join(directory, 'service/client.token'), timeoutMs: 3000 }
  cleanup.push(async () => {
    await service.close(); server.closeAllConnections(); provider.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))])
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, config, connection, destination, comments, messages, secret, providerOrigin: origin, get service() { return service }, get posts() { return posts }, get reads() { return reads }, get inspections() { return inspections },
    client: new PublicationClient(connection, access), admin: new PublicationClient({ ...connection, credentialFile: join(directory, 'service/admin.token') }, access),
    loseProviderReply: (id?: string) => { loseProviderReply = id ?? true }, loseServiceReply: () => { loseServiceReply = true },
    refuse: (value: boolean) => { refuse = value }, login: (value: string) => { login = value }, hold: (value?: Promise<void>) => { hold = value },
    holdPrepare: (value?: Promise<void>) => { prepareHold = value },
    unavailable: () => { unavailable = true },
    bot: (value: string) => { botId = value }, parentChat: (value: string) => { parentChat = value },
    holdRead: (value?: Promise<void>) => { readHold = value },
    receive: (sender: string, text: string, at = new Date().toISOString(), human = true) => {
      if (kind === 'feishu-reply') {
        const id = `om_inbound${messages.length + 1}`
        messages.push({ message_id: id, chat_id: parentChat, root_id: 'om_root', parent_id: 'om_root', msg_type: 'text', create_time: String(Date.parse(at)),
          body: { content: JSON.stringify({ text }) }, sender: { id: sender, id_type: human ? 'open_id' : 'app_id', sender_type: human ? 'user' : 'app' } })
        return id
      }
      const id = comments.length + 1
      comments.push({ id, body: text, created_at: at, user: { login: sender, type: human ? 'User' : 'Bot' }, issue_url: 'https://api.github.com/repos/acme/project/issues/7',
        ...(kind === 'github-review' ? { pull_request_url: 'https://api.github.com/repos/acme/project/pulls/7', in_reply_to_id: 11 } : {}) })
      return String(id)
    },
    restart: async (destinations = config.destinations) => {
      await service.close(); config.destinations = destinations
      service = new PublicationService(config, new PublicationProviders(fetcher)); service.start()
    },
  }
}
