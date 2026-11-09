import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { Runtime } from '../src/app/runtime.ts'
import { testMachine } from './fixtures/deployment.ts'
import { prepareCheckpointReceipts } from '../src/recovery/prepare.ts'
import { verifyReceiptImage } from '../src/recovery/image.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { createRecoveryKey } from '../src/recovery/crypto.ts'
import { createCheckpoint, stageCheckpoint } from '../src/recovery/checkpoint.ts'
import { reserveCheckpointOwnership } from '../src/recovery/ownership.ts'
import { auditCheckpointReceipts } from '../src/recovery/audit.ts'
import { InventoryPage, InventoryReceipt } from '../src/ownership/inventory.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { WorldJournal, worldBinding } from '../src/remote/world-journal.ts'
import { RemoteClient } from '../src/remote/client.ts'
import type { RemoteJob, RemoteOperation, RevocationReceipt, RpcInput } from '../src/remote/protocol.ts'
import { PublicationClient } from '../src/publication/client.ts'
import { contentHash } from '../src/publication/github.ts'
import type { DestinationView, Publication, PublicationReceipt, PublicationRpc } from '../src/publication/protocol.ts'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { remoteFixture } from './fixtures/remote.ts'
import { publicationFixture } from './fixtures/publication.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(options: { pending?: boolean; channel?: boolean; extra?: boolean; revoked?: boolean; kind?: DestinationView['kind'] } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-receipt-audit-')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const authority = await ownershipAuthority(cleanup, ['endpoint', 'publication']), owner = new CoordinatorOwnership(authority.config)
  cleanup.push(() => owner.close())
  const publisher = await publicationFixture(cleanup, authority.resourceFor('publication'), owner, options.kind)
  const remote = await remoteFixture(cleanup, { native: process.env.DSH_REMOTE_ISOLATION === '1', ownership: authority.resource,
    access: owner, beforeEnroll: async () => { await owner.start() } })
  const stateDir = join(directory, 'state'), worldDir = join(directory, 'world'), keyFile = join(directory, 'key')
  await mkdir(stateDir, { mode: 0o700 }); createRecoveryKey(keyFile)
  const context = new Context(); cleanup.push(() => context.fiber.dispose())
  await context.plugin(Jsonl, { root: join(directory, 'sessions'), compression: 'none' })
  const writer = await context.sessionPersistence.create(Session.create(SessionId('audit-master')).header)
  await writer.append([{ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: { role: 'user', id: MessageId('audit-start'),
    source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Audit qualification' }] } }]); await writer.close()
  const store = new Store(join(stateDir, 'orchestrator.sqlite')), world = new WorldJournal(worldDir, error => { throw error })
  world.bind(remote.endpoint.journal.id, remote.enrolled.grant)
  store.set(KV.runtime.masterId, 'audit-master')
  store.set(KV.runtime.ownership, { authorityId: authority.config.authorityId, coordinatorId: authority.config.coordinatorId })
  store.set(KV.runtime.publication, { serviceId: publisher.connection.serviceId })
  const scope = { world: worldBinding(remote.endpoint.journal.id, remote.enrolled.grant), grantId: remote.enrolled.grant.id,
    epoch: remote.enrolled.grant.epoch, ownershipCoordinatorId: 'coordinator' }
  const command = world.effects.prepare(remote.spawn('printf private-command-payload > artifact'), scope)
  const job = await remote.client.call<RemoteJob>(command); const settled = await remote.settled(job.id)
  if (!options.pending) world.effects.observed({ op: 'job.get', id: job.id }, settled)
  const mutation = world.effects.prepare({ op: 'fs.write' as const, requestId: randomUUID(), path: 'second', content: 'private-file-payload', expected: { kind: 'createIfAbsent' as const } }, scope)
  const written = await remote.client.call<RemoteOperation>(mutation); if (!options.pending) world.effects.observed(mutation, written)
  const destination = (await publisher.client.call<DestinationView[]>({ op: 'destinations' }))[0]!, text = 'private-publication-payload'
  const publication: Publication = { id: randomUUID(), destination: destination.id, destinationHash: destination.hash, text, hash: contentHash(text),
    artifact: { id: randomUUID(), revision: 1, hash: contentHash(text) } }
  const receipt = await publisher.client.call<PublicationReceipt>({ op: 'publish', publication })
  store.db.exec('CREATE TABLE IF NOT EXISTS workspace_publication (id TEXT PRIMARY KEY,value TEXT NOT NULL)')
  store.db.prepare('INSERT INTO workspace_publication VALUES (?,?)').run(publication.id, JSON.stringify({ id: publication.id, intent: Object.fromEntries(Object.entries(publication).reverse()),
    attempts: [owner.status().owner], ...options.pending ? {} : { receipt } }))
  let channel: Publication | undefined
  if (options.channel) {
    const { artifact: _, ...base } = publication
    const message = { id: 'channel-message', channel: { source: 'publication', thread: 'test', address: {} }, text, kind: 'reply' as const, ticketId: 'ticket' }
    channel = { ...base, id: randomUUID(), message: { id: message.id, ticketId: message.ticketId, missionId: randomUUID(), grantId: randomUUID(), planVersion: 1 } }
    await publisher.client.call({ op: 'publish', publication: channel })
    store.receipts.add(message)
    store.db.exec('CREATE TABLE channel_publication (id TEXT PRIMARY KEY,message TEXT UNIQUE,mission TEXT,value TEXT NOT NULL)')
    store.db.prepare('INSERT INTO channel_publication VALUES (?,?,?,?)').run(channel.id, message.id, channel.message!.missionId,
      JSON.stringify({ id: channel.id, messageId: message.id, publication: channel, original: message, attempts: [owner.status().owner], phase: 'unknown', withdrawn: true }))
  }
  if (options.revoked) {
    world.revoke('revoke-world', 'Qualification revocation')
    world.acknowledge(await remote.client.call<RevocationReceipt>({ op: 'grant.revoke', requestId: 'revoke-world', reason: 'Qualification revocation' }))
  }
  world.close(); store.close()
  const checkpoint = await createCheckpoint({ stateDir, keyFile, outputDir: join(directory, 'backups'), worldDirectories: [worldDir], persistence: context.sessionPersistence })
  if (options.extra) {
    const extra = await remote.client.call<RemoteJob>(remote.spawn('printf later > later-artifact')); await remote.settled(extra.id)
    await publisher.client.call({ op: 'publish', publication: { ...publication, id: randomUUID() } })
  }
  await owner.close()
  const held = join(directory, 'held'); await stageCheckpoint(checkpoint.path, keyFile, held)
  const connection = { ...authority.admin.connection, coordinatorId: 'coordinator' }
  const reserved = await reserveCheckpointOwnership({ checkpoint: checkpoint.path, keyFile, destination: held, authority: connection,
    requestId: randomUUID(), epoch: 1, generation: 0 })
  const audit = { checkpoint: checkpoint.path, keyFile, destination: held, authority: connection,
    endpoints: [{ ...remote.connection, ownership: undefined, credentialFile: await realpath(remote.connection.credentialFile) }], publication: publisher.admin.config }
  const read = () => { const store = new Store(join(held, 'orchestrator.sqlite')); try { return { report: store.get(KV.recovery.audit), hold: store.get(KV.recovery.hold) } } finally { store.close() } }
  return { directory, checkpoint, reserved, audit, authority, remote, publisher, publication, job: settled, written, channel, read }
}

it.each(['github-comment', 'github-review', 'feishu-reply'] as const)('matches authentic execution and %s receipts without payloads, replay or removing the hold', async kind => {
  const f = await fixture({ kind }), before = f.publisher.posts, report = await auditCheckpointReceipts(f.audit)
  expect(report).toMatchObject({ phase: 'complete', status: 'matched', complete: true, issueCount: 0, matched: 5, observed: 0, executionOwnership: false })
  expect(report.resources).toHaveLength(2); expect(f.read().report).toEqual(report); expect(f.read().hold?.state).toBe('staged')
  const repeated = await auditCheckpointReceipts(f.audit); expect(repeated.status).toBe('matched'); expect(repeated.id).not.toBe(report.id)
  const page = InventoryPage.parse(await f.remote.admin.call({ op: 'recovery.inventory', offset: 0 }))
  expect(JSON.stringify(page)).not.toMatch(/private-command-payload|private-file-payload|argv|content/)
  expect(JSON.stringify(await f.publisher.admin.call({ op: 'recovery.inventory', offset: 0 }))).not.toContain('private-publication-payload')
  await expect(f.remote.client.call({ op: 'recovery.inventory', offset: 0 })).rejects.toThrow('administration')
  await expect(f.publisher.client.call({ op: 'recovery.inventory', offset: 0 })).rejects.toThrow('administrator')
  expect(f.publisher.posts).toBe(before)
})

it('records settled original effects whose acknowledgements were absent from the checkpoint', async () => {
  const f = await fixture({ pending: true }), report = await auditCheckpointReceipts(f.audit)
  expect(report).toMatchObject({ status: 'matched', observed: 3, matched: 5 })
  expect(f.read().hold?.state).toBe('staged'); expect(f.publisher.posts).toBe(1)
})

it('recognizes an exactly acknowledged world revocation without granting replacement authority', async () => {
  const f = await fixture({ revoked: true })
  expect((await auditCheckpointReceipts(f.audit)).status).toBe('matched')
  expect(f.remote.endpoint.journal.grant(f.remote.enrolled.grant.id)).toMatchObject({ enabled: false, epoch: 2 })
  expect(f.read().hold?.state).toBe('staged')
})

it('blocks effects created after capture and reports both independent resource identities', async () => {
  const f = await fixture({ extra: true }), report = await auditCheckpointReceipts(f.audit)
  expect(report).toMatchObject({ phase: 'complete', status: 'blocked', complete: true })
  expect(report.issues.filter(item => item.code === 'unrecorded_effect').map(item => item.kind).sort()).toEqual(['command', 'publication'])
  expect(f.publisher.posts).toBe(2); expect(f.read().hold?.state).toBe('staged')
})

it('refuses to call incomplete resource coverage matched and detects missing or changed original receipts', async () => {
  const f = await fixture(), partial = await auditCheckpointReceipts({ ...f.audit, endpoints: [] })
  expect(partial).toMatchObject({ status: 'blocked', complete: false }); expect(partial.issues.map(item => item.code)).toContain('resource_missing')
  f.remote.endpoint.journal.db.prepare('DELETE FROM remote_operation WHERE id=?').run(f.written.id)
  f.remote.endpoint.journal.saveJob({ ...f.job, fingerprint: 'a'.repeat(64) })
  const changed = await auditCheckpointReceipts(f.audit)
  expect(changed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'receipt_missing', id: f.written.id }),
    expect.objectContaining({ code: 'receipt_mismatch', id: f.job.id })]))
})

