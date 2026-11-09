import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionHeader, type SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lockSync } from 'proper-lockfile'
import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { Runtime } from '../src/app/runtime.ts'
import { testMachine } from './fixtures/deployment.ts'
import { createRecoveryKey } from '../src/recovery/crypto.ts'
import { createCheckpoint, importCheckpointSessions, stageCheckpoint, verifyCheckpoint } from '../src/recovery/checkpoint.ts'
import { exportSession, importSession, inspectSession, ownSessions, withVerifiedSessionBackend } from '../src/recovery/sessions.ts'
import { WorldJournal, worldBinding } from '../src/remote/world-journal.ts'
import type { RevocationReceipt } from '../src/remote/protocol.ts'
import { remoteFixture } from './fixtures/remote.ts'
import * as Recovery from '../src/recovery/index.ts'
import { reserveCheckpointOwnership } from '../src/recovery/ownership.ts'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { OwnershipClient } from '../src/ownership/client.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import type { OwnershipClaim, OwnershipRequest, OwnershipView, RecoveryClaim } from '../src/ownership/protocol.ts'
import { OwnershipError } from '../src/ownership/protocol.ts'
import { privateCredential } from '../src/environments/endpoint-files.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const signal = () => new AbortController().signal
const header = (id: string, extra: Partial<SessionHeader> = {}) => ({ ...Session.create(SessionId(id)).header, ...extra })
const event = (seq: number, text = `Evidence ${seq}`): SessionEvent => ({ type: 'user/message', seq: SessionSeq(seq), time: seq,
  surfaceOp: 'append', data: { role: 'user', id: MessageId(`message-${seq}`), source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text }] } })
async function backend(root: string, ctx = new Context()): Promise<SessionPersistence> {
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  cleanup.push(() => ctx.fiber.dispose())
  return ctx.sessionPersistence
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-recovery-test-')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const stateDir = join(directory, 'state'), outputDir = join(directory, 'backups'), keyFile = join(directory, 'key')
  await mkdir(stateDir, { mode: 0o700 }); createRecoveryKey(keyFile)
  const store = new Store(join(stateDir, 'orchestrator.sqlite')); store.set(KV.runtime.masterId, 'recovery-master'); store.close()
  const context = new Context(), persistence = await backend(join(directory, 'sessions'), context)
  const writer = await persistence.create(header('recovery-master'))
  await writer.append([event(0, 'private archive evidence')]); await writer.close()
  return { directory, stateDir, outputDir, keyFile, persistence, context }
}

async function ownedCheckpoint() {
  const f = await fixture(), authority = await ownershipAuthority(cleanup)
  const store = new Store(join(f.stateDir, 'orchestrator.sqlite'))
  store.set(KV.runtime.ownership, { authorityId: authority.config.authorityId, coordinatorId: authority.config.coordinatorId, credentialFile: authority.config.credentialFile })
  store.close()
  const saved = await createCheckpoint(f), destination = join(f.directory, 'held')
  await stageCheckpoint(saved.path, f.keyFile, destination)
  const options = { checkpoint: saved.path, keyFile: f.keyFile, destination, authority: { ...authority.admin.connection, coordinatorId: 'coordinator' },
    requestId: randomUUID(), epoch: 0, generation: 0 }
  return { ...f, authority, saved, destination, options }
}

it('reserves only the authenticated held snapshot, writes a private replacement credential and keeps execution held', async () => {
  const f = await ownedCheckpoint(), result = await reserveCheckpointOwnership(f.options)
  expect(result).toMatchObject({ phase: 'reserved', recovery: { checkpoint: f.saved.manifest.id, generation: 1 } })
  expect(await reserveCheckpointOwnership(f.options)).toEqual(result)
  const credential = privateCredential(result.credentialFile)
  expect(JSON.stringify(result)).not.toContain(credential)
  const store = new Store(join(f.destination, 'orchestrator.sqlite'))
  expect(store.get(KV.recovery.hold)).toMatchObject({ state: 'staged', checkpoint: f.saved.manifest.id })
  expect(store.get(KV.recovery.reservation)).toEqual(result); store.close()
  await expect(f.authority.claimant.call({ op: 'lease.acquire', requestId: randomUUID(), instanceId: randomUUID(), leaseMs: 3000 })).rejects.toThrow('replaced')
  const context = new Context(); cleanup.push(() => context.fiber.dispose())
  expect(() => new Runtime(context, testMachine({ stateDir: f.destination }), () => {})).toThrow('staged checkpoint restore')
  const wrongState = new CoordinatorOwnership({ ...f.authority.config, credentialFile: result.credentialFile })
  cleanup.push(() => wrongState.close())
  await expect(wrongState.start()).rejects.toThrow('does not match the independently reserved')
  await wrongState.close()
  expect(await f.authority.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })).toMatchObject({ phase: 'vacant' })
  const moved = join(f.directory, 'moved'); await rename(f.destination, moved)
  await expect(reserveCheckpointOwnership({ ...f.options, destination: moved })).rejects.toThrow('automatic remapping is not supported')
})

