/** Private authenticated smart-HTTPS Git fixture. Pushes require an explicit test option; no external repository is used. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:https'

const exec = promisify(execFile)
export async function gitServer(cleanup: (() => Promise<unknown>)[], options: { receive?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentic git HTTPS ')), work = join(directory, 'source'), bare = join(directory, 'source.git')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const git = async (...args: string[]) => (await exec('git', ['-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.invalid', ...args],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '' } })).stdout.trim()
  await git('init', '--quiet', '--initial-branch=main', work)
  await writeFile(join(work, 'input.txt'), 'original source\n')
  await git('-C', work, 'add', 'input.txt'); await git('-C', work, 'commit', '--quiet', '-m', 'Original fixture')
  const commit = await git('-C', work, 'rev-parse', 'HEAD')
  await git('clone', '--quiet', '--bare', work, bare)
  await git('-C', bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true')
  if (options.receive) await git('-C', bare, 'config', 'http.receivepack', 'true')
  const backend = join(await git('--exec-path'), 'git-http-backend')
  const config = join(directory, 'openssl.conf'), cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem')
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n', { mode: 0o600 })
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-config', config, '-keyout', key, '-out', cert])
  const token = randomBytes(32).toString('base64url'), authorization = 'Basic ' + Buffer.from('x-access-token:' + token).toString('base64')
  let requests = 0, blocked = false, pushes = 0, updates = 0, losePush = false
  let references = await git('-C', bare, 'for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)')
  const pending = new Set<() => void>(), children = new Set<ReturnType<typeof spawn>>()
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    if (request.headers.authorization !== authorization) { response.writeHead(401, { 'www-authenticate': 'Basic realm="qualification"' }); response.end(); return }
    const url = new URL(request.url!, 'https://127.0.0.1')
    if (!(request.method === 'GET' && url.pathname === '/source.git/info/refs' && url.search === '?service=git-upload-pack'
      || request.method === 'POST' && url.pathname === '/source.git/git-upload-pack' && !url.search
      || options.receive && (request.method === 'GET' && url.pathname === '/source.git/info/refs' && url.search === '?service=git-receive-pack'
        || request.method === 'POST' && url.pathname === '/source.git/git-receive-pack' && !url.search))) { response.writeHead(403); response.end(); return }
    const push = request.method === 'POST' && url.pathname.endsWith('/git-receive-pack'); if (push) pushes++
    requests++
    const run = () => {
      pending.delete(run)
      if (response.destroyed) return
      const child = spawn(backend, [], { env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', REQUEST_METHOD: request.method!, PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_ADDR: '127.0.0.1', REMOTE_USER: 'x-access-token',
        ...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}) }, stdio: ['pipe', 'pipe', 'ignore'] })
      children.add(child)
      const chunks: Buffer[] = []; let length = 0
      child.stdout!.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 8 * 1024 * 1024) child.kill(); else chunks.push(chunk) })
      child.once('error', () => response.destroy())
      child.once('close', code => { void (async () => {
        children.delete(child)
        if (push && !code) {
          const next = await git('-C', bare, 'for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)')
          if (next !== references) updates++; references = next
        }
        if (push && losePush) { losePush = false; response.destroy(); return }
        if (code || response.destroyed) { response.destroy(); return }
        const content = Buffer.concat(chunks), split = content.indexOf('\r\n\r\n')
        if (split < 0) { response.destroy(); return }
        for (const line of content.subarray(0, split).toString('utf8').split('\r\n')) {
          const index = line.indexOf(':'); if (index < 0) continue
          const key = line.slice(0, index), value = line.slice(index + 1).trim()
          if (key.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0]); else response.setHeader(key, value)
        }
        response.end(content.subarray(split + 4))
      })().catch(() => response.destroy()) })
      request.pipe(child.stdin!)
    }
    if (blocked) pending.add(run); else run()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    pending.clear(); server.closeAllConnections(); for (const child of children) child.kill()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { url: `https://127.0.0.1:${(server.address() as { port: number }).port}/source.git`, commit, cert: await readFile(cert), token,
    work, bare, certFile: cert, git, pushes: () => pushes, updates: () => updates, losePushReply: () => { losePush = true },
    requests: () => requests, block: () => { blocked = true }, release: () => { blocked = false; for (const run of [...pending]) run() },
    advance: async () => { await writeFile(join(work, 'input.txt'), 'new upstream source\n'); await git('-C', work, 'commit', '-am', 'Advance upstream');
      await git('-C', work, 'push', bare, 'HEAD:refs/heads/main'); return git('-C', work, 'rev-parse', 'HEAD') } }
}