it('blocks uncertain effects and independently observes their later reconciliation without sending again', async () => {
  const f = await fixture(), item = f.publisher.service.journal.get(f.publication.id)!
  item.receipt.phase = 'unknown'; delete item.receipt.external; f.publisher.service.journal.save(item)
  const report = await auditCheckpointReceipts(f.audit)
  expect(report.status).toBe('blocked'); expect(report.issues.some(item => item.code === 'resource_not_quiescent')).toBe(true)
  const reads = f.publisher.reads; expect(f.publisher.posts).toBe(1)
  await f.publisher.admin.call({ op: 'receipt.observe', id: f.publication.id })
  expect(f.publisher.reads).toBeGreaterThan(reads)
  expect((await auditCheckpointReceipts(f.audit)).status).toBe('matched'); expect(f.publisher.posts).toBe(1)
})

it('invalidates all pages on receipt updates, including changes after the first page was returned', async () => {
  const f = await fixture()
  for (let i = 0; i < 55; i++) f.remote.endpoint.journal.saveJob({ ...f.job, id: 'paged-' + String(i).padStart(3, '0') })
  const first = InventoryPage.parse(await f.remote.admin.call({ op: 'recovery.inventory', offset: 0 }))
  expect(first.nextOffset).toBe(50)
  await expect(f.remote.admin.call({ op: 'recovery.inventory', offset: 50 })).rejects.toThrow('restart the recovery audit')
  f.remote.endpoint.journal.saveJob({ ...f.job, id: 'paged-000', outcome: { exitCode: 9, signal: null } })
  await expect(f.remote.admin.call({ op: 'recovery.inventory', offset: 50, revision: first.revision })).rejects.toThrow('changed')
  const call = RemoteClient.prototype.call; let changed = false
  vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(async function<T>(this: RemoteClient, request: RpcInput, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.inventory' && !changed) { changed = true; f.remote.endpoint.journal.saveJob({ ...f.job, id: 'paged-new' }) }
    return result as T
  })
  await expect(auditCheckpointReceipts(f.audit)).rejects.toThrow('changed')
  expect(f.read().report).toMatchObject({ phase: 'failed', complete: false, status: 'blocked' })
})