it('recovers a lost reservation acknowledgement with its original request after the authority restarts', async () => {
  const f = await ownedCheckpoint(), call = OwnershipClient.prototype.call; let lose = true, unauthorized = false
  vi.spyOn(OwnershipClient.prototype, 'call').mockImplementation(async function<T>(this: OwnershipClient, request: OwnershipRequest, signal?: AbortSignal): Promise<T> {
    if (request.op === 'coordinator.recover' && unauthorized) throw new OwnershipError(401, 'unauthorized', 'Administrator unavailable')
    const result = await call.call(this, request, signal)
    if (request.op === 'coordinator.recover' && lose) { lose = false; throw new Error('Lost committed reservation response') }
    return result as T
  })
  await expect(reserveCheckpointOwnership(f.options)).rejects.toThrow('Lost committed')
  unauthorized = true
  await expect(reserveCheckpointOwnership(f.options)).rejects.toThrow('Administrator unavailable')
  await expect(reserveCheckpointOwnership({ ...f.options, requestId: randomUUID(), generation: 1 })).rejects.toThrow('original recovery reservation')
  unauthorized = false
  f.authority.restart()
  const result = await reserveCheckpointOwnership(f.options)
  expect(result.recovery?.generation).toBe(1)
  expect((await f.authority.admin.call<{ recovery: unknown }>({ op: 'coordinator.inspect', id: 'coordinator' })).recovery).toEqual(result.recovery)
})

it('retains the committed reservation when private credential publication fails and retries without rotating again', async () => {
  const f = await ownedCheckpoint(), call = OwnershipClient.prototype.call, file = join(f.destination, 'recovery-claimant.token'); let interfere = true
  vi.spyOn(OwnershipClient.prototype, 'call').mockImplementation(async function<T>(this: OwnershipClient, request: OwnershipRequest, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'coordinator.recover' && interfere) { interfere = false; await writeFile(file, 'x'.repeat(40), { mode: 0o600 }) }
    return result as T
  })
  await expect(reserveCheckpointOwnership(f.options)).rejects.toThrow('existing operator file differs')
  const held = new Store(join(f.destination, 'orchestrator.sqlite'))
  expect(held.get(KV.recovery.reservation)?.phase).toBe('requested'); expect(held.get(KV.recovery.hold)?.state).toBe('staged'); held.close()
  await rm(file)
  expect((await reserveCheckpointOwnership(f.options)).recovery?.generation).toBe(1)
})

it('persists uncertainty again when a previously refused request is retried and its commit acknowledgement is lost', async () => {
  const f = await ownedCheckpoint(), options = { ...f.options, epoch: 1 }
  const claim = await f.authority.claimant.call<OwnershipClaim>({ op: 'lease.acquire', requestId: randomUUID(), instanceId: randomUUID(), leaseMs: 3000 })
  await expect(reserveCheckpointOwnership(options)).rejects.toThrow('vacant ownership')
  await f.authority.admin.withCredential(claim.credential).call({ op: 'lease.release', requestId: randomUUID() })
  const call = OwnershipClient.prototype.call; let lose = true
  vi.spyOn(OwnershipClient.prototype, 'call').mockImplementation(async function<T>(this: OwnershipClient, request: OwnershipRequest, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'coordinator.recover' && lose) { lose = false; throw new Error('Lost retried commit acknowledgement') }
    return result as T
  })
  await expect(reserveCheckpointOwnership(options)).rejects.toThrow('Lost retried commit')
  await expect(reserveCheckpointOwnership({ ...options, requestId: randomUUID(), generation: 1 })).rejects.toThrow('original recovery reservation')
  expect((await reserveCheckpointOwnership(options)).recovery?.generation).toBe(1)
})

