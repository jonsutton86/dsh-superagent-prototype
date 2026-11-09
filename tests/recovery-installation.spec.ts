import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { recoveryAuditFixture } from './fixtures/recovery-audit.ts'
import { testMachine } from './fixtures/deployment.ts'
import { auditCheckpointReceipts } from '../src/recovery/audit.ts'
import { prepareCheckpointReceipts } from '../src/recovery/prepare.ts'
import { installCheckpoint, readInstallation, installationProfile } from '../src/recovery/installation.ts'
import { prepareRuntimeActivation, consumeRuntimeBootstrap } from '../src/recovery/activation.ts'
import { privateCredential } from '../src/environments/endpoint-files.ts'
import { KV } from '../src/kv.ts'
import { Runtime } from '../src/app/runtime.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { createCheckpoint, stageCheckpoint } from '../src/recovery/checkpoint.ts'
import { reserveCheckpointOwnership } from '../src/recovery/ownership.ts'
import type { OwnershipView } from '../src/ownership/protocol.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await recoveryAuditFixture(cleanup, { managed: true })
  const audit = await auditCheckpointReceipts(f.audit), preparation = await prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })
  const request = { ...f.audit, requestId: randomUUID(), preparationId: preparation.manifest.requestId, target: join(f.directory, 'installed') }
  const installation = await installCheckpoint(request), profile = installationProfile(installation, f.audit.keyFile)
  const machine = { ...testMachine({ stateDir: installation.stateDir }), ...profile }
  f.context.provide('sessionProjections', f.inference.host.projections)
  f.context.provide('agentDefaultModel', { currentSelection: f.inference.host.currentSelection })
  const activate = () => prepareRuntimeActivation(f.context, machine, new AbortController().signal)
  const read = () => {
    const db = new DatabaseSync(join(installation.stateDir, 'orchestrator.sqlite'), { readOnly: true })
    try { return Object.fromEntries(db.prepare('SELECT key,value FROM kv').all().map(row => [String(row.key), JSON.parse(String(row.value))])) } finally { db.close() }
  }
  return { ...f, request, installation, profile, machine, activate, readInstalled: read }
}

it('installs separate private state, retains the hold and exposes no credential contents in its manifest', async () => {
  const f = await fixture()
  expect(f.readInstalled()[KV.recovery.hold]).toMatchObject({ state: 'prepared' })
  expect(f.readInstalled()[KV.recovery.activation]).toBeUndefined()
  const manifest = await readFile(join(f.installation.root, 'installation.json'), 'utf8')
  for (const item of f.installation.credentials) expect(manifest).not.toContain(privateCredential(item.file))
  expect(f.installation.worlds[0]!.config.stateDir).not.toBe(f.worldDir)
  expect(await installCheckpoint(f.request)).toEqual(f.installation)
  await expect(installCheckpoint({ ...f.request, requestId: randomUUID() })).rejects.toThrow('different request')
  expect(() => new Runtime(f.context, f.machine, () => {})).toThrow('verified Runtime handoff')
})

it('acquires fenced ownership before atomically releasing the hold and transfers a single-use exclusive lock', async () => {
  const f = await fixture(), handoff = await f.activate()
  cleanup.push(async () => { await handoff.ownership.close(); handoff.release() })
  expect(handoff.ownership.status().phase).toBe('active')
  expect(f.readInstalled()[KV.recovery.hold]).toBeUndefined()
  expect(f.readInstalled()[KV.recovery.activation]).toBeTypeOf('string')
  expect(() => lockSync(f.installation.stateDir)).toThrow()
  expect(consumeRuntimeBootstrap(handoff, f.machine)).toBe(handoff)
  expect(() => consumeRuntimeBootstrap(handoff, f.machine)).toThrow('original verified')
  expect(f.read().hold?.state).toBe('staged')
  await handoff.ownership.close(); handoff.release()
  expect(() => new Runtime(f.context, { ...f.machine, restore: undefined }, () => {})).toThrow('authenticated Runtime configuration')
})