it('invalidates an old inventory revision on resource restart even when effect content is unchanged', async () => {
  const f = await fixture(), page = InventoryPage.parse(await f.publisher.admin.call({ op: 'recovery.inventory', offset: 0 }))
  await f.publisher.restart()
  await expect(f.publisher.admin.call({ op: 'recovery.inventory', offset: page.total, revision: page.revision })).rejects.toThrow('changed')
  expect((await auditCheckpointReceipts(f.audit)).status).toBe('matched')
})

it('refuses a changed ownership selection at the final cut and preserves failed audit evidence', async () => {
  const f = await fixture(), call = PublicationClient.prototype.call; let replace = true
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.inventory' && replace) {
      replace = false
      await f.authority.admin.call({ ...f.reserved.request, requestId: randomUUID(), generation: 1 })
    }
    return result as T
  })
  await expect(auditCheckpointReceipts(f.audit)).rejects.toThrow('Ownership changed')
  expect(f.read().report).toMatchObject({ phase: 'failed', status: 'blocked', complete: false }); expect(f.read().hold?.state).toBe('staged')
})

it('keeps a failed or cancelled re-audit from presenting an older matched report as current', async () => {
  const f = await fixture(); await auditCheckpointReceipts(f.audit)
  f.remote.offline(true)
  await expect(auditCheckpointReceipts(f.audit)).rejects.toThrow()
  expect(f.read().report).toMatchObject({ phase: 'failed', status: 'blocked', complete: false })
  f.remote.offline(false)
  expect((await auditCheckpointReceipts(f.audit)).status).toBe('matched')
  const abort = new AbortController(), call = RemoteClient.prototype.call
  vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(async function<T>(this: RemoteClient, request: RpcInput, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.inventory') abort.abort(new Error('Audit cancelled'))
    return result as T
  })
  await expect(auditCheckpointReceipts({ ...f.audit, signal: abort.signal })).rejects.toThrow()
  expect(f.read().report).toMatchObject({ phase: 'failed', status: 'blocked', complete: false })
})