it('does not publish a credential after cancellation following committed reservation inspection', async () => {
  const f = await ownedCheckpoint(), call = OwnershipClient.prototype.call, abort = new AbortController()
  vi.spyOn(OwnershipClient.prototype, 'call').mockImplementation(async function<T>(this: OwnershipClient, request: OwnershipRequest, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'coordinator.inspect') abort.abort(new Error('Maintenance cancelled'))
    return result as T
  })
  await expect(reserveCheckpointOwnership({ ...f.options, signal: abort.signal })).rejects.toThrow('Maintenance cancelled')
  expect(await readdir(f.destination)).not.toContain('recovery-claimant.token')
  vi.restoreAllMocks()
  expect((await reserveCheckpointOwnership(f.options)).recovery?.generation).toBe(1)
})

it('refuses a superseded reservation instead of writing or adopting the newer selection', async () => {
  const f = await ownedCheckpoint(), call = OwnershipClient.prototype.call; let lose = true
  vi.spyOn(OwnershipClient.prototype, 'call').mockImplementation(async function<T>(this: OwnershipClient, request: OwnershipRequest, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'coordinator.recover' && lose) { lose = false; throw new Error('Lost reservation response') }
    return result as T
  })
  await expect(reserveCheckpointOwnership(f.options)).rejects.toThrow('Lost reservation response')
  const newer = await f.authority.admin.call<RecoveryClaim>({ op: 'coordinator.recover', requestId: randomUUID(), id: 'coordinator', epoch: 0,
    generation: 1, selection: { checkpoint: randomUUID(), digest: 'a'.repeat(64) } })
  await expect(reserveCheckpointOwnership(f.options)).rejects.toThrow('reservation was superseded')
  expect(await readdir(f.destination)).not.toContain('recovery-claimant.token')
  expect(await f.authority.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })).toMatchObject({ recovery: newer.recovery })
})

it('selects one of two competing held copies and still requires the selected ownership client to clear the resource barrier', async () => {
  const f = await ownedCheckpoint(), other = join(f.directory, 'other-held')
  await stageCheckpoint(f.saved.path, f.keyFile, other)
  const results = await Promise.allSettled([reserveCheckpointOwnership(f.options), reserveCheckpointOwnership({ ...f.options,
    destination: other, requestId: randomUUID() })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const reserved = results.find(result => result.status === 'fulfilled')!.value
  const owner = new CoordinatorOwnership({ ...f.authority.config, credentialFile: reserved.credentialFile }, reserved.recovery)
  cleanup.push(() => owner.close())
  const started = owner.start()
  try {
    await vi.waitFor(() => expect(owner.status().phase).toBe('preparing'))
    expect(() => owner.proof()).toThrow('unavailable')
    const view = await f.authority.admin.call<OwnershipView>({ op: 'coordinator.inspect', id: 'coordinator' })
    await new OwnershipClient(f.authority.resource).call({ op: 'resource.acknowledge', requestId: randomUUID(), stamp: view.owner! })
    await started; expect(owner.proof()).toMatch(/^lease\./)
  } finally { await owner.close(); await started.catch(() => {}) }
  const held = new Store(join(reserved.credentialFile, '..', 'orchestrator.sqlite'))
  expect(held.get(KV.recovery.hold)?.state).toBe('staged'); held.close()
})

it('permits a reviewed replacement only after a definitive refusal, and refuses tampered checkpoint data before rotating authority', async () => {
  const f = await ownedCheckpoint()
  await expect(reserveCheckpointOwnership({ ...f.options, epoch: 4 })).rejects.toThrow('reviewed epoch')
  await expect(reserveCheckpointOwnership(f.options)).rejects.toThrow('original recovery reservation')
  const accepted = await reserveCheckpointOwnership({ ...f.options, requestId: randomUUID() })
  expect(accepted.phase).toBe('reserved')
  const store = new Store(join(f.destination, 'orchestrator.sqlite')); store.set(KV.runtime.masterId, 'substituted'); store.close()
  await expect(reserveCheckpointOwnership({ ...f.options, requestId: accepted.request.requestId })).rejects.toThrow('matching staged coordinator')
})

it('detects changed queued effects and conflicting replacement files before changing recovery authority', async () => {
  const f = await ownedCheckpoint(), file = join(f.destination, 'recovery-claimant.token')
  await writeFile(file, 'x'.repeat(40), { mode: 0o600 })
  await expect(reserveCheckpointOwnership(f.options)).rejects.toThrow('pre-existing replacement')
  await rm(file)
  const store = new Store(join(f.destination, 'orchestrator.sqlite')); store.set('unverified-input', 'extra work'); store.close()
  await expect(reserveCheckpointOwnership(f.options)).rejects.toThrow('differs from the authenticated checkpoint')
  expect(await f.authority.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })).not.toHaveProperty('recovery')
})

