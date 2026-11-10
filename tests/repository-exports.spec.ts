import { afterEach, expect, it, vi } from 'vitest'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { runAsWorker } from '../src/infra/environment.ts'
import { RepositoryExports } from '../src/publication/repository-exports.ts'
import { repositoryFixture } from './fixtures/repository.ts'
import { verifyPublicationState } from '../src/recovery/publications.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'

const cleanup: (() => Promise<unknown>)[] = [], rid = () => randomUUID()
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture() {
  const h = await repositoryFixture(cleanup), runtime = h.h.runtime, workspace = runtime.workspace
  // The macOS fixture runs host processes; Linux qualification keeps the real namespace boundary.
  if (process.env.DSH_REMOTE_ISOLATION !== '1') Object.defineProperty(h.remote.isolation, 'name', { value: 'host-process' })
  let mission = workspace.create({ requestId: rid(), title: 'Reviewed repository', objective: 'Publish committed work', acceptance: 'Exact reviewed history' })
  mission = workspace.add(mission.id, { requestId: rid(), revision: mission.revision, title: 'Prepare change', instructions: 'Produce a reviewed commit', owner: 'agent', environment: h.world.id })
  mission = workspace.act(mission.id, mission.actions[0]!.id, { requestId: rid(), revision: mission.revision, command: 'run' }); await runtime.idle()
  const ticket = runtime.store.tickets.get(mission.actions[0]!.runs[0]!)!, directory = ticket.execution!.directory
  const git = (...args: string[]) => h.member.world.withOwner({ kind: 'host', purpose: 'repository-export-qualification' }, () => {},
    () => runAsWorker(h.member.subprocess, ['git', ...args], directory, runtime.lifetime))
  const artifact = runtime.library.publish({ requestId: rid(), kind: 'artifact', title: 'Review result', summary: 'Committed result', filename: 'result.txt', content: 'reviewed result\n' }, { role: 'worker', ticketId: ticket.id })
  await writeFile(join(directory, 'result.txt'), 'reviewed result\n')
  await writeFile(join(directory, 'binary.dat'), randomBytes(160000))
  await git('add', '.'); await git('-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Reviewed task commit')
  const head = (await git('rev-parse', 'HEAD')).trim()
  const definition = runtime.verification.definitions.create({ requestId: rid(), enabled: true, definition: { name: 'Repository result', description: 'Check committed result',
    artifactPath: 'result.txt', argv: ['node', '-e', 'if(require("node:fs").readFileSync("result.txt","utf8")!=="reviewed result\\n")process.exit(1)'],
    confinement: process.env.DSH_REMOTE_ISOLATION === '1' ? 'linux-bubblewrap' : 'host-process' } })
  const check = await runtime.verification.request(artifact.id, { requestId: rid(), check: { id: definition.id, version: 1 }, artifactRevision: artifact.revision, artifactHash: artifact.hash })
  await vi.waitFor(async () => { const value = await runtime.verification.refresh(check.id); expect(value.status, value.problem).toBe('passed') }, { timeout: 15000 })
  const request = { requestId: rid(), revision: artifact.revision, hash: artifact.hash, checks: [runtime.verification.approval(check.id).selection] }
  return { ...h, runtime, artifact, request, directory, head, ticket, git }
}

