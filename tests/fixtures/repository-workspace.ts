/** Owned coordinator, real checks/export and independent publisher. Git/GitHub traffic remains on local contract servers. */
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { ownershipAuthority } from './ownership-authority.ts'
import { gitServer } from './git-server.ts'
import { remoteFixture } from './remote.ts'
import { startRuntime, type Host } from './host.ts'
import { PublicationService } from '../../src/publication/service.ts'
import { publicationHandler } from '../../src/publication/http.ts'
import { GithubRepositoryPublication } from '../../src/publication/repository-provider.ts'
import { PublicationClient } from '../../src/publication/client.ts'
import type { RepositoryDestinationConfig, RepositoryTransferReceipt } from '../../src/publication/repository-model.ts'
import { runAsWorker } from '../../src/infra/environment.ts'
import type { Session } from '@deepseek-ai/dsh-session'

const rid = () => randomUUID()
export async function repositoryWorkspaceFixture(cleanup: (() => Promise<unknown>)[], options: { captureSessions?: Map<string, Session> } = {}) {
  const authority = await ownershipAuthority(cleanup, ['endpoint', 'publication']), git = await gitServer(cleanup, { receive: true })
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-publication-')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const credentialFile = join(directory, 'account.token'); await writeFile(credentialFile, git.token, { mode: 0o600 })
  const destination: RepositoryDestinationConfig = { id: 'repository', name: 'Reviewed repository', repository: 'acme/project',
    repositoryId: 20, baseRef: 'main', login: 'agent-bot', credentialFile }
  let posts = 0, losePull = false
  const pulls: Record<string, any>[] = []
  const provider = createServer((req, res) => { void (async () => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== 'Bearer ' + git.token) { res.writeHead(401); res.end('{}'); return }
    const url = new URL(req.url!, 'http://127.0.0.1'), path = url.pathname
    if (path === '/user') { res.end(JSON.stringify({ login: destination.login })); return }
    if (path === '/repos/acme/project') { res.end(JSON.stringify({ id: 20, full_name: 'acme/project', archived: false, disabled: false, permissions: { push: true } })); return }
    if (path.startsWith('/repos/acme/project/git/ref/heads/')) {
      const name = decodeURIComponent(path.slice('/repos/acme/project/git/ref/heads/'.length))
      try { const sha = await git.git('-C', git.bare, 'rev-parse', '--verify', 'refs/heads/' + name); res.end(JSON.stringify({ ref: 'refs/heads/' + name, object: { type: 'commit', sha } })) }
      catch { res.writeHead(404); res.end('{}') } return
    }
    if (path === '/repos/acme/project/pulls' && req.method === 'POST') {
      posts++
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')), repo = { id: 20, full_name: 'acme/project' }
      const value = { id: 100 + pulls.length, number: pulls.length + 1, title: request.title, body: request.body,
        html_url: `https://github.com/acme/project/pull/${pulls.length + 1}`, user: { login: destination.login },
        head: { repo, ref: request.head, sha: await git.git('-C', git.bare, 'rev-parse', 'refs/heads/' + request.head) },
        base: { repo, ref: request.base, sha: git.commit }, draft: request.draft, state: 'open', merged: false }
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
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input)); if (url.origin !== 'https://api.github.com') throw new Error('Unexpected provider origin')
    return fetch(origin + url.pathname + url.search, init)
  }
  const ctx = new Context(), subprocess = new LocalSubprocessRuntime(ctx)
  // Only this fixture maps its local source to GitHub metadata. Production URL checks remain unchanged.
  // This qualifies coordinator/export/evidence transport; canonical same-repository rejection is tested separately.
  class LocalRepositoryAdapter extends GithubRepositoryPublication {
    override prepare(target: RepositoryDestinationConfig, transfer: RepositoryTransferReceipt, chunks: Iterable<Buffer>, branch: string, signal: AbortSignal) {
      if (transfer.source !== git.url) throw new Error('Fixture source changed')
      return super.prepare(target, { ...transfer, source: 'https://github.com/acme/project.git' }, chunks, branch, signal)
    }
  }
  const adapter = () => new LocalRepositoryAdapter(subprocess, join(directory, 'service/imports'), fetcher, () => ({ url: git.url, caFile: git.certFile }))
  const config = { stateDir: join(directory, 'service'), ownership: authority.resourceFor('publication'), destinations: [], repositories: [destination] }
  let service = new PublicationService(config, undefined, adapter()); service.start()
  let loseReply: ((value: any) => boolean) | undefined
  const server = createServer((req, res) => {
    const end = res.end.bind(res)
    res.end = ((data: string) => {
      if (loseReply && loseReply(JSON.parse(String(data)).result)) { loseReply = undefined; res.destroy(); return res }
      return end(data)
    }) as typeof res.end
    void publicationHandler(service)(req, res).catch(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const connection = { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, serviceId: service.journal.id,
    credentialFile: join(directory, 'service/client.token'), timeoutMs: 30000 }
  cleanup.push(async () => {
    await service.close(); server.closeAllConnections(); provider.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => provider.close(() => resolve()))])
    await ctx.fiber.dispose()
  })
  let host!: Host
  const bindings: { id: string; version: string }[] = []
  const remote = await remoteFixture(cleanup, { native: process.env.DSH_REMOTE_ISOLATION === '1', ownership: authority.resourceFor('endpoint'),
    access: { authorityId: authority.config.authorityId, coordinatorId: 'coordinator', proof: () => host.runtime.ownership!.proof() },
    beforeEnroll: async endpoint => {
      host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true, ownership: authority.config, publication: connection, captureSessions: options.captureSessions })
      cleanup.push(() => host.stop())
      for (const [id, variable, bytes, mode] of [['git-token', 'REPOSITORY_TOKEN', git.token, 'env'], ['git-ca', 'GIT_SSL_CAINFO', git.cert, 'file']] as const) {
        await writeFile(join(endpoint.credentials.imports, id), bytes, { mode: 0o600 })
        const value = await endpoint.rpc({ role: 'admin' }, { op: 'credential.import', requestId: rid(), id, revision: 0,
          file: id, variable, mode, reason: 'Local repository transport fixture' }, host.runtime.ownership!.proof()) as { id: string; version: string }
        bindings.push({ id: value.id, version: value.version })
      }
    } })
  if (process.env.DSH_REMOTE_ISOLATION !== '1') {
    vi.spyOn(remote.endpoint, 'identity').mockReturnValue({ ...remote.endpoint.identity(), confinement: 'linux-bubblewrap' })
    Object.defineProperty(remote.isolation, 'name', { value: 'host-process' })
  }
  const runtime = host.runtime
  const endpoint = await runtime.endpoints.register({ requestId: rid(), endpointId: remote.endpoint.journal.id, url: remote.url,
    credentialFile: remote.connection.credentialFile, revision: 0, name: 'Repository publication endpoint' })
  const command = await runtime.endpoints.submit(endpoint.id, { revision: endpoint.revision, request: { op: 'grant.create', requestId: rid(),
    owner: 'coordinator', workspace: 'repository', operations: ['fs.read', 'fs.write', 'process.spawn', 'network'], credentials: bindings, leaseMs: 300000 } })
  const world = await runtime.worlds.activate({ requestId: rid(), endpointId: endpoint.id, commandId: command.id, name: 'Reviewed repository',
    repository: { url: git.url, commit: git.commit, credentialId: 'git-token', username: 'x-access-token' } })
  expect(world.ready, world.problem).toBe(true)
  const member = runtime.worlds.require(world.id)
  let mission = runtime.workspace.create({ requestId: rid(), title: 'Repository delivery', objective: 'Deliver reviewed history', acceptance: 'One original PR' })
  mission = runtime.workspace.add(mission.id, { requestId: rid(), revision: mission.revision, title: 'Produce change', instructions: 'Commit reviewed work', owner: 'agent', environment: world.id })
  mission = runtime.workspace.act(mission.id, mission.actions[0]!.id, { requestId: rid(), revision: mission.revision, command: 'run' }); await runtime.idle()
  const ticket = runtime.store.tickets.get(mission.actions[0]!.runs[0]!)!, taskDirectory = ticket.execution!.directory
  const runGit = (...args: string[]) => member.world.withOwner({ kind: 'host', purpose: 'repository-publication-qualification' }, () => {},
    () => runAsWorker(member.subprocess, ['git', ...args], taskDirectory, runtime.lifetime))
  const artifact = runtime.library.publish({ requestId: rid(), kind: 'artifact', title: 'Reviewed change', summary: 'Exact commit', filename: 'result.txt', content: 'reviewed result\n' }, { role: 'worker', ticketId: ticket.id })
  await writeFile(join(taskDirectory, 'result.txt'), 'reviewed result\n'); await writeFile(join(taskDirectory, 'binary.dat'), randomBytes(160000))
  await runGit('add', '.'); await runGit('-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Reviewed workspace commit')
  const head = (await runGit('rev-parse', 'HEAD')).trim()
  const definition = runtime.verification.definitions.create({ requestId: rid(), enabled: true, definition: { name: 'Committed result', description: 'Verify exported source',
    artifactPath: 'result.txt', argv: ['node', '-e', 'if(require("node:fs").readFileSync("result.txt","utf8")!=="reviewed result\\n")process.exit(1)'],
    confinement: process.env.DSH_REMOTE_ISOLATION === '1' ? 'linux-bubblewrap' : 'host-process' } })
  const check = await runtime.verification.request(artifact.id, { requestId: rid(), check: { id: definition.id, version: 1 }, artifactRevision: artifact.revision, artifactHash: artifact.hash })
  await vi.waitFor(async () => { const value = await runtime.verification.refresh(check.id); expect(value.status, value.problem).toBe('passed') }, { timeout: 15000 })
  const exportRequest = { requestId: rid(), revision: artifact.revision, hash: artifact.hash, checks: [runtime.verification.approval(check.id).selection] }
  const exported = await runtime.repositoryExports.prepare(artifact.id, exportRequest)
  expect(exported.phase, exported.problem).toBe('ready')
  const catalog = service.repositories.catalog(), target = catalog[0]!
  const prepareRequest = { requestId: rid(), destination: target.id, destinationHash: target.hash, title: 'Reviewed workspace change', body: 'Exact original result', draft: true }
  const admin = new PublicationClient({ ...connection, credentialFile: join(directory, 'service/admin.token') })
  return { host, runtime, remote, authority, git, world, member, artifact, check, exportRequest, exported, head, taskDirectory, runGit, prepareRequest,
    publisher: { connection, admin, destination: target, get service() { return service }, get posts() { return posts }, pulls,
      losePull: () => { losePull = true }, loseReplyWhen: (predicate: (value: any) => boolean) => { loseReply = predicate },
      restart: async () => { await service.close(); service = new PublicationService(config, undefined, adapter()); service.start() } } }
}