it('captures encrypted coordinator data and owned Session descendants, verifies every member, and stages a fenced restore', async () => {
  const f = await fixture()
  const source = new Store(join(f.stateDir, 'orchestrator.sqlite'))
  source.set(KV.runtime.ownership, { authorityId: 'authority', coordinatorId: 'coordinator', credentialFile: '/private/claimant.token' })
  source.set(KV.runtime.publication, { serviceId: 'publication', credentialFile: '/private/publication-client.token' }); source.close()
  for (const [id, parentSession] of [['child', 'recovery-master'], ['grandchild', 'child'], ['unrelated', undefined]] as const) {
    const writer = await f.persistence.create(header(id, parentSession ? { parentSession: SessionId(parentSession) } : {}))
    await writer.append([event(0, id)]); await writer.close()
  }
  const result = await createCheckpoint(f)
  expect(result.manifest.requiredFiles).toEqual(['/private/claimant.token', '/private/publication-client.token'])
  expect(result.manifest.sessions.map(item => item.id).sort()).toEqual(['child', 'grandchild', 'recovery-master'])
  expect(await verifyCheckpoint(result.path, f.keyFile)).toEqual(result.manifest)
  for (const name of await readdir(result.path)) expect((await readFile(join(result.path, name))).toString()).not.toContain('private archive evidence')
  const destination = join(f.directory, 'restored')
  await stageCheckpoint(result.path, f.keyFile, destination)
  const store = new Store(join(destination, 'orchestrator.sqlite'))
  expect(store.get(KV.recovery.hold)).toMatchObject({ checkpoint: result.manifest.id, state: 'staged' }); store.close()
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  expect(() => new Runtime(ctx, testMachine({ stateDir: destination }), () => {})).toThrow('staged checkpoint restore')
  // A refusal releases the state lock, rather than stranding the staged data.
  const release = lockSync(destination); release()
  await expect(stageCheckpoint(result.path, f.keyFile, destination)).rejects.toThrow('existing destination')
})

it('refuses an active coordinator or Session writer and publishes nothing after a failed capture', async () => {
  const f = await fixture(), release = lockSync(f.stateDir)
  try { await expect(createCheckpoint(f)).rejects.toThrow('already being held') } finally { release() }
  const writer = await f.persistence.open(SessionId('recovery-master'), 'write')
  try { await expect(createCheckpoint(f)).rejects.toThrow() } finally { await writer.close() }
  expect(await readdir(f.outputDir)).toEqual([])
  const next = await createCheckpoint(f); expect(next.manifest.sessions).toHaveLength(1)
})

it('rejects corrupted ciphertext, the wrong key and truncated members before publishing any restore', async () => {
  const f = await fixture(), result = await createCheckpoint(f)
  const other = join(f.directory, 'other-key'); createRecoveryKey(other)
  await expect(verifyCheckpoint(result.path, other)).rejects.toThrow()
  const member = result.manifest.files[0]!.member, file = join(result.path, member), original = await readFile(file)
  const corrupt = Buffer.from(original); corrupt[0] = corrupt[0]! ^ 1; await writeFile(file, corrupt)
  const target = join(f.directory, 'failed-restore')
  await expect(stageCheckpoint(result.path, f.keyFile, target)).rejects.toThrow()
  expect(await readdir(f.directory)).not.toContain('failed-restore')
  await writeFile(file, original.subarray(0, original.length - 1))
  await expect(verifyCheckpoint(result.path, f.keyFile)).rejects.toThrow()
  await writeFile(file, original)
  expect((await verifyCheckpoint(result.path, f.keyFile)).id).toBe(result.manifest.id)
})

