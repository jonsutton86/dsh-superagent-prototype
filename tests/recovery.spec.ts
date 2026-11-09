import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionHeader, type SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lockSync } from 'proper-lockfile'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { Runtime } from '../src/app/runtime.ts'
import { testMachine } from './fixtures/deployment.ts'
import { createRecoveryKey } from '../src/recovery/crypto.ts'
import { createCheckpoint, importCheckpointSessions, stageCheckpoint, verifyCheckpoint } from '../src/recovery/checkpoint.ts'
import { exportSession, importSession, inspectSession, ownSessions } from '../src/recovery/sessions.ts'
import { WorldJournal, worldBinding } from '../src/remote/world-journal.ts'
import type { RevocationReceipt } from '../src/remote/protocol.ts'
import { remoteFixture } from './fixtures/remote.ts'
import * as Recovery from '../src/recovery/index.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
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
