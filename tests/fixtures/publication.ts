import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { PublicationService } from '../../src/publication/service.ts'
import { publicationHandler } from '../../src/publication/http.ts'
import { GithubPublication } from '../../src/publication/github.ts'
import { PublicationClient } from '../../src/publication/client.ts'
import type { OwnershipAccess } from '../../src/ownership/protocol.ts'
import type { ResourceOwnershipConfig } from '../../src/ownership/gate.ts'
import type { DestinationConfig } from '../../src/publication/protocol.ts'

/** Real HTTP at both boundaries, with a local GitHub contract server; never publishes to an external account. */
export async function publicationFixture(cleanup: (() => Promise<unknown>)[], ownership: ResourceOwnershipConfig, access?: OwnershipAccess) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-publication-'))), credentialFile = join(directory, 'account.token')
  const secret = randomBytes(32).toString('base64url'); await writeFile(credentialFile, secret, { mode: 0o600 })
  const comments: { id: number; body: string; user: { login: string }; issue_url: string }[] = []
  let posts = 0, loseProviderReply = false, refuse = false, unavailable = false, login = 'agent-bot', hold: Promise<void> | undefined, prepareHold: Promise<void> | undefined
  const provider = createServer((req, res) => { void (async () => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); res.end('{}'); return }
    const path = new URL(req.url!, 'http://127.0.0.1').pathname
    if (path === '/user') { await prepareHold; res.end(JSON.stringify({ login })); return }
    if (path === '/repos/acme/project/issues/7') { res.end(JSON.stringify({ number: 7 })); return }
    if (path === '/repos/acme/project/issues/7/comments') {
      if (req.method === 'GET') { res.end(JSON.stringify(comments)); return }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      posts++
      if (refuse) { res.writeHead(403); res.end('{}'); return }
      if (unavailable) { unavailable = false; res.writeHead(503); res.end('{}'); return }
      await hold
      const { body } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const comment = { id: comments.length + 1, body, user: { login }, issue_url: 'https://api.github.com/repos/acme/project/issues/7' }
      comments.push(comment)
      if (loseProviderReply) { loseProviderReply = false; res.destroy(); return }
      res.writeHead(201); res.end(JSON.stringify(comment)); return
    }
    const match = /\/issues\/comments\/(\d+)$/.exec(path), comment = match && comments.find(value => value.id === Number(match[1]))
    if (comment) { res.end(JSON.stringify(comment)); return }
    res.writeHead(404); res.end('{}')
  })().catch(() => res.destroy()) })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input)); if (url.origin !== 'https://api.github.com') throw new Error('Unexpected publication origin')
    return fetch(origin + url.pathname + url.search, init)
  }
  const destination: DestinationConfig = { id: 'project-updates', name: 'Project updates', kind: 'github-comment', repository: 'acme/project', issue: 7,
    login: 'agent-bot', maxBytes: 30_000, credentialFile }
  const config = { stateDir: join(directory, 'service'), ownership, destinations: [destination] }
  let service = new PublicationService(config, new GithubPublication(fetcher)); service.start()
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
  return { directory, config, connection, destination, comments, secret, providerOrigin: origin, get service() { return service }, get posts() { return posts },
    client: new PublicationClient(connection, access), admin: new PublicationClient({ ...connection, credentialFile: join(directory, 'service/admin.token') }, access),
    loseProviderReply: () => { loseProviderReply = true }, loseServiceReply: () => { loseServiceReply = true },
    refuse: (value: boolean) => { refuse = value }, login: (value: string) => { login = value }, hold: (value?: Promise<void>) => { hold = value },
    holdPrepare: (value?: Promise<void>) => { prepareHold = value },
    unavailable: () => { unavailable = true },
    restart: async () => { await service.close(); service = new PublicationService(config, new GithubPublication(fetcher)); service.start() },
  }
}