it('refuses resource identity substitution and omission of a persisted publication binding', async () => {
  const f = await fixture()
  await expect(auditCheckpointReceipts({ ...f.audit, publication: undefined })).rejects.toThrow('original publication service')
  const call = RemoteClient.prototype.call
  vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(async function<T>(this: RemoteClient, request: RpcInput, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.inventory') { const page = InventoryPage.parse(result); return { ...page, identity: { ...page.identity, resourceId: 'substituted' } } as T }
    return result as T
  })
  await expect(auditCheckpointReceipts(f.audit)).rejects.toThrow('inventory identity')
  expect(f.read().report).toMatchObject({ phase: 'failed', status: 'blocked', complete: false })
})

it('checks staged world and Session bytes before inspecting independent receipts', async () => {
  const f = await fixture(), member = f.checkpoint.manifest.files.find(item => item.kind === 'world')!
  await appendFile(join(f.audit.destination, member.member), 'altered')
  await expect(auditCheckpointReceipts(f.audit)).rejects.toThrow('authenticated size')
  expect(f.read().hold?.state).toBe('staged')
})

it.each(['github-comment', 'github-review', 'feishu-reply'] as const)('prepares missing execution and %s acknowledgements in an authenticated held image', async kind => {
  const f = await fixture({ kind, pending: true, channel: true }), audit = await auditCheckpointReceipts(f.audit)
  const source = new DatabaseSync(join(f.audit.destination, 'orchestrator.sqlite'), { readOnly: true })
  const before = recoveryStateDigest(source); source.close()
  const options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }, prepared = await prepareCheckpointReceipts(options)
  expect(prepared.manifest.applied).toEqual({ commands: 1, mutations: 1, publications: 2 })
  expect(await verifyReceiptImage(prepared.path, f.audit.keyFile)).toEqual(prepared.manifest)
  expect(await prepareCheckpointReceipts(options)).toEqual(prepared)
  const db = new DatabaseSync(join(prepared.path, 'orchestrator.sqlite'), { readOnly: true })
  try {
    expect(JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.hold)!.value))).toMatchObject({ state: 'prepared', requestId: options.requestId })
    for (const table of ['workspace_publication', 'channel_publication']) {
      const value = JSON.parse(String(db.prepare(`SELECT value FROM ${table}`).get()!.value))
      expect(value).toMatchObject({ phase: 'observed', receipt: { phase: 'sent' } })
      if (table === 'channel_publication') expect(value.withdrawn).toBe(true)
    }
    expect(JSON.parse(String(db.prepare('SELECT value FROM outbox').get()!.value)).status).toBe('sent')
  } finally { db.close() }
  const file = prepared.manifest.files.find(file => file.kind === 'world')!, world = new DatabaseSync(join(prepared.path, file.member), { readOnly: true })
  try { for (const row of world.prepare('SELECT value FROM execution_effect').all()) expect(JSON.parse(String(row.value))).toMatchObject({ phase: 'settled', quiescent: true, recovered: true }) }
  finally { world.close() }
  const original = new Store(join(f.audit.destination, 'orchestrator.sqlite'))
  try { expect(recoveryStateDigest(original.db)).toBe(before); expect(original.replyStatus('channel-message')).toBe('pending') } finally { original.close() }
  expect(f.read().hold?.state).toBe('staged'); expect(f.publisher.posts).toBe(2)
  const context = new Context(); cleanup.push(() => context.fiber.dispose())
  expect(() => new Runtime(context, testMachine({ stateDir: prepared.path }), () => {})).toThrow('staged checkpoint restore')
  expect(await verifyReceiptImage(prepared.path, f.audit.keyFile)).toEqual(prepared.manifest)
})

