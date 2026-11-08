import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteEndpoint } from '../src/remote/endpoint.ts'
import { remoteHandler } from '../src/remote/http.ts'
import { RemoteClient, RemoteUncertain } from '../src/remote/client.ts'
import { RemoteFileSystem } from '../src/remote/filesystem.ts'
import { RemoteSubprocess } from '../src/remote/subprocess.ts'
import { RemoteJournal } from '../src/remote/journal.ts'
import { confinedFilesystem } from '../src/remote/filesystem-runner.ts'
import { BubblewrapIsolation, type ExecutionIsolation } from '../src/remote/isolation.ts'
import type { GrantReceipt, RemoteJob, RemoteOperation, OutputWindow, RpcInput, RevocationReceipt } from '../src/remote/protocol.ts'
import { RemoteWorld } from '../src/remote/world.ts'
import { apply as composeWorld } from '../src/remote/provider-plugin.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.reverse()) await stop(); cleanup.length = 0; vi.restoreAllMocks() })

/** Real Harness local providers and real HTTP; test-only passthrough never enters the production endpoint plugin. */
async function fixture(options: { leaseMs?: number; outputMaxBytes?: number; native?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-')), ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }), process = new LocalSubprocessRuntime(ctx)
  const isolation: ExecutionIsolation = options.native ? new BubblewrapIsolation(process) : { name: 'test-only-unconfined',
    wrap: async (argv, _root, _cwd, _network, _signal, _env, helper) => argv.map(arg => arg === '/run/dsh-filesystem.mjs' && helper ? helper : arg) }
  const endpoint = new RemoteEndpoint({ stateDir: join(directory, 'control'), root: join(directory, 'work'), filesystem: fs, subprocess: process,
    isolation, filesystemRpc: confinedFilesystem(process, isolation, fileURLToPath(new URL(options.native ? '../lib/remote-fs-worker.js' : '../src/remote/fs-worker.ts', import.meta.url))),
    outputMaxBytes: options.outputMaxBytes, shutdownMs: 2000 })
  await endpoint.start()
  let lose = false, offline = false
  const handler = remoteHandler(endpoint)
  const server = createServer((req, res) => {
    if (offline) { res.destroy(); return }
    if (lose) { lose = false; res.end = (() => { res.destroy(); return res }) as typeof res.end }
    void handler(req, res).catch(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const connection = { url, endpointId: endpoint.journal.id, credentialFile: join(directory, 'control/admin.token'), timeoutMs: 1000 }
  const admin = new RemoteClient(connection)
  const enrolled = await admin.call<GrantReceipt>({ op: 'grant.create', requestId: 'enroll', owner: 'coordinator', workspace: 'task',
    operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: options.leaseMs ?? 300_000 })
  const credentialFile = join(directory, 'grant.token'); await writeFile(credentialFile, enrolled.credential!, { mode: 0o600 })
  const client = new RemoteClient({ ...connection, credentialFile })
  const world = new Context(), remoteFs = new RemoteFileSystem(world, client, enrolled.grant), remoteProcess = new RemoteSubprocess(world, client, enrolled.grant)
  cleanup.push(async () => { offline = false; await endpoint.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await world.fiber.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const spawn = (script: string, extra = {}) => ({ op: 'job.spawn' as const, requestId: randomUUID(), revision: enrolled.grant.revision,
    argv: ['/bin/sh', '-c', script], cwd: enrolled.grant.root, graceMs: 100, env: {}, ...extra })
  const settled = async (id: string) => {
    let value: RemoteJob | undefined
    await vi.waitFor(async () => { value = await client.call<RemoteJob>({ op: 'job.get', id }); expect(value.quiescent).toBe(true) }, { timeout: 5000 })
    return value!
  }
  return { directory, ctx, endpoint, server, url, connection, admin, client, enrolled, remoteFs, remoteProcess, fs, isolation, spawn, settled,
    lose: () => { lose = true }, failResponse: () => {
      const rpc = endpoint.rpc.bind(endpoint)
      vi.spyOn(endpoint, 'rpc').mockImplementationOnce(async (...args) => { await rpc(...args); throw new Error('Response failed after commit') })
    }, offline: (value: boolean) => { offline = value } }
}

it('authenticates and pins the endpoint, denies browser RPC, and keeps grant credentials out of process overrides', async () => {
  const h = await fixture()
  const response = await fetch(h.url + '/execution/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"op":"identity"}' })
  expect(response.status).toBe(401)
  const wrong = new RemoteClient({ ...h.connection, endpointId: 'wrong' })
  await expect(wrong.call({ op: 'identity' })).rejects.toThrow('identity changed')
  await expect(h.client.call({ op: 'grant.change', requestId: 'escalate', id: h.enrolled.grant.id, revision: 1, enabled: true, leaseMs: 300000, reason: 'self elevation' })).rejects.toThrow('administration')
  await expect(h.client.call(h.spawn('true', { env: { OPENAI_API_KEY: 'must-not-forward' } }))).rejects.toThrow('environment')
  expect(h.endpoint.journal.jobs()).toEqual([])
  const token = await readFile(h.connection.credentialFile, 'utf8')
  const browser = await fetch(h.url + '/execution/v1', { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: h.url, 'content-type': 'application/json' }, body: '{"op":"identity"}' })
  expect(browser.status).toBe(403)
})

it('uses paired Harness providers so process writes and filesystem reads share one remote workspace', async () => {
  const h = await fixture(), file = await h.remoteFs.resolve('result.txt')
  expect(h.remoteFs.processPathFromHostPath('/tmp/host-private')).toBeUndefined()
  const handle = h.remoteProcess.spawn({ argv: ['/bin/sh', '-c', "printf 'remote result' > result.txt; printf 'done'"], cwd: h.enrolled.grant.root,
    graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  expect(await handle.done).toEqual({ exitCode: 0, signal: null })
  expect(await handle.waitForExit()).toBe(true)
  expect(handle.collected.stdout!.readFrom(0)).toMatchObject({ text: 'done', nextOffset: 4, lossy: false })
  expect(await h.remoteFs.readText(file)).toBe('remote result')
  expect(await h.remoteFs.readByteRange(file, { offset: 7, length: 6 })).toEqual(Buffer.from('result'))
  expect(await h.remoteFs.readBytes(file, undefined, 13)).toEqual(Buffer.from('remote result'))
  await expect(h.remoteFs.readBytes(file, undefined, 3)).rejects.toThrow('bound')
})

it('replays a lost spawn acknowledgement without executing its side effect twice', async () => {
  const h = await fixture(), request = h.spawn('printf x >> count; printf receipt')
  h.lose()
  const job = await h.client.intent<RemoteJob>(request)
  expect((await h.settled(job.id)).outcome?.exitCode).toBe(0)
  expect(await readFile(join(h.enrolled.grant.root, 'count'), 'utf8')).toBe('x')
  expect((await h.client.intent<RemoteJob>(request)).id).toBe(job.id)
  await expect(h.client.intent({ ...request, argv: ['/bin/sh', '-c', 'printf xx >> count'] })).rejects.toThrow('already used')
  expect(h.endpoint.journal.jobs()).toHaveLength(1)
})

it('reconciles a server error after commit using the same durable intent instead of assuming rejection', async () => {
  const h = await fixture(), request = h.spawn('printf x >> count')
  h.failResponse()
  const job = await h.client.intent<RemoteJob>(request)
  await h.settled(job.id)
  expect(await readFile(join(h.enrolled.grant.root, 'count'), 'utf8')).toBe('x')
  expect(h.endpoint.journal.jobs()).toHaveLength(1)
})

it('persists exact output byte cursors through a disconnect and makes retention gaps explicit', async () => {
  const h = await fixture({ outputMaxBytes: 7 }), request = h.spawn("printf abc; sleep 0.2; printf defghij")
  const job = await h.client.intent<RemoteJob>(request)
  h.offline(true)
  await new Promise(resolve => setTimeout(resolve, 300)); h.offline(false)
  await h.settled(job.id)
  const first = await h.client.call<OutputWindow>({ op: 'job.output', id: job.id, stream: 'stdout', offset: 0, limit: 4 })
  const second = await h.client.call<OutputWindow>({ op: 'job.output', id: job.id, stream: 'stdout', offset: first.nextOffset, limit: 4 })
  const gap = await h.client.call<OutputWindow>({ op: 'job.output', id: job.id, stream: 'stdout', offset: second.nextOffset, limit: 4 })
  expect(Buffer.from(first.data, 'base64').toString() + Buffer.from(second.data, 'base64').toString()).toBe('abcdefg')
  expect(gap).toMatchObject({ offset: 7, nextOffset: 10, gap: true, retainedBytes: 7, totalBytes: 10 })
  expect(await h.client.call({ op: 'job.output', id: job.id, stream: 'stdout', offset: 0, limit: 4 })).toEqual(first)
})

it('supports guarded atomic writes/edits and deduplicates a committed filesystem mutation after response loss', async () => {
  const h = await fixture(), target = await h.remoteFs.resolve('note.txt')
  const request = { op: 'fs.write' as const, requestId: 'write-once', path: target.displayPath, content: 'first note', expected: { kind: 'createIfAbsent' as const } }
  h.lose()
  const receipt = await h.client.intent<RemoteOperation>(request)
  expect(receipt.phase).toBe('settled'); expect(receipt.value).toHaveProperty('operation', 'create')
  expect((await h.client.intent<RemoteOperation>(request)).value).toEqual(receipt.value)
  const version = (await h.remoteFs.stat(target))!.version
  const edit = await h.remoteFs.editText(target, { oldString: 'first', newString: 'second', replaceAll: false }, { version })
  expect(edit.after).toBe('second note')
  await expect(h.remoteFs.writeText(target, 'stale', { kind: 'replaceIfVersion', version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(await h.remoteFs.readText(target)).toBe('second note')
})

it('refuses traversal and symlink escape for read, write and process working directories', async () => {
  const h = await fixture()
  await symlink(join(h.directory, 'control'), join(h.enrolled.grant.root, 'escape'))
  await expect(h.remoteFs.resolve('../secret')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  await expect(h.remoteFs.resolve('escape/admin.token')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  await symlink(join(h.directory, 'absent-target'), join(h.enrolled.grant.root, 'dangling'))
  await expect(h.remoteFs.resolve('dangling')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  await expect(h.client.intent({ op: 'fs.write', requestId: 'escape', path: join(h.enrolled.grant.root, 'escape/change'), content: 'bad' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  const job = await h.client.intent<RemoteJob>(h.spawn('touch bad', { cwd: join(h.enrolled.grant.root, 'escape') }))
  expect((await h.settled(job.id)).error).toContain('outside')
})

it('revokes running work without a connected client and refuses stale credentials after reauthorization', async () => {
  const h = await fixture(), request = h.spawn('sleep 20')
  const job = await h.client.intent<RemoteJob>(request)
  await vi.waitFor(() => expect(h.endpoint.journal.job(job.id).phase).toBe('started'))
  const renewed = await h.client.intent<GrantReceipt>({ op: 'grant.renew', requestId: 'renew-before-revoke', revision: 1, leaseMs: 300000 })
  h.offline(true)
  await h.endpoint.rpc({ role: 'admin' }, { op: 'grant.change', requestId: 'local-revoke', id: h.enrolled.grant.id, revision: renewed.grant.revision,
    enabled: false, leaseMs: 300000, reason: 'Revoke while disconnected' })
  await vi.waitFor(() => expect(h.endpoint.journal.job(job.id).quiescent).toBe(true), { timeout: 5000 })
  h.offline(false)
  const changed = await h.admin.intent<GrantReceipt>({ op: 'grant.change', requestId: 'enable-new', id: h.enrolled.grant.id,
    revision: h.endpoint.journal.grant(h.enrolled.grant.id).revision, enabled: true, leaseMs: 300000, reason: 'New authorization' })
  expect(changed.grant.epoch).toBe(3)
  await expect(h.client.intent(h.spawn('touch must-not-run'))).rejects.toThrow('revoked')
  // Replaying an old renewal must never reveal the replacement generation's credential.
  await expect(h.client.intent({ op: 'grant.renew', requestId: 'renew-before-revoke', revision: 1, leaseMs: 300000 })).rejects.toThrow('revoked')
  expect((await h.client.call<RemoteJob>({ op: 'job.get', id: job.id })).cancelRequested).toBe(true)
})

it('expires disconnected leases and cancels the provider-managed process range', async () => {
  const h = await fixture({ leaseMs: 1000 }), job = await h.client.intent<RemoteJob>(h.spawn('sleep 20 & wait'))
  await vi.waitFor(() => expect(h.endpoint.journal.job(job.id).phase).toBe('started'))
  h.offline(true)
  await vi.waitFor(() => { expect(h.endpoint.journal.grant(h.enrolled.grant.id).enabled).toBe(false); expect(h.endpoint.journal.job(job.id).quiescent).toBe(true) }, { timeout: 5000 })
  h.offline(false)
  expect((await h.client.call<RemoteJob>({ op: 'job.get', id: job.id })).cancelRequested).toBe(true)
})

it('marks incomplete dispatch and file-effect receipts unknown on reopen and never silently reexecutes them', async () => {
  const h = await fixture(), original = await h.client.intent<RemoteJob>(h.spawn('printf once > count'))
  await h.settled(original.id)
  const job = h.endpoint.journal.job(original.id)
  job.phase = 'started'; job.quiescent = false; h.endpoint.journal.saveJob(job)
  h.endpoint.journal.saveOperation({ id: 'uncertain-write', grantId: job.grantId, epoch: job.epoch, fingerprint: 'digest', kind: 'fs.write', phase: 'started', at: new Date().toISOString() })
  await h.endpoint.stop()
  const journal = new RemoteJournal(join(h.directory, 'control'), join(h.directory, 'work'))
  try {
    expect(journal.job(job.id)).toMatchObject({ phase: 'unknown', quiescent: null })
    expect(journal.operation('uncertain-write')?.phase).toBe('unknown')
    expect(await readFile(join(h.enrolled.grant.root, 'count'), 'utf8')).toBe('once')
  } finally { journal.close() }
})

it('holds new mutations behind uncertain outcomes until an administrator records reconciliation', async () => {
  const h = await fixture(), job = await h.client.intent<RemoteJob>(h.spawn('true'))
  await h.settled(job.id)
  const unknown = h.endpoint.journal.job(job.id); unknown.phase = 'unknown'; unknown.quiescent = null; h.endpoint.journal.saveJob(unknown)
  await expect(h.client.intent(h.spawn('true'))).rejects.toThrow('reconciliation')
  await expect(h.client.intent({ op: 'job.reconcile', requestId: 'self-reconcile', id: job.id, note: 'I assume it stopped', quiescent: true })).rejects.toThrow('administration')
  await h.admin.intent({ op: 'job.reconcile', requestId: 'operator-reconcile', id: job.id, note: 'Test driver independently observed the process group exit', quiescent: true })
  expect((await h.settled((await h.client.intent<RemoteJob>(h.spawn('true'))).id)).outcome?.exitCode).toBe(0)
})

it('rejects insecure origins and unsupported terminal/stdin capabilities explicitly', async () => {
  const h = await fixture()
  expect(() => new RemoteClient({ ...h.connection, url: 'http://example.com' })).toThrow('HTTPS')
  expect(() => new RemoteClient({ ...h.connection, url: 'https://user:secret@example.com' })).toThrow('HTTPS')
  expect(() => h.remoteProcess.spawn({ argv: ['cat'], cwd: h.enrolled.grant.root, graceMs: 100, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })).toThrow('interactive stdin')
  await expect(h.remoteProcess.spawnTerminal({} as never)).rejects.toThrow('terminal')
})

it('reconnects a live Harness handle by receipt and preserves UTF-8 boundaries across polling windows', async () => {
  const h = await fixture()
  const script = "process.stdout.write(Buffer.from([240,159])); const t=setInterval(()=>{if(require('fs').existsSync('continue')){clearInterval(t);process.stdout.write(Buffer.from([152,128]));}},20)"
  const handle = h.remoteProcess.spawn({ argv: [process.execPath, '-e', script], cwd: h.enrolled.grant.root, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  await vi.waitFor(() => {
    const job = h.endpoint.journal.jobs()[0]!
    expect(h.endpoint.journal.output(job.id, 'stdout', 0, 10).totalBytes).toBe(2)
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(handle.collected.stdout!.readFrom(0)).toMatchObject({ text: '', nextOffset: 0 })
  h.offline(true)
  await writeFile(join(h.enrolled.grant.root, 'continue'), '')
  await new Promise(resolve => setTimeout(resolve, 250)); h.offline(false)
  expect((await handle.done).exitCode).toBe(0)
  expect(await handle.waitForExit()).toBe(true)
  expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: '😀', nextOffset: 4, lossy: false })
  expect(h.endpoint.journal.jobs()).toHaveLength(1)
})

it('cancels and confirms exit even when a piped output consumer stops reading', async () => {
  const h = await fixture()
  const handle = h.remoteProcess.spawn({ argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(256000));setInterval(()=>{},1000)"],
    cwd: h.enrolled.grant.root, graceMs: 100, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 } } })
  const result = handle.done.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => {
    const job = h.endpoint.journal.jobs()[0]!
    expect(h.endpoint.journal.output(job.id, 'stdout', 0, 10).totalBytes).toBe(256000)
  })
  handle.terminate()
  expect(await handle.waitForExit(AbortSignal.timeout(3000))).toBe(true)
  expect(await result).toHaveProperty('error')
  expect(h.endpoint.journal.jobs()[0]).toMatchObject({ cancelRequested: true, quiescent: true })
})

it('serializes conflicting guarded writes and permits explicit text replacement of a binary file', async () => {
  const h = await fixture(), target = await h.remoteFs.resolve('guarded.txt')
  await h.remoteFs.writeText(target, 'original', { kind: 'createIfAbsent' })
  const version = (await h.remoteFs.stat(target))!.version
  const results = await Promise.allSettled(['left', 'right'].map(content => h.remoteFs.writeText(target, content, { kind: 'replaceIfVersion', version })))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'FS_STALE_VERSION' } })
  await writeFile(join(h.enrolled.grant.root, 'binary'), Buffer.from([0, 255, 1]))
  const binary = await h.remoteFs.resolve('binary')
  expect(await h.remoteFs.writeText(binary, 'text\r\n')).toMatchObject({ operation: 'update', before: null, after: 'text\n' })
  await h.settled((await h.client.intent<RemoteJob>(h.spawn('mkfifo pipe'))).id)
  await expect(h.remoteFs.readByteRange(await h.remoteFs.resolve('pipe'), { offset: 0, length: 32 })).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
})

it('rejects replacement of a granted directory and fences work revoked while preparing dispatch', async () => {
  const h = await fixture(), entering = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = h.isolation.wrap.bind(h.isolation)
  vi.spyOn(h.isolation, 'wrap').mockImplementationOnce(async (...args) => { entering.resolve(); await release.promise; return original(...args) })
  const job = await h.client.intent<RemoteJob>(h.spawn('touch should-not-exist'))
  await entering.promise
  await h.admin.intent({ op: 'grant.change', requestId: 'before-dispatch', id: h.enrolled.grant.id, revision: 1, enabled: false, leaseMs: 1000, reason: 'Revoke prepared command' })
  release.resolve()
  expect((await h.settled(job.id)).cancelRequested).toBe(true)
  await expect(readFile(join(h.enrolled.grant.root, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' })
  const h2 = await fixture()
  await rename(h2.enrolled.grant.root, h2.enrolled.grant.root + '-old'); await mkdir(h2.enrolled.grant.root)
  await expect(h2.remoteFs.resolve('new-file')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  const refused = await h2.client.intent<RemoteJob>(h2.spawn('touch bad'))
  expect((await h2.settled(refused.id)).error).toContain('identity changed')
})

it('requires reconciliation before a replacement provider can launch over a prior active command', async () => {
  const h = await fixture(), old = await h.client.intent<RemoteJob>(h.spawn('sleep 20'))
  await vi.waitFor(() => expect(h.endpoint.journal.job(old.id).phase).toBe('started'))
  const refused = h.remoteProcess.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: h.enrolled.grant.root, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  await expect(refused.done).rejects.toMatchObject({ operationId: old.id })
  await h.client.intent({ op: 'job.cancel', requestId: 'cancel-orphan', id: old.id })
  await h.settled(old.id)
  await h.remoteProcess.reconcileCommand(old.id)
  expect((await h.remoteProcess.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: h.enrolled.grant.root, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } }).done).exitCode).toBe(0)
})

it('keeps an existing world fenced when a replacement credential is installed at the same path', async () => {
  const h = await fixture()
  const replacement = await h.admin.intent<GrantReceipt>({ op: 'grant.change', requestId: 'replace-credential', id: h.enrolled.grant.id,
    revision: 1, enabled: true, leaseMs: 300000, reason: 'Replace authorization generation' })
  await writeFile(h.client.connection.credentialFile, replacement.credential!)
  await expect(h.remoteFs.resolve('must-not-cross-generations')).rejects.toMatchObject({ code: 'grant_changed' })
  const handle = h.remoteProcess.spawn({ argv: ['/bin/sh', '-c', 'touch bad'], cwd: h.enrolled.grant.root, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  await expect(handle.done).rejects.toMatchObject({ code: 'grant_changed' })
  expect(await handle.waitForExit()).toBe(true)
  expect(h.endpoint.journal.jobs()).toHaveLength(0)
})

it('lets a grant revoke only its own generation, replays the acknowledgement, and separately observes process quiescence', async () => {
  const h = await fixture(), job = await h.client.intent<RemoteJob>(h.spawn('printf started; sleep 20'))
  await vi.waitFor(() => expect(h.endpoint.journal.output(job.id, 'stdout', 0, 100).totalBytes).toBe(7))
  const request = { op: 'grant.revoke' as const, requestId: 'self-revoke', reason: 'Operator stopped this execution world' }
  h.lose()
  const receipt = await h.client.intent<RevocationReceipt>(request)
  expect(receipt).toMatchObject({ grantId: h.enrolled.grant.id, epoch: 1 })
  expect(receipt).not.toHaveProperty('credential')
  expect(h.endpoint.journal.grant(h.enrolled.grant.id)).toMatchObject({ enabled: false, epoch: 2, revision: 2 })
  await h.settled(job.id)
  expect(await h.client.intent(request)).toEqual({ ...receipt, quiescent: true })
  await expect(h.client.intent({ ...request, reason: 'Different payload' })).rejects.toMatchObject({ code: 'request_conflict' })
  await expect(h.client.call(h.spawn('touch forbidden'))).rejects.toMatchObject({ code: 'grant_unavailable' })
  await expect(h.admin.intent({ ...request, requestId: 'admin-is-not-grant' })).rejects.toMatchObject({ code: 'grant_required' })
  const replacement = await h.admin.intent<GrantReceipt>({ op: 'grant.change', requestId: 'new-generation', id: h.enrolled.grant.id,
    revision: 2, enabled: true, leaseMs: 300000, reason: 'Separately authorized replacement' })
  await h.client.intent(request)
  await h.client.intent({ ...request, requestId: 'old-token-stop-again' })
  expect(h.endpoint.journal.grant(h.enrolled.grant.id)).toEqual(replacement.grant)
})

/** The HTTP lifecycle tests isolate composition from namespace qualification, which has its separate native Linux test. */
async function persistentWorld(h: Awaited<ReturnType<typeof fixture>>, native = false) {
  if (!native) vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const config = { ...h.client.connection, stateDir: join(h.directory, 'coordinator-world') }
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await composeWorld(ctx, config)
  return { world: ctx.superagentRemoteWorld, ctx, config }
}

it('composes paired providers with persistent authority and refuses replacement credentials after restart', async () => {
  const h = await fixture(), { world, ctx, config } = await persistentWorld(h)
  const before = world.status()
  expect(before).toMatchObject({ ready: true, phase: 'active', grantId: h.enrolled.grant.id, epoch: 1 })
  const target = await ctx.fs.resolve('persistent.txt')
  await ctx.fs.writeText(target, 'paired world', { kind: 'createIfAbsent' })
  const handle = ctx.subprocess.spawn({ argv: ['/bin/sh', '-c', 'cat persistent.txt'], cwd: world.grant.root, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  expect((await handle.done).exitCode).toBe(0)
  expect(handle.collected.stdout!.readFrom(0).text).toBe('paired world')
  expect(() => new RemoteWorld(config)).toThrow()
  await ctx.fiber.dispose()
  const resumed = new RemoteWorld(config); cleanup.push(() => resumed.close()); await resumed.start()
  expect(resumed.status().binding).toBe(before.binding)
  await resumed.close()
  const replacement = await h.admin.intent<GrantReceipt>({ op: 'grant.change', requestId: 'world-replacement', id: h.enrolled.grant.id,
    revision: h.endpoint.journal.grant(h.enrolled.grant.id).revision, enabled: true, leaseMs: 300000, reason: 'New authority' })
  await writeFile(config.credentialFile, replacement.credential!)
  const wrong = new RemoteWorld(config); cleanup.push(() => wrong.close())
  await expect(wrong.start()).rejects.toMatchObject({ code: 'grant_changed' })
  expect(h.endpoint.journal.grant(h.enrolled.grant.id)).toEqual(replacement.grant)
})

it('persists local revocation before offline RPC and replays it on restart without renewing authority', async () => {
  const h = await fixture(), { world, ctx, config } = await persistentWorld(h)
  const target = await ctx.fs.resolve('refused.txt')
  h.offline(true)
  const revoke = world.revoke('durable-stop', 'Operator revoked while endpoint was offline')
  expect(world.status()).toMatchObject({ ready: false, phase: 'revoking', revocation: { acknowledged: false, quiescent: false } })
  await expect(ctx.fs.writeText(target, 'must not write')).rejects.toMatchObject({ code: 'world_unavailable' })
  await expect(revoke).rejects.toBeInstanceOf(RemoteUncertain)
  await ctx.fiber.dispose(); h.offline(false)
  const revision = h.endpoint.journal.grant(h.enrolled.grant.id).revision
  const resumed = new RemoteWorld(config); cleanup.push(() => resumed.close()); await resumed.start()
  expect(resumed.status()).toMatchObject({ ready: false, phase: 'revoked', revocation: { requestId: 'durable-stop', acknowledged: true, quiescent: true } })
  expect(h.endpoint.journal.grant(h.enrolled.grant.id)).toMatchObject({ enabled: false, revision: revision + 1 })
  expect(await resumed.revoke('durable-stop', 'Operator revoked while endpoint was offline')).toMatchObject({ phase: 'revoked' })
  await expect(resumed.revoke('another-stop', 'New request')).rejects.toMatchObject({ code: 'revocation_pending' })
  await expect(readFile(join(h.enrolled.grant.root, 'refused.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('recovers an acknowledged endpoint revocation whose response and local acknowledgement were lost', async () => {
  const h = await fixture(), { world, ctx, config } = await persistentWorld(h)
  const rpc = h.endpoint.rpc.bind(h.endpoint)
  vi.spyOn(h.endpoint, 'rpc').mockImplementation(async (principal, request) => {
    const result = await rpc(principal, request)
    if ((request as RpcInput).op === 'grant.revoke') throw new Error('Lost response after revocation commit')
    return result
  })
  await expect(world.revoke('lost-stop', 'Persist this intent')).rejects.toBeInstanceOf(RemoteUncertain)
  expect(world.status().phase).toBe('revoking')
  expect(h.endpoint.journal.grant(h.enrolled.grant.id).enabled).toBe(false)
  await ctx.fiber.dispose(); vi.mocked(h.endpoint.rpc).mockRestore()
  const resumed = new RemoteWorld(config); cleanup.push(() => resumed.close()); await resumed.start()
  expect(resumed.status()).toMatchObject({ phase: 'revoked', ready: false, revocation: { acknowledged: true } })
  expect(h.endpoint.journal.grant(h.enrolled.grant.id).epoch).toBe(2)
})

it('closes admission synchronously during a renewal race and never renews after the durable stop', async () => {
  const h = await fixture(), { world } = await persistentWorld(h)
  const grant = h.endpoint.journal.grant(h.enrolled.grant.id); grant.leaseUntil = Date.now() + 30_000; h.endpoint.journal.saveGrant(grant)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), rpc = h.endpoint.rpc.bind(h.endpoint)
  let renewals = 0
  vi.spyOn(h.endpoint, 'rpc').mockImplementation(async (principal, request) => {
    const result = await rpc(principal, request)
    if ((request as RpcInput).op === 'grant.renew') { renewals++; entered.resolve(); await release.promise }
    return result
  })
  const renewing = world.refresh(); await entered.promise
  const revoked = world.revoke('racing-stop', 'Stop during lease renewal')
  expect(world.status().ready).toBe(false)
  release.resolve(); await renewing; await revoked; await world.refresh()
  expect(renewals).toBe(1)
  expect(world.status()).toMatchObject({ ready: false, phase: 'revoked' })
  expect(h.endpoint.journal.grant(h.enrolled.grant.id)).toMatchObject({ epoch: 2, enabled: false })
})

it('keeps unknown effects distinct from revocation acknowledgement until operator reconciliation', async () => {
  const h = await fixture(), { world } = await persistentWorld(h)
  const job = await h.client.intent<RemoteJob>(h.spawn('true')); await h.settled(job.id)
  const unknown = h.endpoint.journal.job(job.id); unknown.phase = 'unknown'; unknown.quiescent = null; h.endpoint.journal.saveJob(unknown)
  h.endpoint.journal.saveOperation({ id: 'uncertain-file', grantId: h.enrolled.grant.id, epoch: 1, fingerprint: 'test',
    kind: 'fs.write', phase: 'unknown', at: new Date().toISOString() })
  expect(await world.revoke('uncertain-stop', 'Stop an uncertain world')).toMatchObject({ ready: false, phase: 'revoked',
    revocation: { acknowledged: true, quiescent: false } })
  await h.admin.intent({ op: 'job.reconcile', requestId: 'confirm-stopped', id: job.id, quiescent: true, note: 'Test operator independently confirmed process exit' })
  await world.refresh()
  expect(world.status().revocation?.quiescent).toBe(false)
  await h.admin.intent({ op: 'operation.reconcile', requestId: 'confirm-file', id: 'uncertain-file', note: 'Test operator independently checked filesystem effect' })
  await world.refresh()
  expect(world.status().revocation?.quiescent).toBe(true)
})

it('refuses coordinator state or credentials inside the remote workspace', async () => {
  const h = await fixture(), { ctx, config } = await persistentWorld(h)
  await ctx.fiber.dispose()
  const unsafe = new RemoteWorld({ ...config, stateDir: join(h.enrolled.grant.root, 'private-control') }); cleanup.push(() => unsafe.close())
  await expect(unsafe.start()).rejects.toThrow('outside the granted workspace')
  const credentialFile = join(h.enrolled.grant.root, 'unsafe.token')
  await writeFile(credentialFile, h.enrolled.credential!)
  const credentials = new RemoteWorld({ ...config, credentialFile }); cleanup.push(() => credentials.close())
  await expect(credentials.start()).rejects.toThrow('outside the granted workspace')
})

it('refuses a different endpoint binding and fences an externally revoked world without accepting new authority', async () => {
  const h = await fixture(), { world, ctx, config } = await persistentWorld(h)
  await h.admin.intent({ op: 'grant.change', requestId: 'external-stop', id: h.enrolled.grant.id,
    revision: h.endpoint.journal.grant(h.enrolled.grant.id).revision, enabled: false, leaseMs: 300000, reason: 'Endpoint operator stop' })
  await world.refresh()
  expect(world.status()).toMatchObject({ ready: false, epoch: 1 })
  await expect(ctx.fs.resolve('cannot-resume')).rejects.toMatchObject({ code: 'world_unavailable' })
  await ctx.fiber.dispose()
  const wrong = new RemoteWorld({ ...config, endpointId: 'another-endpoint' }); cleanup.push(() => wrong.close())
  await expect(wrong.start()).rejects.toMatchObject({ code: 'world_changed' })
})

it.runIf(process.platform !== 'linux')('refuses an unconfined production endpoint on unsupported hosts', async () => {
  const h = await fixture()
  expect(() => new BubblewrapIsolation(h.ctx.subprocess)).toThrow('Linux with bubblewrap')
})

it('refuses readiness when a purported confined runner can still see endpoint control state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-false-isolation-')), ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 }), process = new LocalSubprocessRuntime(ctx)
  const isolation: ExecutionIsolation = { name: 'linux-bubblewrap',
    wrap: async (argv, _root, _cwd, _network, _signal, _env, helper) => argv.map(arg => arg === '/run/dsh-filesystem.mjs' && helper ? helper : arg) }
  const endpoint = new RemoteEndpoint({ stateDir: join(directory, 'control'), root: join(directory, 'work'), filesystem: fs, subprocess: process, isolation,
    filesystemRpc: confinedFilesystem(process, isolation, fileURLToPath(new URL('../src/remote/fs-worker.ts', import.meta.url))) })
  try {
    await expect(endpoint.start()).rejects.toThrow('namespace proof failed')
    await expect(endpoint.rpc({ role: 'admin' }, { op: 'identity' })).rejects.toThrow('not ready')
  } finally { await endpoint.stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it.runIf(process.env.DSH_REMOTE_ISOLATION === '1')('qualifies native Linux filesystem and process confinement using the built helper', async () => {
  const h = await fixture({ native: true })
  const { world, ctx, config } = await persistentWorld(h, true)
  const target = await ctx.fs.resolve('native.txt')
  await ctx.fs.writeText(target, 'same world', { kind: 'createIfAbsent' })
  const control = join(h.directory, 'control', 'admin.token')
  const code = `const fs=require('fs'); if(fs.existsSync(${JSON.stringify(control)}))process.exit(9);if(process.env.HARNESS_ISOLATION_MARKER)process.exit(10);process.stdout.write(fs.readFileSync('native.txt'));fs.writeFileSync('produced','confined');fetch(${JSON.stringify(h.url)},{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(11),()=>{})`
  vi.stubEnv('HARNESS_ISOLATION_MARKER', 'must-not-enter-worker')
  try {
    const handle = ctx.subprocess.spawn({ argv: [process.execPath, '-e', code], cwd: h.enrolled.grant.root, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
    expect((await handle.done).exitCode).toBe(0); expect(await handle.waitForExit()).toBe(true)
    expect(handle.collected.stdout!.readFrom(0).text).toBe('same world')
    expect(await h.remoteFs.readText(await h.remoteFs.resolve('produced'))).toBe('confined')
    await symlink(control, join(h.enrolled.grant.root, 'escape'))
    await expect(h.remoteFs.resolve('escape')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    const child = "setTimeout(()=>require('fs').writeFileSync('escaped','survived'),1500)"
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();process.stdout.write('child-started');setInterval(()=>{},1000)`
    const job = await h.client.intent<RemoteJob>(h.spawn('', { argv: [process.execPath, '-e', parent] }))
    await vi.waitFor(() => expect(h.endpoint.journal.output(job.id, 'stdout', 0, 100).totalBytes).toBe(13))
    h.offline(true)
    await h.endpoint.rpc({ role: 'admin' }, { op: 'grant.change', requestId: 'native-revoke', id: h.enrolled.grant.id, revision: 1,
      enabled: false, leaseMs: 300000, reason: 'Native descendant cancellation proof' })
    await vi.waitFor(() => expect(h.endpoint.journal.job(job.id).quiescent).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 1700)); h.offline(false)
    await expect(readFile(join(h.enrolled.grant.root, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await world.revoke('native-world-stop', 'Persist native execution stop')).toMatchObject({ ready: false, phase: 'revoked',
      revocation: { acknowledged: true, quiescent: true } })
    await ctx.fiber.dispose()
    const resumed = new RemoteWorld(config); cleanup.push(() => resumed.close()); await resumed.start()
    expect(resumed.status()).toMatchObject({ ready: false, phase: 'revoked', revocation: { acknowledged: true, quiescent: true } })
  } finally { vi.unstubAllEnvs() }
}, 20_000)