it('imports real Harness logs and fork metadata, retries an exact prefix, and refuses conflicting or newer history', async () => {
  const f = await fixture(), id = SessionId('forked'), meta = header(id, { isSeeded: true, parentSession: SessionId('recovery-master') })
  const seededEvent = (seq: number): SessionEvent => seq === 200 ? { type: 'session/end-seed', seq: SessionSeq(seq), time: seq, data: { inherited: true } } : event(seq)
  const writer = await f.persistence.create(meta, { inheritedEventCount: SessionLogOffset(200) })
  await writer.append(Array.from({ length: 260 }, (_, i) => seededEvent(i)))
  const file = join(f.directory, 'archive.jsonl'), archive = await exportSession(writer, file, 'session.bin', signal()); await writer.close()
  expect(archive.eventCount).toBe(260); expect(archive.inheritedEventCount).toBe(200)
  const target = await backend(join(f.directory, 'target'))
  const initial = Array.from({ length: 201 }, (_, i) => seededEvent(i))
  const prefix = await target.create(meta, { inheritedEventCount: SessionLogOffset(200) }); await prefix.append(initial); await prefix.close()
  await importSession(target, file, archive, signal()); await importSession(target, file, archive, signal())
  const empty = await backend(join(f.directory, 'empty-fork-target')); await importSession(empty, file, archive, signal())
  const unrelated = await empty.create(header('unrelated')); await unrelated.flush(); await unrelated.close()
  const create = vi.spyOn(empty, 'create'), opened = empty.open.bind(empty), reads: number[] = []
  vi.spyOn(empty, 'open').mockImplementation(async (...args) => {
    const handle = await opened(...args), read = handle.read.bind(handle)
    vi.spyOn(handle, 'append').mockImplementation(async () => { throw new Error('Verification must not append') })
    vi.spyOn(handle, 'read').mockImplementation(async (offset, length, options) => {
      reads.push(length!); return read(offset, Math.min(length!, 17), options)
    })
    return handle
  })
  await withVerifiedSessionBackend(empty, f.directory, [{ ...archive, member: 'archive.jsonl' }], signal(), async (summary, recheck) => {
    expect(summary).toEqual({ sessions: 1, events: 260 })
    await expect(opened(id, 'write')).rejects.toThrow()
    await recheck()
  })
  expect(create).not.toHaveBeenCalled(); expect(Math.max(...reads)).toBeLessThanOrEqual(128)
  vi.mocked(empty.open).mockRestore()
  const released = await opened(id, 'write'); await released.close()
  const complete = await empty.open(id, 'read'); expect((await complete.read()).events).toHaveLength(260); await complete.close()
  const restored = await target.open(id, 'write')
  expect((await restored.read()).events).toHaveLength(260)
  await restored.append([event(260)]); await restored.close()
  await expect(importSession(target, file, archive, signal())).rejects.toThrow('newer')
  const different = await backend(join(f.directory, 'different'))
  const conflict = await different.create(meta, { inheritedEventCount: SessionLogOffset(200) }); await conflict.append([event(0, 'Different history'), ...initial.slice(1)]); await conflict.close()
  await expect(importSession(different, file, archive, signal())).rejects.toThrow('diverges')
  const unchanged = await different.open(id, 'read'); expect((await unchanged.read()).events).toHaveLength(201); await unchanged.close()
})

async function sessionVerificationFixture() {
  const f = await fixture(), owned = await ownSessions(f.persistence, ['recovery-master'], signal()), file = join(f.directory, 'session.bin')
  const archive = await exportSession(owned[0]!, file, 'session.bin', signal()); await owned[0]!.close()
  const target = await backend(join(f.directory, 'destination-sessions'))
  return { ...f, file, archive, target }
}

it.each(['missing', 'shorter', 'diverges', 'newer', 'cwd', 'parent', 'preset', 'depth'] as const)('refuses %s destination Session history without repairing it', async kind => {
  const f = await sessionVerificationFixture(), changes: Partial<SessionHeader> = kind === 'cwd' ? { cwd: '/different' }
    : kind === 'parent' ? { parentSession: SessionId('different-parent') } : kind === 'preset' ? { agentPreset: 'different-preset' }
      : kind === 'depth' ? { delegationDepth: 1 } : {}
  if (kind !== 'missing') {
    const writer = await f.target.create({ ...f.archive.header, ...changes })
    if (kind !== 'shorter') await writer.append([event(0, kind === 'diverges' ? 'different' : 'private archive evidence')])
    if (kind === 'newer') await writer.append([event(1)])
    await writer.flush(); await writer.close()
  }
  const action = vi.fn(), create = vi.spyOn(f.target, 'create')
  const error = ['cwd', 'parent', 'preset', 'depth'].includes(kind) ? 'metadata differs' : kind
  await expect(withVerifiedSessionBackend(f.target, f.directory, [f.archive], signal(), action)).rejects.toThrow(error)
  expect(action).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  if (kind !== 'missing') {
    const writer = await f.target.open(SessionId('recovery-master'), 'write')
    expect((await writer.read()).events).toHaveLength(kind === 'shorter' ? 0 : kind === 'newer' ? 2 : 1)
    await writer.close()
  }
})