it('exposes only safe revision-bound recovery observations to independent administrators', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit)
  for (const [kind, id] of [['command', f.job.id], ['mutation', f.written.id]] as const) {
    const revision = audit.resources.find(resource => resource.identity.kind === 'endpoint')!.revision
    const request = { op: 'recovery.receipt' as const, kind, id, revision }, result = InventoryReceipt.parse(await f.remote.admin.call(request))
    expect(result.item).toMatchObject({ kind, id, settled: true })
    expect(JSON.stringify(result)).not.toMatch(/private-command-payload|private-file-payload|argv|content|"request"/)
    await expect(f.remote.client.call(request)).rejects.toThrow('administration')
  }
  const revision = audit.resources.find(resource => resource.identity.kind === 'publication')!.revision
  const request = { op: 'recovery.receipt' as const, kind: 'publication' as const, id: f.publication.id, revision }
  expect(JSON.stringify(await f.publisher.admin.call(request))).not.toContain('private-publication-payload')
  await expect(f.publisher.client.call(request)).rejects.toThrow('administrator')
  await f.publisher.restart()
  await expect(f.publisher.admin.call(request)).rejects.toThrow('changed')
})

it('refuses blocked or unselected audits before creating a preparation intent', async () => {
  const f = await fixture({ extra: true }), audit = await auditCheckpointReceipts(f.audit)
  for (const auditId of [audit.id, randomUUID()]) await expect(prepareCheckpointReceipts({ ...f.audit, auditId, requestId: randomUUID() })).rejects.toThrow('complete matched audit')
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
  const store = new Store(join(f.audit.destination, 'orchestrator.sqlite'))
  try { expect(store.get(KV.recovery.preparation)).toBeUndefined() } finally { store.close() }
})

