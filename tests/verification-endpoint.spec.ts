import { readFile, writeFile, access, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteFixture } from './fixtures/remote.ts'
import type { RemoteJob, OutputWindow } from '../src/remote/protocol.ts'
import { Rpc } from '../src/remote/protocol.ts'
import { validateSnapshot } from '../src/verification/snapshot.ts'
import { VerificationJob } from '../src/verification/model.ts'
import { fingerprint } from '../src/remote/journal.ts'
import { mkdir } from 'node:fs/promises'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
const native = process.env.DSH_REMOTE_ISOLATION === '1'
const hash = (content: string) => createHash('sha256').update(content).digest('hex')
it('runs a check over copied inputs, records exact artifact/source evidence and never repeats a committed job', async () => {
  const h = await remoteFixture(cleanup, { native }), root = h.enrolled.grant.root
  await writeFile(join(root, 'artifact.txt'), 'actual artifact')
  const request = h.spawn('test "$(cat artifact.txt)" = "actual artifact" && printf verified', { verification: {
    kind: 'check', artifact: { path: 'artifact.txt', hash: hash('actual artifact') }, snapshot: { repository: 'none' } } })
  h.lose(); const accepted = await h.client.intent<RemoteJob>(request), result = await h.settled(accepted.id)
  expect(result, result.error).toMatchObject({ phase: 'settled', quiescent: true, outcome: { exitCode: 0 }, verification: {
    kind: 'check', stage: 'finished', artifactHash: hash('actual artifact'), snapshotUnchanged: true, storageReleased: true } })
  expect(result.credentials).toBeUndefined(); expect(validateSnapshot(result.verification!.snapshot!).entries).toHaveLength(1)
  expect(result.verification).toMatchObject({ startedAt: expect.any(String), checkedAt: expect.any(String), finishedAt: expect.any(String),
    output: { stdout: { hash: hash('verified'), bytes: 8 }, stderr: { hash: hash(''), bytes: 0 } } })
  expect((await h.client.call<OutputWindow>({ op: 'job.output', id: accepted.id, stream: 'stdout', offset: 0, limit: 100 })).data).toBe('dmVyaWZpZWQ=')
  await writeFile(join(root, 'artifact.txt'), 'changed')
  expect((await h.client.intent<RemoteJob>(request)).verification).toEqual(result.verification)
  await h.restart(); expect((await h.client.intent<RemoteJob>(request)).verification).toEqual(result.verification)
  await expect(access(join(h.directory, 'control/verification', accepted.id))).rejects.toThrow()
})
it('keeps checked inputs immutable while the source changes and refuses to reuse a stale reviewed snapshot', async () => {
  const h = await remoteFixture(cleanup, { native }), root = h.enrolled.grant.root; await writeFile(join(root, 'artifact'), 'original')
  const request = h.spawn('sleep 0.3; test "$(cat artifact)" = original', { verification: { kind: 'check', artifact: { path: 'artifact', hash: hash('original') } } })
  const accepted = await h.client.intent<RemoteJob>(request)
  await vi.waitFor(async () => expect((await h.client.call<RemoteJob>({ op: 'job.get', id: accepted.id })).verification?.stage).toBe('checking'))
  await writeFile(join(root, 'artifact'), 'changed')
  const result = await h.settled(accepted.id); expect(result.outcome?.exitCode).toBe(0)
  const before = result.verification!.snapshot!.hash
  const captured = await h.client.intent<RemoteJob>(h.spawn('exit 91', { verification: { kind: 'capture' } })), after = await h.settled(captured.id)
  expect(after.verification).toMatchObject({ kind: 'capture', stage: 'finished' }); expect(after.outcome).toBeUndefined()
  expect(after.verification!.snapshot!.hash).not.toBe(before); expect(after.verification?.checkedAt).toBeUndefined()
  const stale = await h.client.intent<RemoteJob>(h.spawn('printf should-not-run', { verification: { kind: 'check', expectedSnapshot: before } }))
  expect(await h.settled(stale.id)).toMatchObject({ error: expect.stringContaining('reviewed snapshot') })
  expect((await h.settled(stale.id)).outcome).toBeUndefined()
})
it('pins Git commit and tree before running a check, including changes without different working bytes', async () => {
  const h = await remoteFixture(cleanup, { native }), root = h.enrolled.grant.root
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q'); await writeFile(join(root, 'file'), 'same bytes'); git('add', 'file')
  const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Snapshot')
  commit(); const expectedRepository = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }
  const good = await h.client.intent<RemoteJob>(h.spawn('test ! -e .git', { verification: { kind: 'check', snapshot: { repository: 'required' }, expectedRepository } }))
  expect(await h.settled(good.id)).toMatchObject({ outcome: { exitCode: 0 }, verification: { snapshot: { repository: expectedRepository } } })
  commit()
  const stale = await h.client.intent<RemoteJob>(h.spawn('exit 0', { verification: { kind: 'check', expectedRepository } }))
  expect(await h.settled(stale.id)).toMatchObject({ error: expect.stringContaining('reviewed revision') })
  expect((await h.settled(stale.id)).outcome).toBeUndefined()
})
it('retains hashes of all output when bounded log retention omits bytes, and stops timed-out checks', async () => {
  const h = await remoteFixture(cleanup, { native, outputMaxBytes: 3 })
  const accepted = await h.client.intent<RemoteJob>(h.spawn('printf abcdefghij; printf failure >&2; exit 7', { verification: { kind: 'check' } }))
  expect(await h.settled(accepted.id)).toMatchObject({ outcome: { exitCode: 7 }, verification: { stage: 'finished', output: {
    stdout: { bytes: 10, hash: hash('abcdefghij') }, stderr: { bytes: 7, hash: hash('failure') } } } })
  const log = await h.client.call<OutputWindow>({ op: 'job.output', id: accepted.id, stream: 'stdout', offset: 0, limit: 100 })
  expect(log).toMatchObject({ retainedBytes: 3, totalBytes: 10 })
  expect((await h.client.call<OutputWindow>({ op: 'job.output', id: accepted.id, stream: 'stdout', offset: 3, limit: 100 })).gap).toBe(true)
  const timeout = await h.client.intent<RemoteJob>(h.spawn('sleep 30', { verification: { kind: 'check', timeoutSeconds: 1 } }))
  const result = await h.settled(timeout.id)
  expect(result.quiescent).toBe(true); expect(result.outcome?.exitCode).not.toBe(0)
})
it('reserves snapshot space before dispatch, refuses grants without reads and advertises capability only when installed', async () => {
  const h = await remoteFixture(cleanup, { native })
  expect(h.endpoint.identity().capabilities.snapshotVerification).toBe(true)
  const accepted = await h.client.intent<RemoteJob>(h.spawn('sleep 30', { verification: { kind: 'check', snapshot: { maxBytes: 1024 * 1024 * 1024 } } }))
  await expect(h.client.intent(h.spawn('true', { verification: { kind: 'check', snapshot: { maxBytes: 1024 * 1024 * 1024 } } }))).rejects.toThrow('2 GiB')
  await h.client.intent({ op: 'job.cancel', id: accepted.id, requestId: 'cancel-reservation' }); await h.settled(accepted.id)
  const grant = h.endpoint.journal.grant(h.enrolled.grant.id); grant.operations = ['process.spawn']; h.endpoint.journal.saveGrant(grant)
  await expect(h.client.intent(h.spawn('true', { verification: { kind: 'capture' } }))).rejects.toThrow()
  grant.operations.push('fs.read'); h.endpoint.journal.saveGrant(grant)
  h.host.snapshotHelper = undefined as any
  expect(h.endpoint.identity().capabilities.snapshotVerification).toBeUndefined()
  await expect(h.client.intent(h.spawn('true', { verification: { kind: 'check' } }))).rejects.toThrow('no snapshot verification')
})
it.runIf(native)('denies even host loopback networking to a verification command', async () => {
  const h = await remoteFixture(cleanup, { native: true }), server = createServer(socket => socket.end('must not connect'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const source = `const net = require('node:net'); const socket = net.connect(${port}, '127.0.0.1'); socket.on('connect', () => process.exit(1)); socket.on('error', () => process.exit(0)); setTimeout(() => process.exit(2), 1000);`
  const accepted = await h.client.intent<RemoteJob>(h.spawn('', { argv: ['node', '-e', source], verification: { kind: 'check' } }))
  expect(await h.settled(accepted.id)).toMatchObject({ outcome: { exitCode: 0 }, verification: { confinement: 'linux-bubblewrap' } })
})
it('recovers a checkpointed verification as unknown, never reruns it, and releases storage only after reconciliation', async () => {
  const h = await remoteFixture(cleanup, { native })
  const request = Rpc.parse({ ...h.spawn('printf forbidden-replay'), verification: VerificationJob.parse({ kind: 'check' }) }) as RemoteJob['request']
  const at = new Date().toISOString(), container = join(h.host.stateDir, 'verification', request.requestId)
  await mkdir(container, { recursive: true }); await writeFile(join(container, 'partial'), 'interrupted capture')
  // Persist the exact on-disk crash boundary without dispatching a process in this test host.
  h.endpoint.journal.saveJob({ id: request.requestId, grantId: h.enrolled.grant.id, epoch: h.enrolled.grant.epoch, revision: request.revision,
    request, fingerprint: fingerprint({ principal: { role: 'grant', id: h.enrolled.grant.id, epoch: h.enrolled.grant.epoch }, request }),
    phase: 'started', quiescent: false, cancelRequested: false, createdAt: at, updatedAt: at,
    verification: { kind: 'check', stage: 'capturing', startedAt: at, confinement: h.isolation.name } })
  await h.restart()
  const unknown = await h.client.intent<RemoteJob>(request)
  expect(unknown).toMatchObject({ phase: 'unknown', quiescent: null, verification: { stage: 'capturing' } }); expect(unknown.outcome).toBeUndefined()
  await access(container)
  await expect(h.client.intent(h.spawn('true', { verification: { kind: 'check' } }))).rejects.toThrow('uncertain prior effect')
  await h.admin.intent({ op: 'job.reconcile', requestId: 'reconcile-capture', id: request.requestId, quiescent: true, note: 'Fixture process range independently confirmed stopped' })
  await vi.waitFor(async () => expect((await h.client.call<RemoteJob>({ op: 'job.get', id: request.requestId })).verification?.storageReleased).toBe(true))
  const result = await h.client.intent<RemoteJob>(request)
  expect(result).toMatchObject({ phase: 'unknown', quiescent: true, verification: { stage: 'capturing' } }); expect(result.outcome).toBeUndefined()
  await expect(access(container)).rejects.toThrow()
  expect((await h.client.call<OutputWindow>({ op: 'job.output', id: request.requestId, stream: 'stdout', offset: 0, limit: 100 })).totalBytes).toBe(0)
})
it('does not turn a timed-out command that traps termination into a passing check', async () => {
  const h = await remoteFixture(cleanup, { native })
  const accepted = await h.client.intent<RemoteJob>(h.spawn("trap 'exit 0' TERM; while :; do sleep 0.1; done", { verification: { kind: 'check', timeoutSeconds: 1 } }))
  const result = await h.settled(accepted.id)
  expect(result.error).toBeTruthy(); expect(result.verification?.stage).toBe('checking')
  expect(result.verification?.snapshotUnchanged).not.toBe(true)
})
it('preserves unexpected existing snapshot storage until its original process range is reconciled', async () => {
  const h = await remoteFixture(cleanup, { native }), request = h.spawn('printf must-not-run', { verification: { kind: 'check' } })
  const container = join(h.host.stateDir, 'verification', request.requestId)
  await mkdir(container, { recursive: true }); await writeFile(join(container, 'unobserved'), 'retained')
  await h.client.intent(request)
  await vi.waitFor(async () => expect((await h.client.call<RemoteJob>({ op: 'job.get', id: request.requestId })).phase).toBe('unknown'))
  expect(await readFile(join(container, 'unobserved'), 'utf8')).toBe('retained')
  expect((await h.client.call<RemoteJob>({ op: 'job.get', id: request.requestId })).verification?.storageReleased).not.toBe(true)
  await h.admin.intent({ op: 'job.reconcile', requestId: 'release-unobserved', id: request.requestId, quiescent: true, note: 'Fixture confirms no original process survives' })
  await vi.waitFor(async () => expect((await h.client.call<RemoteJob>({ op: 'job.get', id: request.requestId })).verification?.storageReleased).toBe(true))
})
it('refuses to verify a replacement of the enrolled workspace root', async () => {
  const h = await remoteFixture(cleanup, { native }), root = h.enrolled.grant.root
  await rename(root, `${root}-original`); await mkdir(root); await writeFile(join(root, 'replacement'), 'different directory identity')
  const accepted = await h.client.intent<RemoteJob>(h.spawn('true', { verification: { kind: 'check' } }))
  const result = await h.settled(accepted.id)
  expect(result.error).toContain('identity changed'); expect(result.outcome).toBeUndefined(); expect(result.verification?.snapshot).toBeUndefined()
})
it('pins the coordinator owner and fences a multi-stage check when that ownership ends', async () => {
  const authority = await ownershipAuthority(cleanup), owner = new CoordinatorOwnership(authority.config)
  cleanup.push(() => owner.close())
  const h = await remoteFixture(cleanup, { native, ownership: authority.resource, access: owner, beforeEnroll: async () => { await owner.start() } })
  const stamp = owner.status().owner
  const good = await h.client.intent<RemoteJob>(h.spawn('printf authorized', { verification: { kind: 'check' } }))
  expect(await h.settled(good.id)).toMatchObject({ ownership: stamp, outcome: { exitCode: 0 }, verification: { stage: 'finished' } })
  const interrupted = await h.client.intent<RemoteJob>(h.spawn('sleep 0.5; exit 0', { verification: { kind: 'check' } }))
  await vi.waitFor(async () => expect((await h.client.call<RemoteJob>({ op: 'job.get', id: interrupted.id })).verification?.stage).toBe('checking'))
  await owner.close()
  const result = await h.settled(interrupted.id)
  expect(result.ownership).toEqual(stamp); expect(result.error).toBeTruthy(); expect(result.verification?.stage).not.toBe('finished')
})
it('refuses artifact mismatch and reports failed checks without manufacturing a passing verification', async () => {
  const h = await remoteFixture(cleanup, { native }), root = h.enrolled.grant.root; await writeFile(join(root, 'artifact.txt'), 'actual')
  const wrong = await h.client.intent<RemoteJob>(h.spawn('printf should-not-run', { verification: { kind: 'check', artifact: { path: 'artifact.txt', hash: hash('wrong') } } }))
  expect(await h.settled(wrong.id)).toMatchObject({ phase: 'settled', quiescent: true, error: expect.stringContaining('do not match') })
  expect((await h.client.call<OutputWindow>({ op: 'job.output', id: wrong.id, stream: 'stdout', offset: 0, limit: 100 })).data).toBe('')
  const failed = await h.client.intent<RemoteJob>(h.spawn('exit 7', { verification: { kind: 'check' } }))
  expect(await h.settled(failed.id)).toMatchObject({ outcome: { exitCode: 7 }, verification: { snapshotUnchanged: true } })
})
it('cancels a live check through the original managed range and keeps its cancellation receipt', async () => {
  const h = await remoteFixture(cleanup, { native }); await writeFile(join(h.enrolled.grant.root, 'artifact'), 'proof')
  const accepted = await h.client.intent<RemoteJob>(h.spawn('sleep 30', { verification: { kind: 'check' } }))
  await vi.waitFor(async () => { expect((await h.client.call<RemoteJob>({ op: 'job.get', id: accepted.id })).verification?.stage).toBe('checking') })
  await h.client.intent({ op: 'job.cancel', requestId: 'cancel-check', id: accepted.id })
  const result = await h.settled(accepted.id)
  expect(result.cancelRequested).toBe(true); expect(result.verification?.stage).not.toBe('finished')
  expect((await h.client.intent<RemoteJob>(h.spawn('true', { requestId: accepted.id, verification: { kind: 'check' } })).catch(error => String(error)))).toContain('already used')
})
it.runIf(native)('enforces read-only copied sources, hides the original workspace and omits credential mounts', async () => {
  const h = await remoteFixture(cleanup, { native: true }), root = h.enrolled.grant.root
  await writeFile(join(root, 'source'), 'original')
  const request = h.spawn('test ! -e "$1" && ! printf changed > source && test "$(cat source)" = original && test ! -d /run/dsh-credentials', {
    argv: ['/bin/sh', '-c', 'test ! -e "$1" && ! (printf changed > source) && test "$(cat source)" = original && test ! -d /run/dsh-credentials', 'verify', root],
    verification: { kind: 'check' } })
  const accepted = await h.client.intent<RemoteJob>(request), result = await h.settled(accepted.id)
  expect(result, result.error).toMatchObject({ outcome: { exitCode: 0 }, verification: { confinement: 'linux-bubblewrap', snapshotUnchanged: true } })
  expect(await readFile(join(root, 'source'), 'utf8')).toBe('original')
})