it('requires the exact destination inherited boundary before reading history', async () => {
  const f = await sessionVerificationFixture(), meta = header('fork', { parentSession: SessionId('recovery-master'), isSeeded: true })
  const source = await f.persistence.create(meta, { inheritedEventCount: SessionLogOffset(1) })
  await source.append([event(0), { type: 'session/end-seed', seq: SessionSeq(1), time: 1, data: { inherited: true } }])
  const archive = await exportSession(source, join(f.directory, 'fork.bin'), 'fork.bin', signal()); await source.close()
  const different = await f.target.create(meta, { inheritedEventCount: SessionLogOffset(2) })
  await different.append([event(0), event(1), { type: 'session/end-seed', seq: SessionSeq(2), time: 2, data: { inherited: true } }]); await different.close()
  await expect(withVerifiedSessionBackend(f.target, f.directory, [archive], signal(), vi.fn())).rejects.toThrow('inherited prefix differs')
})

it('refuses extra descendants, including descendants created after comparison, while permitting unrelated Sessions', async () => {
  const f = await sessionVerificationFixture(); await importSession(f.target, f.file, f.archive, signal())
  const unrelated = await f.target.create(header('independent')); await unrelated.flush(); await unrelated.close()
  await expect(withVerifiedSessionBackend(f.target, f.directory, [f.archive], signal(), async (_, recheck) => {
    const child = await f.target.create(header('late-child', { parentSession: SessionId('recovery-master') })); await child.flush(); await child.close()
    await recheck()
  })).rejects.toThrow('extra related descendant')
  await expect(withVerifiedSessionBackend(f.target, f.directory, [f.archive], signal(), vi.fn())).rejects.toThrow('extra related descendant')
  const released = await f.target.open(SessionId('recovery-master'), 'write'); await released.close()
})

it('releases all previously acquired destination writers when another Session is already owned', async () => {
  const f = await sessionVerificationFixture(); await importSession(f.target, f.file, f.archive, signal())
  const source = await f.persistence.create(header('z-child', { parentSession: SessionId('recovery-master') }))
  await source.append([event(0)])
  const archive = await exportSession(source, join(f.directory, 'child.bin'), 'child.bin', signal()); await source.close()
  await importSession(f.target, join(f.directory, 'child.bin'), archive, signal())
  const child = await f.target.open(SessionId('z-child'), 'write')
  try {
    await expect(withVerifiedSessionBackend(f.target, f.directory, [f.archive, archive], signal(), vi.fn())).rejects.toThrow()
    const released = await f.target.open(SessionId('recovery-master'), 'write'); await released.close()
  } finally { await child.close() }
})

it.each(['read', 'action'] as const)('releases destination writers after cancellation during %s', async phase => {
  const f = await sessionVerificationFixture(); await importSession(f.target, f.file, f.archive, signal())
  const abort = new AbortController(), opened = f.target.open.bind(f.target)
  if (phase === 'read') vi.spyOn(f.target, 'open').mockImplementation(async (...args) => {
    const handle = await opened(...args), read = handle.read.bind(handle)
    vi.spyOn(handle, 'read').mockImplementation(async (...args) => { abort.abort(new Error('Cancelled verification')); return read(...args) })
    return handle
  })
  await expect(withVerifiedSessionBackend(f.target, f.directory, [f.archive], abort.signal, async (_, recheck) => {
    abort.abort(new Error('Cancelled verification')); await recheck()
  })).rejects.toThrow('Cancelled verification')
  const released = await opened(SessionId('recovery-master'), 'write'); await released.close()
})

it('rejects corrupted archives before claiming destination writers and rechecks bytes during comparison', async () => {
  const f = await sessionVerificationFixture(); await importSession(f.target, f.file, f.archive, signal())
  const original = await readFile(f.file, 'utf8'), open = vi.spyOn(f.target, 'open')
  await writeFile(f.file, original.slice(0, -1))
  await expect(withVerifiedSessionBackend(f.target, f.directory, [f.archive], signal(), vi.fn())).rejects.toThrow('digest')
  expect(open).not.toHaveBeenCalled(); open.mockRestore(); await writeFile(f.file, original)
  const opened = f.target.open.bind(f.target)
  vi.spyOn(f.target, 'open').mockImplementation(async (...args) => {
    const handle = await opened(...args); await writeFile(f.file, original.slice(0, -1)); return handle
  })
  await expect(withVerifiedSessionBackend(f.target, f.directory, [f.archive], signal(), vi.fn())).rejects.toThrow('digest')
  const released = await opened(SessionId('recovery-master'), 'write'); await released.close()
})

