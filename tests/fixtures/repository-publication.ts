/** Actual Git HTTPS push and HTTP PR contracts behind the independent publisher; all credentials are generated fixtures. */
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createServer } from 'node:http'
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { PublicationService } from '../../src/publication/service.ts'
import { publicationHandler } from '../../src/publication/http.ts'
import { PublicationClient } from '../../src/publication/client.ts'
import { GithubRepositoryPublication } from '../../src/publication/repository-provider.ts'
import { fingerprint } from '../../src/remote/journal.ts'
import { CoordinatorOwnership } from '../../src/ownership/lease.ts'
import type { RepositoryPublication, RepositoryTransfer, RepositoryTransferReceipt, RepositoryReceipt } from '../../src/publication/repository-model.ts'
import type { EvidenceSeal } from '../../src/verification/review-model.ts'
import { gitServer } from './git-server.ts'
import { ownershipAuthority } from './ownership-authority.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export async function repositoryPublicationFixture(cleanup: (() => Promise<unknown>)[]) {
  const authority = await ownershipAuthority(cleanup, ['publication']), owner = new CoordinatorOwnership(authority.config)
  const git = await gitServer(cleanup, { receive: true }), directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh repo publisher ')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const credentialFile = join(directory, 'account.token'); await writeFile(credentialFile, git.token, { mode: 0o600 })
  await writeFile(join(git.work, 'result.bin'), randomBytes(150000))
  await git.git('-C', git.work, 'add', '.'); await git.git('-C', git.work, 'commit', '--quiet', '-m', 'Reviewed original commit')
  const head = await git.git('-C', git.work, 'rev-parse', 'HEAD'), tree = await git.git('-C', git.work, 'rev-parse', 'HEAD^{tree}'), bundle = join(directory, 'source.bundle')
  await git.git('-C', git.work, 'bundle', 'create', bundle, 'HEAD', '^' + git.commit)
  const bytes = await readFile(bundle), artifact = { id: randomUUID(), revision: 1, hash: hash(Buffer.from('Reviewed result')) }
  const transfer: RepositoryTransfer = { id: randomUUID(), artifact, source: 'https://github.com/acme/project.git', bundle: { version: 1, base: git.commit, head, tree, bytes: bytes.length, sha256: hash(bytes) } }
  const destination = { id: 'repository', name: 'Project pull requests', repository: 'acme/project', repositoryId: 20, baseRef: 'main', login: 'agent-bot', credentialFile }
  const { credentialFile: _, ...metadata } = destination
  const selection = { runId: randomUUID(), evidenceHash: 'a'.repeat(64) }
  const publication: RepositoryPublication = { id: randomUUID(), destination: destination.id, destinationHash: fingerprint(metadata), transferId: transfer.id,
    transferHash: fingerprint(transfer), title: 'Reviewed change', body: 'Original result', draft: true, checks: [selection] }
  // Contract seals stand in for coordinator-produced evidence; export integration tests qualify actual check capture separately.
  const evidence = (): EvidenceSeal[] => {
    const now = new Date().toISOString()
    return [{ selection, artifact, check: { id: randomUUID(), version: 1, hash: 'b'.repeat(64) }, snapshotHash: 'c'.repeat(64),
      execution: { binding: 'd'.repeat(64), assignmentId: 'assignment', sessionId: 'worker' }, repository: { commit: head, tree, contentTree: tree, statusHash: hash(Buffer.alloc(0)) },
      confinement: 'linux-bubblewrap', checkedAt: now, capture: { id: randomUUID(), capturedAt: now, finishedAt: now }, validUntil: new Date(Date.now() + 60000).toISOString() }]
  }
  let posts = 0, losePull = false, refusePull = false, account = 'agent-bot', targetId = 20, beforePost: (() => Promise<void>) | undefined
  const pulls: Record<string, any>[] = []
  const provider = createServer((req, res) => { void (async () => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== 'Bearer ' + git.token) { res.writeHead(401); res.end('{}'); return }
    const url = new URL(req.url!, 'http://127.0.0.1'), path = url.pathname
    if (path === '/user') { res.end(JSON.stringify({ login: account })); return }
    if (path === '/repos/acme/project') { res.end(JSON.stringify({ id: targetId, full_name: 'acme/project', archived: false, disabled: false, permissions: { push: true } })); return }
    if (path.startsWith('/repos/acme/project/git/ref/heads/')) {
      const name = decodeURIComponent(path.slice('/repos/acme/project/git/ref/heads/'.length))
      try { const sha = await git.git('-C', git.bare, 'rev-parse', '--verify', 'refs/heads/' + name); res.end(JSON.stringify({ ref: 'refs/heads/' + name, object: { type: 'commit', sha } })) }
      catch { res.writeHead(404); res.end('{}') } return
    }
    if (path === '/repos/acme/project/pulls' && req.method === 'POST') {
      posts++; if (refusePull) { res.writeHead(403); res.end('{}'); return }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); await beforePost?.()
      const repo = { id: 20, full_name: 'acme/project' }, value = { id: 100 + pulls.length, number: pulls.length + 1, title: body.title, body: body.body,
        html_url: `https://github.com/acme/project/pull/${pulls.length + 1}`, user: { login: account },
        head: { repo, ref: body.head, sha: await git.git('-C', git.bare, 'rev-parse', 'refs/heads/' + body.head) },
        base: { repo, ref: body.base, sha: git.commit }, draft: body.draft, state: 'open', merged: false }
      pulls.push(value)
      if (losePull) { losePull = false; res.destroy(); return }
      res.writeHead(201); res.end(JSON.stringify(value)); return
    }
    if (path === '/repos/acme/project/pulls') {
      const offset = (Number(url.searchParams.get('page') ?? 1) - 1) * 100
      res.end(JSON.stringify(pulls.filter(value => !url.searchParams.get('head') || url.searchParams.get('head') === 'acme:' + value.head.ref).slice(offset, offset + 100))); return
    }
    const pull = pulls.find(value => path === '/repos/acme/project/pulls/' + value.number)
    if (pull) { res.end(JSON.stringify(pull)); return }
    res.writeHead(404); res.end('{}')
  })().catch(() => res.destroy()) })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + (provider.address() as { port: number }).port
  const fetcher: typeof fetch = (input, init) => { const url = new URL(String(input)); if (url.origin !== 'https://api.github.com') throw new Error('Unexpected repository origin'); return fetch(origin + url.pathname + url.search, init) }
  const ctx = new Context(), subprocess = new LocalSubprocessRuntime(ctx)
  const adapter = () => new GithubRepositoryPublication(subprocess, join(directory, 'service/imports'), fetcher, () => ({ url: git.url, caFile: git.certFile }))
  const config = { stateDir: join(directory, 'service'), ownership: authority.resource, destinations: [], repositories: [destination] }
  let service = new PublicationService(config, undefined, adapter()); service.start()
  let loseResponse: string | undefined
  const server = createServer((req, res) => {
    if (loseResponse) { const match = loseResponse; loseResponse = undefined; const end = res.end.bind(res)
      res.end = ((data: string) => { if (String(data).includes(match)) { res.destroy(); return res } return end(data) }) as typeof res.end }
    void publicationHandler(service)(req, res).catch(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const connection = { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, serviceId: service.journal.id,
    credentialFile: join(directory, 'service/client.token'), timeoutMs: 30000 }
  const client = new PublicationClient(connection, owner), admin = new PublicationClient({ ...connection, credentialFile: join(directory, 'service/admin.token') })
  cleanup.push(async () => { await owner.close(); await service.close(); server.closeAllConnections(); provider.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))]); await ctx.fiber.dispose() })
  await owner.start()
  const upload = async () => {
    let receipt = await client.call<RepositoryTransferReceipt>({ op: 'repository.transfer.begin', transfer })
    for (let offset = receipt.received; offset < bytes.length; offset += 65536) {
      const data = bytes.subarray(offset, offset + 65536)
      receipt = await client.call({ op: 'repository.transfer.chunk', id: transfer.id, offset, data: data.toString('base64'), hash: hash(data) })
    }
    return client.call<RepositoryTransferReceipt>({ op: 'repository.transfer.finish', id: transfer.id })
  }
  const prepare = () => client.call<{ prepared: boolean; receipt: RepositoryReceipt }>({ op: 'repository.prepare', publication })
  const publish = () => client.call<RepositoryReceipt>({ op: 'repository.publish', publication, evidence: evidence() })
  return { authority, owner, directory, ctx, git, bytes, transfer, publication, destination, evidence, upload, prepare, publish, client, admin, config, adapter,
    get service() { return service }, pulls, get posts() { return posts }, connection,
    losePull: () => { losePull = true }, refusePull: (value: boolean) => { refusePull = value },
    account: (value: string) => { account = value }, targetId: (value: number) => { targetId = value },
    beforePost: (value?: () => Promise<void>) => { beforePost = value }, loseReply: (marker: string) => { loseResponse = marker },
    restart: async () => { await service.close(); service = new PublicationService(config, undefined, adapter()); service.start() } }
}