it('permits continued Session history only after activation and checks the original prefix again on restart', async () => {
  const f = await fixture(), original = await f.activate()
  await original.ownership.close(); original.release()
  const writer = await f.context.sessionPersistence.open(SessionId('audit-master'), 'write')
  await writer.append([{ type: 'user/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append', data: { role: 'user', id: MessageId('continued'),
    source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Continue after recovery' }] } }]); await writer.close()
  const restarted = await f.activate()
  cleanup.push(async () => { await restarted.ownership.close(); restarted.release() })
  expect(restarted.ownership.instanceId).not.toBe(original.ownership.instanceId)
  expect(restarted.ownership.status().phase).toBe('active')
})

it.each(['store', 'world', 'manifest', 'configuration', 'credential', 'session'] as const)('refuses changed %s before removing the hold or acquiring ownership', async kind => {
  const f = await fixture()
  if (kind === 'store' || kind === 'world') {
    const file = kind === 'store' ? join(f.installation.stateDir, 'orchestrator.sqlite') : join(f.installation.worlds[0]!.config.stateDir, 'world.sqlite')
    const db = new DatabaseSync(file); try { db.exec('CREATE TABLE substituted (value TEXT)') } finally { db.close() }
  } else if (kind === 'manifest') {
    const file = join(f.installation.root, 'installation.json'), content = JSON.parse(await readFile(file, 'utf8'))
    content.value.masterId = 'substitution'; await writeFile(file, JSON.stringify(content), { mode: 0o600 })
  } else if (kind === 'configuration') f.machine.ownership = { ...f.machine.ownership, coordinatorId: 'substitution' }
  else if (kind === 'credential') await writeFile(f.installation.ownership.credentialFile, 'x'.repeat(64), { mode: 0o600 })
  else {
    const writer = await f.context.sessionPersistence.open(SessionId('audit-master'), 'write')
    await writer.append([{ type: 'user/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append', data: { role: 'user', id: MessageId('unrelated'),
      source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Unreconciled continuation' }] } }]); await writer.close()
  }
  await expect(f.activate()).rejects.toThrow()
  expect(f.readInstalled()[KV.recovery.hold]).toMatchObject({ state: 'prepared' })
  expect(f.readInstalled()[KV.recovery.activation]).toBeUndefined()
  const view = await f.authority.admin.call<{ phase: string }>({ op: 'coordinator.inspect', id: f.authority.config.coordinatorId })
  expect(view.phase).toBe('vacant')
})

it('authenticates installed paths on original-request retries', async () => {
  const f = await fixture()
  await writeFile(join(f.installation.root, 'installation.json'), '{}', { mode: 0o600 })
  await expect(readInstallation(f.installation.root, f.audit.keyFile, new AbortController().signal)).rejects.toThrow()
  await expect(installCheckpoint(f.request)).rejects.toThrow()
})

it('keeps the hold after an interrupted acquisition and safely retries after the vacant authority epoch advances', async () => {
  const f = await fixture(), original = CoordinatorOwnership.prototype.start
  const interrupted = vi.spyOn(CoordinatorOwnership.prototype, 'start').mockImplementationOnce(async function (this: CoordinatorOwnership) {
    await original.call(this); throw new Error('Qualification interrupted ownership handoff')
  })
  await expect(f.activate()).rejects.toThrow('interrupted ownership')
  interrupted.mockRestore()
  expect(f.readInstalled()[KV.recovery.hold]).toMatchObject({ state: 'prepared' })
  const restored = await f.activate()
  cleanup.push(async () => { await restored.ownership.close(); restored.release() })
  expect(restored.ownership.status().phase).toBe('active')
})

it('starts using installed private files after the old coordinator state and world directory are unavailable', async () => {
  const f = await fixture()
  await rename(f.stateDir, f.stateDir + '-offline'); await rename(f.worldDir, f.worldDir + '-offline')
  const restored = await f.activate()
  cleanup.push(async () => { await restored.ownership.close(); restored.release() })
  expect(restored.bindings.world(f.installation.worlds[0]!.binding, {} as never)).toEqual(f.installation.worlds[0]!.config)
  expect(restored.ownership.status().phase).toBe('active')
})

it('captures relocated journals and supports a second complete checkpoint, reservation, installation and activation', async () => {
  const f = await fixture(), first = await f.activate()
  await first.ownership.close(); first.release()
  await rename(f.worldDir, f.worldDir + '-offline')
  const checkpoint = await createCheckpoint({ stateDir: f.installation.stateDir, outputDir: join(f.directory, 'second-backup'), keyFile: f.audit.keyFile, persistence: f.context.sessionPersistence })
  expect(checkpoint.manifest.files.find(file => file.kind === 'world')!.source).toBe(f.installation.worlds[0]!.config.stateDir)
  const destination = join(f.directory, 'second-held'); await stageCheckpoint(checkpoint.path, f.audit.keyFile, destination)
  const before = await f.authority.admin.call<OwnershipView>({ op: 'coordinator.inspect', id: f.authority.config.coordinatorId })
  const auditOptions = { ...f.audit, checkpoint: checkpoint.path, destination, worlds: undefined }
  await reserveCheckpointOwnership({ ...auditOptions, requestId: randomUUID(), epoch: before.epoch, generation: before.recovery!.generation })
  const audit = await auditCheckpointReceipts(auditOptions)
  expect(audit.status).toBe('matched')
  const preparation = await prepareCheckpointReceipts({ ...auditOptions, requestId: randomUUID(), auditId: audit.id })
  const second = await installCheckpoint({ ...auditOptions, requestId: randomUUID(), preparationId: preparation.manifest.requestId, target: join(f.directory, 'second-installation') })
  const handoff = await prepareRuntimeActivation(f.context, { ...testMachine(), ...installationProfile(second, f.audit.keyFile) }, new AbortController().signal)
  cleanup.push(async () => { await handoff.ownership.close(); handoff.release() })
  expect(handoff.ownership.status().phase).toBe('active')
  expect(handoff.installation.image.recovery.generation).toBe(2)
})