it('refuses replacement of the selected backend while its original writer handles remain held', async () => {
  const f = await sessionVerificationFixture(); await importSession(f.target, f.file, f.archive, signal())
  let identity = f.target.identity
  const persistence = new Proxy(f.target, { get(target, property) {
    if (property === 'identity') return identity
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } })
  await expect(withVerifiedSessionBackend(persistence, f.directory, [f.archive], signal(), async (_, recheck) => {
    identity = Symbol('replacement backend'); await recheck()
  })).rejects.toThrow('backend changed')
  const released = await f.target.open(SessionId('recovery-master'), 'write'); await released.close()
})

it('validates a complete Session archive before creating destination history and releases earlier claims on conflict', async () => {
  const f = await fixture(), owned = await ownSessions(f.persistence, ['recovery-master'], signal()), file = join(f.directory, 'session.jsonl')
  const archive = await exportSession(owned[0]!, file, 'session.bin', signal()); await owned[0]!.close()
  await writeFile(file, (await readFile(file, 'utf8')).replace('private archive evidence', 'tampered archive evidence'))
  await expect(inspectSession(file, archive, signal())).rejects.toThrow('digest')
  const target = await backend(join(f.directory, 'empty-target'))
  await expect(importSession(target, file, archive, signal())).rejects.toThrow('digest')
  expect(await target.list()).toEqual([])
  const child = await f.persistence.create(header('z-child', { parentSession: SessionId('recovery-master') }))
  await expect(ownSessions(f.persistence, ['recovery-master'], signal())).rejects.toThrow()
  const parent = await f.persistence.open(SessionId('recovery-master'), 'write'); await parent.close(); await child.close()
})

it('checks exact archive bytes, refuses symbolic links and aborts without publishing', async () => {
  const f = await fixture(), owned = await ownSessions(f.persistence, ['recovery-master'], signal()), file = join(f.directory, 'session.jsonl')
  const archive = await exportSession(owned[0]!, file, 'session.bin', signal()); await owned[0]!.close()
  const original = await readFile(file, 'utf8')
  for (const changed of [original.slice(0, -1), original.replaceAll('\n', '\r\n')]) {
    await writeFile(file, changed)
    await expect(inspectSession(file, archive, signal())).rejects.toThrow('digest')
  }
  await writeFile(file, original)
  const link = join(f.directory, 'link'); await symlink(file, link)
  await expect(inspectSession(link, archive, signal())).rejects.toThrow()
  await expect(createCheckpoint({ ...f, signal: AbortSignal.abort(new Error('Capture cancelled')) })).rejects.toThrow('Capture cancelled')
  expect(await readdir(f.outputDir)).toEqual([])
  expect((await createCheckpoint(f)).manifest.masterId).toBe('recovery-master')
})

it('publishes a host maintenance completion receipt only after the checkpoint verifies', async () => {
  const f = await fixture(), receiptFile = join(f.directory, 'maintenance-result.json')
  await f.context.plugin(Recovery, { mode: 'checkpoint', stateDir: f.stateDir, outputDir: f.outputDir, keyFile: f.keyFile, receiptFile })
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
  expect(receipt).toMatchObject({ version: 1, mode: 'checkpoint', executionOwnership: false })
  expect((await verifyCheckpoint(receipt.path, f.keyFile)).id).toBe(receipt.checkpoint)
})

it('refuses missing Session history and missing dedicated journals before publication', async () => {
  const f = await fixture(), store = new Store(join(f.stateDir, 'orchestrator.sqlite'))
  store.set(KV.sessions.prompts('worker-lost'), [1]); store.close()
  await expect(createCheckpoint(f)).rejects.toThrow('recorded Harness Session')
  expect(await readdir(f.outputDir)).toEqual([])
  const db = new DatabaseSync(join(f.stateDir, 'orchestrator.sqlite'))
  db.prepare('DELETE FROM kv WHERE key=?').run(KV.sessions.prompts('worker-lost'))
  db.prepare('INSERT INTO kv VALUES (?,?)').run(KV.sessions.world('recovery-master'), JSON.stringify('a'.repeat(64))); db.close()
  await expect(createCheckpoint(f)).rejects.toThrow('Session execution world')
  expect(await readdir(f.outputDir)).toEqual([])
})