it('keeps the originally selected audit and request after an offline failure and an interrupted target reservation', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit), options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }
  f.remote.offline(true); await expect(prepareCheckpointReceipts(options)).rejects.toThrow(); f.remote.offline(false)
  await mkdir(join(f.audit.destination, 'prepared-' + options.requestId), { mode: 0o700 })
  const later = await auditCheckpointReceipts(f.audit)
  await expect(prepareCheckpointReceipts({ ...options, auditId: later.id })).rejects.toThrow('request differs')
  await expect(prepareCheckpointReceipts({ ...options, requestId: randomUUID() })).rejects.toThrow('request differs')
  const prepared = await prepareCheckpointReceipts(options)
  expect(prepared.manifest.auditId).toBe(audit.id)
  // Simulate successful directory publication followed by a lost acknowledgement to the source Store.
  const store = new Store(join(f.audit.destination, 'orchestrator.sqlite'))
  try { const intent = store.get(KV.recovery.preparation)!; intent.phase = 'requested'; delete intent.image; store.set(KV.recovery.preparation, intent) } finally { store.close() }
  f.remote.offline(true)
  expect(await prepareCheckpointReceipts(options)).toEqual(prepared)
  expect(f.read().hold?.state).toBe('staged')
})

it('refuses a resource revision that changed after audit without adopting a newer cut', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit), options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }
  f.remote.endpoint.journal.saveJob(f.job)
  await expect(prepareCheckpointReceipts(options)).rejects.toThrow('changed')
  const later = await auditCheckpointReceipts(f.audit)
  await expect(prepareCheckpointReceipts({ ...options, auditId: later.id })).rejects.toThrow('request differs')
  expect((await readdir(f.audit.destination)).some(name => name.startsWith('prepared-'))).toBe(false)
})

it('rechecks every resource after receipt collection and removes an unpublished image on revision change', async () => {
  const f = await fixture({ pending: true }), audit = await auditCheckpointReceipts(f.audit), call = PublicationClient.prototype.call
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.receipt') f.publisher.service.journal.save(f.publisher.service.journal.get(f.publication.id)!)
    return result as T
  })
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('changed')
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
  expect(f.read().hold?.state).toBe('staged'); expect(f.publisher.posts).toBe(1)
})

it('refuses an observation with changed attribution despite a matching inventory item', async () => {
  const f = await fixture({ pending: true }), audit = await auditCheckpointReceipts(f.audit), call = RemoteClient.prototype.call
  vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(async function<T>(this: RemoteClient, request: RpcInput, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op !== 'recovery.receipt') return result as T
    const value = InventoryReceipt.parse(result)
    return { ...value, observation: { ...value.observation as object, owner: { kind: 'host', purpose: 'different' } } } as T
  })
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('original effect')
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
})

it('cancels preparation before publishing and retains the original intent for retry', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit), call = PublicationClient.prototype.call, abort = new AbortController()
  const spy = vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal); if (request.op === 'recovery.receipt') abort.abort(new Error('Preparation cancelled')); return result as T
  })
  const options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }
  await expect(prepareCheckpointReceipts({ ...options, signal: abort.signal })).rejects.toThrow()
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
  spy.mockRestore(); expect((await prepareCheckpointReceipts(options)).manifest.auditId).toBe(audit.id)
})

it.each(['manifest', 'member', 'extra'] as const)('refuses a tampered prepared %s on verification and original-ID retry', async kind => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit), options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }
  const prepared = await prepareCheckpointReceipts(options)
  if (kind === 'manifest') {
    const path = join(prepared.path, 'prepared.json'), value = JSON.parse(await readFile(path, 'utf8'))
    value.manifest.applied.commands++; await writeFile(path, JSON.stringify(value))
  } else if (kind === 'member') await appendFile(join(prepared.path, 'orchestrator.sqlite'), 'tampered')
  else await writeFile(join(prepared.path, 'unlisted'), 'unlisted', { mode: 0o600 })
  await expect(verifyReceiptImage(prepared.path, f.audit.keyFile)).rejects.toThrow()
  await expect(prepareCheckpointReceipts(options)).rejects.toThrow()
  expect(f.read().hold?.state).toBe('staged')
})