it('stages the exact reviewed history in resumable chunks and verifies it with independent Git', async () => {
  const h = await fixture(), exports = h.runtime.repositoryExports
  const value = await exports.prepare(h.artifact.id, h.request)
  expect(value.phase, value.problem).toBe('ready'); expect(value.bundle).toMatchObject({ base: h.server.commit, head: h.head })
  const before = recoveryStateDigest(h.runtime.store.db)
  await verifyPublicationState(h.runtime.store.db, new AbortController().signal, true)
  expect(recoveryStateDigest(h.runtime.store.db)).toBe(before)
  h.runtime.store.db.prepare('INSERT INTO repository_export_chunk VALUES (?,?,?,?)').run(value.id, -1, Buffer.from('extra'), '0'.repeat(64))
  expect(() => exports.download(value.id)).toThrow('chunks differ')
  h.runtime.store.db.prepare('DELETE FROM repository_export_chunk WHERE id=? AND offset=-1').run(value.id)
  const download = exports.download(value.id), bytes = Buffer.concat([...download.chunks])
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(value.bundle!.sha256)
  const server = createServer((req, res) => { void h.h.http(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const port = (server.address() as { port: number }).port
  ;(h.h.ctx.webServer as { port: number }).port = port
  const url = `http://127.0.0.1:${port}/orchestrator/api/repository-exports/${value.id}/download`, headers = { 'x-orchestrator-request': '1' }
  const response = await fetch(url, { headers })
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  expect((await fetch(url)).status).toBe(403)
  expect((await fetch(url, { headers: { ...headers, origin: 'https://attacker.invalid' } })).status).toBe(403)
  expect(Number(h.runtime.store.db.prepare('SELECT count(*) AS n FROM repository_export_chunk WHERE id=?').get(value.id)!.n)).toBeGreaterThan(1)
  const destination = await mkdtemp(join(tmpdir(), 'dsh-independent-bundle-')); cleanup.push(() => rm(destination, { recursive: true, force: true }))
  const bundle = join(destination, 'repository.bundle'); await writeFile(bundle, bytes)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd: destination, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }).trim()
  git('init', '--quiet'); git('fetch', '--quiet', h.directory, h.server.commit)
  git('bundle', 'verify', bundle); git('fetch', '--quiet', bundle, 'HEAD'); git('checkout', '--quiet', 'FETCH_HEAD')
  expect(git('rev-parse', 'HEAD')).toBe(h.head)
  expect(git('rev-parse', 'HEAD^')).toBe(h.server.commit)
  const count = h.remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-export-')).length
  expect(await exports.prepare(h.artifact.id, h.request)).toEqual(value)
  expect(h.remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-export-'))).toHaveLength(count)
  await exports.stop()
  const recovered = new RepositoryExports({ store: h.runtime.store, verification: h.runtime.verification, reviews: h.runtime.verificationReviews,
    lifetime: h.runtime.lifetime, authorize: () => {}, member: binding => h.runtime.worlds.require(binding) }); cleanup.push(() => recovered.stop())
  expect(Buffer.concat([...recovered.download(value.id).chunks])).toEqual(bytes)
  await recovered.cancel(value.id); expect(() => recovered.download(value.id)).toThrow('not ready')
  await verifyPublicationState(h.runtime.store.db, new AbortController().signal, true)
}, 30000)

it('holds changed source and refuses corrupted staged bytes or a substituted request', async () => {
  const h = await fixture(), exports = h.runtime.repositoryExports
  await writeFile(join(h.directory, 'result.txt'), 'changed after checks\n')
  expect((await exports.prepare(h.artifact.id, h.request)).phase).toBe('held')
  await writeFile(join(h.directory, 'result.txt'), 'reviewed result\n')
  // A failed original command is observed, not rerun after changing the files back.
  expect((await exports.retry(h.request.requestId)).phase).toBe('held')
  const next = { ...h.request, requestId: rid() }, ready = await exports.prepare(h.artifact.id, next)
  expect(ready.phase, ready.problem).toBe('ready')
  expect(() => exports.prepare(h.artifact.id, { ...next, hash: '0'.repeat(64) })).toThrow('another review')
  h.runtime.store.db.prepare('UPDATE repository_export_chunk SET data=? WHERE id=? AND offset=0').run(Buffer.from('corrupt'), ready.id)
  expect(() => exports.download(ready.id)).toThrow('chunks differ')
  await expect(verifyPublicationState(h.runtime.store.db, new AbortController().signal)).rejects.toThrow('repository_export_chunk')
}, 30000)

it('resumes partial bytes after coordinator replacement without dispatching another bundle command', async () => {
  const h = await fixture(), exports = h.runtime.repositoryExports, filesystem = h.member.filesystem, read = filesystem.readByteRange.bind(filesystem)
  let reads = 0
  const interrupted = vi.spyOn(filesystem, 'readByteRange').mockImplementation((...args) => {
    if (++reads === 2) throw new Error('Transfer interrupted')
    return read(...args)
  })
  const held = await exports.prepare(h.artifact.id, h.request)
  expect(held).toMatchObject({ phase: 'held', received: 65536 }); interrupted.mockRestore()
  await verifyPublicationState(h.runtime.store.db, new AbortController().signal)
  await exports.stop()
  const recovered = new RepositoryExports({ store: h.runtime.store, verification: h.runtime.verification, reviews: h.runtime.verificationReviews,
    lifetime: h.runtime.lifetime, authorize: () => {}, member: binding => h.runtime.worlds.require(binding) }); cleanup.push(() => recovered.stop())
  const resumedReads: number[] = []
  vi.spyOn(filesystem, 'readByteRange').mockImplementation((target, options, signal) => { resumedReads.push(options.offset); return read(target, options, signal) })
  expect((await recovered.retry(held.id)).phase).toBe('ready')
  expect(resumedReads[0]).toBe(65536)
  expect(h.remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-export-'))).toHaveLength(1)
  const response = await h.h.api('GET', `repository-exports/${held.id}`)
  expect(response).toMatchObject({ status: 200, body: { phase: 'ready' } })
}, 30000)

it('recovers a lost spawn acknowledgement and rechecks the source after the full transfer', async () => {
  const h = await fixture(), exports = h.runtime.repositoryExports, nativeFetch = globalThis.fetch
  let lost = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(input, init), request = init?.body && JSON.parse(String(init.body))
    if (!lost && request?.op === 'job.spawn' && request.requestId.startsWith('repository-export-')) { lost = true; await response.arrayBuffer(); throw new TypeError('Lost acknowledgement') }
    return response
  })
  const filesystem = h.member.filesystem, read = filesystem.readByteRange.bind(filesystem)
  const changed = vi.spyOn(filesystem, 'readByteRange').mockImplementationOnce(async (...args) => {
    const data = await read(...args); await writeFile(join(h.directory, 'result.txt'), 'changed during transfer\n'); return data
  })
  const held = await exports.prepare(h.artifact.id, h.request)
  expect(lost).toBe(true); expect(held.phase).toBe('held'); expect(held.received).toBe(held.bundle!.bytes)
  expect(() => exports.download(held.id)).toThrow('not ready'); changed.mockRestore()
  await writeFile(join(h.directory, 'result.txt'), 'reviewed result\n')
  expect((await exports.retry(held.id)).phase).toBe('ready')
  expect(h.remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-export-'))).toHaveLength(1)
}, 30000)

it('holds an explicitly unknown original job and refuses cancellation until its outcome is reconciled', async () => {
  const h = await fixture(), exports = h.runtime.repositoryExports
  const interrupted = vi.spyOn(h.member.filesystem, 'readByteRange').mockImplementationOnce(() => { throw new Error('Lost first chunk') })
  const held = await exports.prepare(h.artifact.id, h.request); interrupted.mockRestore()
  expect(held.phase).toBe('held')
  const original = h.remote.endpoint.journal.jobs().find(job => job.id.startsWith('repository-export-'))!, saved = structuredClone(original)
  original.phase = 'unknown'; original.quiescent = null; delete original.outcome; h.remote.endpoint.journal.saveJob(original)
  expect((await exports.retry(held.id)).phase).toBe('held')
  await expect(exports.cancel(held.id)).rejects.toThrow()
  expect(exports.get(held.id).phase).toBe('held')
  expect(h.remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-export-'))).toHaveLength(1)
  h.remote.endpoint.journal.saveJob(saved)
  expect((await exports.cancel(held.id)).phase).toBe('cancelled')
}, 30000)

it('rejects substituted export authority during read-only recovery', async () => {
  const h = await fixture(), value = await h.runtime.repositoryExports.prepare(h.artifact.id, h.request), db = h.runtime.store.db
  expect(value.phase).toBe('ready')
  const original = recoveryStateDigest(db)
  for (const change of [
    (record: any) => { record.commandId += '-other' }, (record: any) => { record.fingerprint = '0'.repeat(64) },
    (record: any) => { record.world = '0'.repeat(64) }, (record: any) => { record.source.commit = 'a'.repeat(40) },
    (record: any) => { record.head = 'a'.repeat(40) }, (record: any) => { record.request.checks[0].evidenceHash = '0'.repeat(64) },
    (record: any) => { record.evidence[0].capture.id = 'substituted' }, (record: any) => { record.bundle.sha256 = '0'.repeat(64) },
    (record: any) => { delete record.evidence }, (record: any) => { record.received-- },
  ]) {
    db.exec('SAVEPOINT export_corruption')
    try {
      const record = JSON.parse(String(db.prepare('SELECT value FROM repository_export WHERE id=?').get(value.id)!.value)); change(record)
      db.prepare('UPDATE repository_export SET value=? WHERE id=?').run(JSON.stringify(record), value.id)
      await expect(verifyPublicationState(db, new AbortController().signal)).rejects.toThrow(/recovery_publications_/)
    } finally { db.exec('ROLLBACK TO export_corruption; RELEASE export_corruption') }
    expect(recoveryStateDigest(db)).toBe(original)
  }
}, 30000)