it('imports checkpoint Sessions into a fresh backend only with a matching staged coordinator and retains its hold', async () => {
  const f = await fixture(), result = await createCheckpoint(f), target = await backend(join(f.directory, 'fresh-backend'))
  await expect(importCheckpointSessions(result.path, f.keyFile, f.stateDir, target)).rejects.toThrow('matching staged coordinator')
  expect(await target.list()).toEqual([])
  const destination = join(f.directory, 'staged'); await stageCheckpoint(result.path, f.keyFile, destination)
  await importCheckpointSessions(result.path, f.keyFile, destination, target)
  await importCheckpointSessions(result.path, f.keyFile, destination, target)
  const restored = await target.open(SessionId('recovery-master'), 'read')
  expect((await restored.read()).events).toEqual([event(0, 'private archive evidence')]); await restored.close()
  const store = new Store(join(destination, 'orchestrator.sqlite'))
  expect(store.get(KV.recovery.hold)).toMatchObject({ checkpoint: result.manifest.id, state: 'staged' }); store.close()
  const other = await createCheckpoint(f)
  await expect(importCheckpointSessions(other.path, f.keyFile, destination, target)).rejects.toThrow('matching staged coordinator')
})

it('captures original remote receipts and revocation without treating an unresolved command as completed', async () => {
  const f = await fixture(), h = await remoteFixture(cleanup), directory = join(f.directory, 'dedicated-world')
  const world = new WorldJournal(directory, error => { throw error })
  cleanup.push(async () => world.close())
  world.bind(h.endpoint.journal.id, h.enrolled.grant)
  const binding = worldBinding(h.endpoint.journal.id, h.enrolled.grant)
  const authority = { world: binding, grantId: h.enrolled.grant.id, epoch: h.enrolled.grant.epoch }
  const request = world.effects.prepare(h.spawn('printf checkpoint-evidence'), authority)
  const job = await h.client.call<{ id: string }>(request), settled = await h.settled(job.id)
  world.effects.observed(request, settled)
  const pending = world.effects.run({ kind: 'assignment', ticketId: 'checkpoint-task', assignmentId: 'checkpoint-assignment', sessionId: 'receipt-child', callId: 'checkpoint-call', tool: 'bash' },
    () => {}, () => world.effects.prepare(h.spawn('printf do-not-replay'), authority))
  world.revoke('checkpoint-revoke', 'Retain revoked authority in backup')
  world.acknowledge(await h.client.call<RevocationReceipt>({ op: 'grant.revoke', requestId: 'checkpoint-revoke', reason: 'Retain revoked authority in backup' }))
  const record = world.read(), saved = world.effects.list().items
  const store = new Store(join(f.stateDir, 'orchestrator.sqlite')); store.set(KV.sessions.world('recovery-master'), binding); store.close()
  await expect(createCheckpoint({ ...f, worldDirectories: [directory] })).rejects.toThrow('already being held')
  world.close()
  await expect(createCheckpoint({ ...f, worldDirectories: [directory] })).rejects.toThrow('receipt references missing Session')
  const child = await f.persistence.create(header('receipt-child')); await child.append([event(0)]); await child.close()
  const result = await createCheckpoint({ ...f, worldDirectories: [directory, directory] })
  expect(result.manifest.sessions.some(session => session.id === 'receipt-child')).toBe(true)
  expect(result.manifest.files.filter(file => file.kind === 'world')).toHaveLength(1)
  const destination = join(f.directory, 'restore'); await stageCheckpoint(result.path, f.keyFile, destination)
  const member = result.manifest.files.find(file => file.kind === 'world')!
  const db = new DatabaseSync(join(destination, member.member), { readOnly: true })
  try {
    expect(JSON.parse(String(db.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value))).toEqual(record)
    const receipts = db.prepare('SELECT value FROM execution_effect').all().map(row => JSON.parse(String(row.value)))
    expect(receipts).toHaveLength(saved.length)
    for (const receipt of saved) expect(receipts).toContainEqual(receipt)
    expect(receipts.find(receipt => receipt.id === pending.requestId)).toMatchObject({ phase: 'pending', quiescent: null })
    expect(receipts.find(receipt => receipt.id === request.requestId)).toMatchObject({ phase: 'settled', quiescent: true })
  } finally { db.close() }
  expect(h.endpoint.journal.jobs().map(job => job.id)).not.toContain(pending.requestId)
})
