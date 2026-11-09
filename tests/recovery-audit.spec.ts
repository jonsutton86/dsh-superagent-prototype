import { Context } from '@deepseek-ai/cordis'
import { inferenceFixture } from './fixtures/inference.ts'
import { SourceCatalog } from '../src/sources/catalog.ts'
import { recoverySourceHost } from '../src/recovery/sources.ts'
import { inputMessage, inputTicket, inputTime } from './fixtures/recovery-inputs.ts'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { createHmac, randomUUID } from 'node:crypto'
import { appendFile, chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { Runtime } from '../src/app/runtime.ts'
import { testMachine } from './fixtures/deployment.ts'
import { prepareCheckpointReceipts } from '../src/recovery/prepare.ts'
import { verifyReceiptImage } from '../src/recovery/image.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Endpoints } from '../src/environments/endpoints.ts'
import { credentialDigest } from '../src/environments/endpoint-files.ts'
import { administrationRequest } from '../src/recovery/administration.ts'
import { revocationRequest } from '../src/recovery/revocation.ts'
import { fingerprint } from '../src/remote/journal.ts'
import type { EndpointCredential } from '../src/remote/protocol.ts'
import { AdministrationObservation, RevocationObservation, WorldConfigurationObservation } from '../src/remote/recovery.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { createRecoveryKey, recoveryKey } from '../src/recovery/crypto.ts'
import { createCheckpoint, importCheckpointSessions, stageCheckpoint } from '../src/recovery/checkpoint.ts'
import { reserveCheckpointOwnership } from '../src/recovery/ownership.ts'
import { auditCheckpointReceipts } from '../src/recovery/audit.ts'
import { InventoryPage, InventoryReceipt } from '../src/ownership/inventory.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { WorldJournal, worldBinding, type WorldRecord } from '../src/remote/world-journal.ts'
import { RemoteClient } from '../src/remote/client.ts'
import type { RemoteJob, RemoteOperation, RevocationReceipt, RpcInput } from '../src/remote/protocol.ts'
import { PublicationClient, type PublicationConnection } from '../src/publication/client.ts'
import { contentHash } from '../src/publication/github.ts'
import type { DestinationView, Publication, PublicationReceipt, PublicationRpc } from '../src/publication/protocol.ts'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { remoteFixture } from './fixtures/remote.ts'
import { publicationFixture } from './fixtures/publication.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture(options: { administration?: boolean; credential?: boolean; rotateCredential?: boolean; revokeCredential?: boolean; pending?: boolean; channel?: boolean; extra?: boolean; revoked?: boolean;
  managed?: boolean; changedPin?: boolean; omitPublicationCredential?: boolean; input?: 'consumed' | 'missing'; revocation?: 'lost' | 'unsettled' | 'unsent'; kind?: DestinationView['kind'] } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-receipt-audit-')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const authority = await ownershipAuthority(cleanup, ['endpoint', 'publication']), owner = new CoordinatorOwnership(authority.config)
  cleanup.push(() => owner.close())
  const publisher = await publicationFixture(cleanup, authority.resourceFor('publication'), owner, options.kind)
  const bindings: { id: string; version: string }[] = []
  let importedCredential: EndpointCredential | undefined
  const remote = await remoteFixture(cleanup, { native: process.env.DSH_REMOTE_ISOLATION === '1', ownership: authority.resource, credentials: bindings,
    access: owner, beforeEnroll: async endpoint => {
      await owner.start()
      if (options.credential) {
        await writeFile(join(endpoint.credentials.imports, 'recovery-fixture'), 'synthetic-recovery-secret', { mode: 0o600 })
        importedCredential = await endpoint.rpc({ role: 'admin' }, { op: 'credential.import', requestId: randomUUID(), id: 'recovery-fixture', revision: 0,
          file: 'recovery-fixture', variable: 'RECOVERY_FIXTURE', mode: 'env', reason: 'Recovery credential qualification' }, owner.proof()) as EndpointCredential
        bindings.push({ id: importedCredential.id, version: importedCredential.version })
      }
    } })
  if (process.env.DSH_REMOTE_ISOLATION !== '1') vi.spyOn(remote.endpoint, 'identity').mockReturnValue({ ...remote.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const stateDir = join(directory, 'state'), worldDir = join(directory, 'world'), keyFile = join(directory, 'key')
  await mkdir(stateDir, { mode: 0o700 }); createRecoveryKey(keyFile)
  const context = new Context(); cleanup.push(() => context.fiber.dispose())
  new SourceCatalog(context)
  const inference = await inferenceFixture(context)
  await context.plugin(Jsonl, { root: join(directory, 'sessions'), compression: 'none' })
  const writer = await context.sessionPersistence.create(Session.create(SessionId('audit-master')).header)
  await writer.append([{ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: { role: 'user', id: MessageId('audit-start'),
    source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Audit qualification' }] } }]); await writer.close()
  const store = new Store(join(stateDir, 'orchestrator.sqlite')), world = new WorldJournal(worldDir, error => { throw error })
  world.bind(remote.endpoint.journal.id, remote.enrolled.grant)
  store.set(KV.runtime.masterId, 'audit-master')
  store.set(KV.runtime.ownership, { authorityId: authority.config.authorityId, coordinatorId: authority.config.coordinatorId })
  store.set(KV.runtime.publication, { serviceId: publisher.connection.serviceId,
    ...options.omitPublicationCredential ? {} : { credentialFile: publisher.connection.credentialFile } })
  const scope = { world: worldBinding(remote.endpoint.journal.id, remote.enrolled.grant), grantId: remote.enrolled.grant.id,
    epoch: remote.enrolled.grant.epoch, ownershipCoordinatorId: 'coordinator' }
  const command = world.effects.prepare(remote.spawn('printf private-command-payload > artifact'), scope)
  const job = await remote.client.call<RemoteJob>(command); const settled = await remote.settled(job.id)
  if (!options.pending && !options.administration) world.effects.observed({ op: 'job.get', id: job.id }, settled)
  const mutation = world.effects.prepare({ op: 'fs.write' as const, requestId: randomUUID(), path: 'second', content: 'private-file-payload', expected: { kind: 'createIfAbsent' as const } }, scope)
  const written = await remote.client.call<RemoteOperation>(mutation); if (!options.pending && !options.administration) world.effects.observed(mutation, written)
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
  if (options.administration) {
    const registry = new Endpoints({ store, stateDir, lifetime: new AbortController().signal, ownership: owner, workerRoots: () => [remote.enrolled.grant.root] })
    const registration = await registry.register({ requestId: randomUUID(), endpointId: remote.connection.endpointId, name: 'Recovery administrator', url: remote.url,
      credentialFile: await realpath(remote.connection.credentialFile), revision: 0 })
    const rpc = remote.endpoint.rpc.bind(remote.endpoint), lose = new Set<string>()
    const response = vi.spyOn(remote.endpoint, 'rpc').mockImplementation(async (...args) => {
      const result = await rpc(...args), request = args[1] as { requestId?: string }
      if (request.requestId && lose.delete(request.requestId)) throw new Error('Lost administrative acknowledgement after commit')
      return result
    })
    const submit = async (request: import('../src/environments/endpoint-model.ts').EndpointAction) => {
      lose.add(request.requestId)
      expect((await registry.submit(registration.id, { revision: registration.revision, request })).phase).toBe('unknown')
    }
    await submit({ op: 'grant.create', requestId: randomUUID(), owner: 'coordinator', workspace: 'administrative-world', operations: ['fs.read', 'process.spawn'], leaseMs: 300_000 })
    const grant = remote.endpoint.journal.grants().find(grant => grant.workspace === 'administrative-world')!
    await submit({ op: 'grant.change', requestId: randomUUID(), id: grant.id, revision: grant.revision, enabled: true, leaseMs: 300_000, reason: 'Qualification generation change' })
    await writeFile(join(remote.endpoint.credentials.imports, 'administration-fixture'), 'synthetic-administrator-secret', { mode: 0o600 })
    await submit({ op: 'credential.import', requestId: randomUUID(), id: 'administration-fixture', revision: 0, file: 'administration-fixture', variable: 'ADMINISTRATION_FIXTURE', mode: 'env', reason: 'Qualification import' })
    const credential = remote.endpoint.credentials.list().items.find(item => item.id === 'administration-fixture')!
    await submit({ op: 'credential.revoke', requestId: randomUUID(), id: credential.id, revision: credential.revision, reason: 'Qualification revoke' })
    await submit({ op: 'job.cancel', requestId: randomUUID(), id: job.id })
    remote.endpoint.journal.saveJob({ ...remote.endpoint.journal.job(job.id), phase: 'unknown', quiescent: null })
    await submit({ op: 'job.reconcile', requestId: randomUUID(), id: job.id, note: 'Observed the original process and confirmed its stopped range', quiescent: true })
    remote.endpoint.journal.saveOperation({ ...written, phase: 'unknown' })
    await submit({ op: 'operation.reconcile', requestId: randomUUID(), id: written.id, note: 'Observed original committed file and confirmed no helper remains' })
    expect((await registry.submit(registration.id, { revision: registration.revision, request: { op: 'grant.create', requestId: randomUUID(),
      owner: 'coordinator', workspace: 'refused-administrative-world', operations: ['fs.write'], leaseMs: 300_000 } })).phase).toBe('refused')
    await registry.stop(); response.mockRestore()
  }
  if (options.revoked || options.revocation) {
    world.revoke('revoke-world', 'Qualification revocation')
    const request = { op: 'grant.revoke' as const, requestId: 'revoke-world', reason: 'Qualification revocation' }
    if (options.revocation === 'lost') {
      remote.lose()
      await expect(remote.client.call(request)).rejects.toThrow()
      expect(remote.endpoint.journal.grant(remote.enrolled.grant.id)).toMatchObject({ enabled: false, epoch: 2 })
    } else if (options.revocation !== 'unsent') {
      if (options.revocation === 'unsettled') remote.endpoint.journal.saveJob({ ...settled, quiescent: false })
      const receipt = await remote.client.call<RevocationReceipt>(request)
      if (options.revocation === 'unsettled') expect(receipt.quiescent).toBe(false)
      world.acknowledge(receipt)
    }
  }
  if (options.managed) {
    store.db.exec('CREATE TABLE managed_world (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    store.db.prepare('INSERT INTO managed_world VALUES (?,?)').run(scope.world, JSON.stringify({ id: scope.world, grant: remote.enrolled.grant,
      enabled: !world.read()!.revocation, credentialPin: options.changedPin ? '0'.repeat(64) : credentialDigest(remote.enrolled.credential!),
      config: { endpointId: remote.connection.endpointId, url: remote.url, credentialFile: await realpath(remote.client.connection.credentialFile), stateDir: worldDir },
      ...(world.read()!.revocation ? { revoke: { requestId: 'revoke-world', reason: 'Qualification revocation' } } : {}) }))
  }
  if (options.input) {
    const ticket = inputTicket()
    if (options.input === 'missing') Object.assign(ticket.inputs[0]!, { readAt: inputTime })
    store.db.prepare('INSERT INTO ticket(id,value) VALUES (?,?)').run(ticket.id, JSON.stringify(ticket))
    const worker = await context.sessionPersistence.create(Session.create(SessionId('worker-ticket')).header)
    try {
      if (options.input === 'consumed') await worker.append([{ type: 'user/message', seq: SessionSeq(0), time: Date.parse(inputTime), surfaceOp: 'append', data: inputMessage('input') }])
      await worker.flush()
    } finally { await worker.close() }
  }
  world.close(); store.close()
  const checkpoint = await createCheckpoint({ stateDir, keyFile, outputDir: join(directory, 'backups'), worldDirectories: [worldDir], persistence: context.sessionPersistence })
  if (options.revocation === 'unsettled') remote.endpoint.journal.saveJob({ ...remote.endpoint.journal.job(job.id), quiescent: true })
  if (options.rotateCredential) await remote.admin.call({ op: 'credential.import', requestId: randomUUID(), id: importedCredential!.id, revision: importedCredential!.revision,
    file: 'recovery-fixture', variable: 'RECOVERY_FIXTURE', mode: 'env', reason: 'Qualification rotation after checkpoint' })
  if (options.revokeCredential) await remote.admin.call({ op: 'credential.revoke', requestId: randomUUID(), id: importedCredential!.id, revision: importedCredential!.revision, reason: 'Qualification revocation after checkpoint' })
  if (options.extra) {
    const extra = await remote.client.call<RemoteJob>(remote.spawn('printf later > later-artifact')); await remote.settled(extra.id)
    await publisher.client.call({ op: 'publish', publication: { ...publication, id: randomUUID() } })
  }
  await owner.close()
  const held = join(directory, 'held'); await stageCheckpoint(checkpoint.path, keyFile, held)
  const connection = { ...authority.admin.connection, coordinatorId: 'coordinator' }
  const reserved = await reserveCheckpointOwnership({ checkpoint: checkpoint.path, keyFile, destination: held, authority: connection,
    requestId: randomUUID(), epoch: 1, generation: 0 })
  const audit = { checkpoint: checkpoint.path, keyFile, destination: held, authority: connection, persistence: context.sessionPersistence, inference: inference.host, sources: recoverySourceHost(context),
    endpoints: [{ ...remote.connection, ownership: undefined, credentialFile: await realpath(remote.connection.credentialFile) }], publication: publisher.admin.config,
    worlds: [{ binding: worldBinding(remote.connection.endpointId, remote.enrolled.grant), endpointId: remote.connection.endpointId, url: remote.url,
      credentialFile: await realpath(remote.client.connection.credentialFile) }] }
  const read = () => { const store = new Store(join(held, 'orchestrator.sqlite')); try { return { report: store.get(KV.recovery.audit), hold: store.get(KV.recovery.hold) } } finally { store.close() } }
  return { directory, checkpoint, reserved, audit, authority, remote, publisher, publication, job: settled, written, channel, importedCredential, inference, read }
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

function savedWorld(f: Awaited<ReturnType<typeof fixture>>, directory = f.audit.destination): WorldRecord {
  const member = f.checkpoint.manifest.files.find(file => file.kind === 'world')!
  const db = new DatabaseSync(join(directory, member.member), { readOnly: true })
  try { return JSON.parse(String(db.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value)) as WorldRecord }
  finally { db.close() }
}

it.each(['lost', 'unsettled'] as const)('recovers a %s world revocation acknowledgement without resending or changing the source', async revocation => {
  const f = await fixture({ revocation, credential: true, rotateCredential: true }), original = savedWorld(f)
  const sourcePath = join(f.audit.destination, f.checkpoint.manifest.files.find(file => file.kind === 'world')!.member), sourceBytes = await readFile(sourcePath)
  const before = f.remote.endpoint.journal.db.prepare('SELECT * FROM remote_receipt ORDER BY id').all()
  const rpc = vi.spyOn(f.remote.endpoint, 'rpc'), audit = await auditCheckpointReceipts(f.audit)
  expect(audit).toMatchObject({ status: 'matched', issueCount: 0, matched: 6, observed: 1 })
  const options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }, prepared = await prepareCheckpointReceipts(options)
  expect(prepared.manifest.revocations).toEqual({ verified: 1, recovered: 1 })
  expect(await verifyReceiptImage(prepared.path, f.audit.keyFile)).toEqual(prepared.manifest)
  expect(await prepareCheckpointReceipts(options)).toEqual(prepared)
  expect(savedWorld(f, prepared.path)).toEqual({ ...original, phase: 'revoked', revocation: { ...original.revocation,
    receipt: { grantId: original.grant.id, epoch: original.grant.epoch, at: expect.any(String), quiescent: true } } })
  expect(savedWorld(f)).toEqual(original)
  expect(await readFile(sourcePath)).toEqual(sourceBytes)
  expect(f.read().hold?.state).toBe('staged')
  const db = new DatabaseSync(join(prepared.path, 'orchestrator.sqlite'), { readOnly: true })
  try { expect(JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.hold)!.value))).toMatchObject({ state: 'prepared' }) }
  finally { db.close() }
  expect(rpc.mock.calls.every(([, request]) => ['recovery.inventory', 'recovery.receipt', 'recovery.revocation'].includes((request as RpcInput).op))).toBe(true)
  expect(f.remote.endpoint.journal.db.prepare('SELECT * FROM remote_receipt ORDER BY id').all()).toEqual(before)
})

it('restricts original revocation observation to administrators and excludes private payloads', async () => {
  const f = await fixture({ revocation: 'lost', credential: true }), audit = await auditCheckpointReceipts(f.audit)
  const revision = audit.resources.find(resource => resource.identity.kind === 'endpoint')!.revision
  const request = { op: 'recovery.revocation' as const, revision, ...revocationRequest(savedWorld(f)) }
  const observed = RevocationObservation.parse(await f.remote.admin.call(request))
  expect(observed).toMatchObject({ found: true, quiescent: true, generationQuiescent: true, current: { enabled: false, epoch: 2 }, result: { epoch: 1 } })
  await expect(f.remote.client.call(request)).rejects.toThrow('administration')
  for (const privateValue of ['private-command-payload', 'private-file-payload', 'synthetic-recovery-secret', 'credentialDigest'])
    expect(JSON.stringify(observed)).not.toContain(privateValue)
  await expect(f.remote.admin.call({ ...request, requestHash: '0'.repeat(64) })).rejects.toThrow()
})

it.each(['unsent', 'missing', 'fingerprint', 'epoch', 'history', 'generation', 'binding', 'unsettled'] as const)('blocks %s revocation evidence and keeps recovery held', async mode => {
  const f = await fixture(mode === 'history' ? { revoked: true } : { revocation: mode === 'unsent' ? 'unsent' : 'lost' })
  const db = f.remote.endpoint.journal.db
  if (mode === 'missing') db.prepare('DELETE FROM remote_receipt WHERE id=?').run('revoke-world')
  if (mode === 'fingerprint') db.prepare('UPDATE remote_receipt SET fingerprint=? WHERE id=?').run('0'.repeat(64), 'revoke-world')
  if (mode === 'epoch' || mode === 'history') {
    const value = JSON.parse(String(db.prepare('SELECT value FROM remote_receipt WHERE id=?').get('revoke-world')!.value))
    if (mode === 'epoch') value.epoch++
    else value.at = new Date(Date.parse(value.at) + 1000).toISOString()
    db.prepare('UPDATE remote_receipt SET value=? WHERE id=?').run(JSON.stringify(value), 'revoke-world')
  }
  if (mode === 'generation' || mode === 'binding') {
    const grant = f.remote.endpoint.journal.grant(f.remote.enrolled.grant.id)
    f.remote.endpoint.journal.saveGrant({ ...grant, ...(mode === 'generation' ? { epoch: grant.epoch + 1 } : { owner: 'changed-owner' }) })
  }
  if (mode === 'unsettled') {
    f.remote.endpoint.journal.saveJob({ ...f.remote.endpoint.journal.job(f.job.id), quiescent: null, cancelRequested: true })
    const save = vi.spyOn(f.remote.endpoint.journal, 'saveJob')
    // Observe more than two ownership-monitor polls: an already requested cancellation must remain revision-stable.
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(save).not.toHaveBeenCalled()
  }
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('blocked')
  expect(audit.issues).toContainEqual({ code: ['unsent', 'missing'].includes(mode) ? 'revocation_missing' : 'revocation_mismatch',
    resource: f.remote.connection.endpointId, kind: 'revocation', id: 'revoke-world' })
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('complete matched audit')
  expect(f.read().hold?.state).toBe('staged')
})

it('invalidates revocation audit when the independent receipt changes during observation', async () => {
  const f = await fixture({ revocation: 'lost' }), call = RemoteClient.prototype.call
  vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(async function<T>(this: RemoteClient, request: RpcInput, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.revocation') f.remote.endpoint.journal.db.prepare('DELETE FROM remote_receipt WHERE id=?').run(request.id)
    return result as T
  })
  await expect(auditCheckpointReceipts(f.audit)).rejects.toThrow()
  expect(f.read().report).toMatchObject({ phase: 'failed', status: 'blocked', complete: false })
  expect(f.read().hold?.state).toBe('staged')
})

it('independently validates the original revocation again before preparing its held image', async () => {
  const f = await fixture({ revocation: 'lost' }), audit = await auditCheckpointReceipts(f.audit), call = RemoteClient.prototype.call
  vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(async function<T>(this: RemoteClient, request: RpcInput, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.revocation') {
      const observed = RevocationObservation.parse(result)
      return { ...observed, current: { ...observed.current!, enabled: true } } as T
    }
    return result as T
  })
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('revocation_mismatch')
  expect(savedWorld(f)).toMatchObject({ phase: 'revoking' })
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

it('proves an active original grant and private credential snapshot without dispatch or credential disclosure', async () => {
  const f = await fixture({ credential: true }), before = f.remote.endpoint.journal.jobs(), rpc = vi.spyOn(f.remote.endpoint, 'rpc')
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('matched')
  const revision = audit.resources.find(resource => resource.identity.kind === 'endpoint')!.revision
  const proof = WorldConfigurationObservation.parse(await f.remote.client.call({ op: 'recovery.world', revision }))
  expect(proof).toMatchObject({ privateBindingsVerified: true, rootVerified: true, quiescent: true, grant: { id: f.remote.enrolled.grant.id, epoch: 1 } })
  await expect(f.remote.admin.call({ op: 'recovery.world', revision })).rejects.toMatchObject({ code: 'grant_required' })
  const prepared = await prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })
  expect(prepared.manifest.executionConfiguration).toEqual({ worlds: 1, bindings: 1 })
  expect(await verifyReceiptImage(prepared.path, f.audit.keyFile)).toEqual(prepared.manifest)
  expect(f.remote.endpoint.journal.jobs()).toEqual(before)
  expect(rpc.mock.calls.every(([, request]) => (request as RpcInput).op.startsWith('recovery.'))).toBe(true)
  for (const value of [proof, audit, prepared.manifest]) {
    expect(JSON.stringify(value)).not.toContain('synthetic-recovery-secret')
    expect(JSON.stringify(value)).not.toContain('credential-vault')
    expect(JSON.stringify(value)).not.toContain('credentialPin')
  }
})

it.each(['missing-connection', 'missing-file', 'permissions', 'hardlink', 'symlink', 'wrong-token', 'workspace', 'expired', 'root-link'] as const)('blocks an active world with %s execution configuration', async mode => {
  const f = await fixture(), worlds = [...f.audit.worlds], connection = { ...worlds[0]! }
  worlds[0] = connection
  if (mode === 'missing-connection') worlds.length = 0
  if (mode === 'missing-file') await rm(connection.credentialFile)
  if (mode === 'permissions') await chmod(connection.credentialFile, 0o644)
  if (mode === 'hardlink') await link(connection.credentialFile, join(f.directory, 'extra-token-link'))
  if (mode === 'symlink') { const source = connection.credentialFile; connection.credentialFile = join(f.directory, 'token-link'); await symlink(source, connection.credentialFile) }
  if (mode === 'wrong-token') await writeFile(connection.credentialFile, 'grant.' + f.remote.enrolled.grant.id + '.1.' + 'x'.repeat(43))
  if (mode === 'workspace') { const source = connection.credentialFile; connection.credentialFile = join(f.remote.enrolled.grant.root, 'private-token'); await copyFile(source, connection.credentialFile) }
  if (mode === 'expired') {
    f.remote.endpoint.journal.saveGrant({ ...f.remote.endpoint.journal.grant(f.remote.enrolled.grant.id), leaseUntil: Date.now() - 1 })
    // Audit a stable expired generation. A sweep halfway through the inventory cut correctly rejects that changing audit.
    await vi.waitFor(() => expect(f.remote.endpoint.journal.grant(f.remote.enrolled.grant.id).enabled).toBe(false), { timeout: 3000, interval: 25 })
  }
  if (mode === 'root-link') { const root = f.remote.enrolled.grant.root; await rename(root, root + '-original'); await symlink(root + '-original', root) }
  const audit = await auditCheckpointReceipts({ ...f.audit, worlds })
  expect(audit.status).toBe('blocked')
  expect(audit.issues).toContainEqual({ code: mode === 'missing-connection' ? 'configuration_missing' : 'configuration_unavailable',
    kind: 'configuration', id: f.audit.worlds[0]!.binding, resource: f.remote.connection.endpointId })
  expect(f.read().hold?.state).toBe('staged')
})

it.each(['missing', 'changed', 'permissions', 'hardlink', 'symlink', 'vault-link'] as const)('detects a %s private vault file even when the public catalog revision is unchanged', async mode => {
  const f = await fixture({ credential: true }), file = join(f.remote.directory, 'control', 'credential-vault', f.importedCredential!.version)
  const before = InventoryPage.parse(await f.remote.admin.call({ op: 'recovery.inventory', offset: 0 }))
  if (mode === 'missing') await rm(file)
  if (mode === 'changed') await writeFile(file, 'modified-private-value')
  if (mode === 'permissions') await chmod(file, 0o644)
  if (mode === 'hardlink') await link(file, join(f.directory, 'vault-hardlink'))
  if (mode === 'symlink') { const target = join(f.directory, 'vault-link-target'); await copyFile(file, target); await rm(file); await symlink(target, file) }
  if (mode === 'vault-link') { const vault = join(f.remote.directory, 'control', 'credential-vault'); await rename(vault, vault + '-original'); await symlink(vault + '-original', vault) }
  expect(InventoryPage.parse(await f.remote.admin.call({ op: 'recovery.inventory', offset: 0 })).revision).toBe(before.revision)
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('blocked')
  expect(audit.issues.some(issue => issue.code === 'configuration_unavailable')).toBe(true)
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('complete matched audit')
})

it('rechecks private files at the end of audit when their bytes change without a catalog revision', async () => {
  const f = await fixture({ credential: true }), call = RemoteClient.prototype.call; let changed = false
  vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(async function<T>(this: RemoteClient, request: RpcInput, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.world' && !changed) {
      changed = true; await writeFile(join(f.remote.directory, 'control', 'credential-vault', f.importedCredential!.version), 'changed-during-audit')
    }
    return result as T
  })
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('blocked')
  expect(audit.issues.some(issue => issue.code === 'configuration_unavailable')).toBe(true)
})

it('rejects an inventory change during asynchronous private credential verification', async () => {
  const f = await fixture({ credential: true }), verify = f.remote.endpoint.credentials.verify.bind(f.remote.endpoint.credentials)
  vi.spyOn(f.remote.endpoint.credentials, 'verify').mockImplementationOnce(async bindings => {
    await verify(bindings)
    f.remote.endpoint.journal.remember(randomUUID(), '0'.repeat(64), 'changed-while-verifying')
  })
  await expect(auditCheckpointReceipts(f.audit)).rejects.toThrow()
  expect(f.read().report).toMatchObject({ phase: 'failed', status: 'blocked', complete: false })
})

it.each(['after-audit', 'during-preparation'] as const)('rechecks private vault integrity %s before publishing a held image', async mode => {
  const f = await fixture({ credential: true }), audit = await auditCheckpointReceipts(f.audit)
  const file = join(f.remote.directory, 'control', 'credential-vault', f.importedCredential!.version)
  if (mode === 'after-audit') await writeFile(file, 'changed-after-audit')
  else {
    const call = RemoteClient.prototype.call; let changed = false
    vi.spyOn(RemoteClient.prototype, 'call').mockImplementation(async function<T>(this: RemoteClient, request: RpcInput, signal?: AbortSignal): Promise<T> {
      const result = await call.call(this, request, signal)
      if (request.op === 'recovery.world' && !changed) { changed = true; await writeFile(file, 'changed-during-preparation') }
      return result as T
    })
  }
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('configuration_unavailable')
  expect((await readdir(f.audit.destination)).some(name => name.startsWith('prepared-'))).toBe(false)
  expect(f.read().hold?.state).toBe('staged')
})

it('does not require retired private credentials for an independently confirmed revoked world', async () => {
  const f = await fixture({ credential: true, revoked: true })
  await rm(f.audit.worlds[0]!.credentialFile)
  await rm(join(f.remote.directory, 'control', 'credential-vault', f.importedCredential!.version))
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('matched')
  const prepared = await prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })
  expect(prepared.manifest.executionConfiguration).toEqual({ worlds: 0, bindings: 0 })
  expect(savedWorld(f, prepared.path).phase).toBe('revoked')
})

it('resolves managed execution credentials from the authenticated catalog and enforces its original private pin', async () => {
  const f = await fixture({ managed: true, credential: true }), options = { ...f.audit, worlds: undefined }
  const audit = await auditCheckpointReceipts(options)
  expect(audit.status).toBe('matched')
  expect((await prepareCheckpointReceipts({ ...options, requestId: randomUUID(), auditId: audit.id })).manifest.executionConfiguration).toEqual({ worlds: 1, bindings: 1 })
  const changed = await fixture({ managed: true, changedPin: true })
  const blocked = await auditCheckpointReceipts({ ...changed.audit, worlds: undefined })
  expect(blocked.status).toBe('blocked')
  expect(blocked.issues.some(issue => issue.code === 'configuration_unavailable')).toBe(true)
})

it('rejects unrelated or duplicated execution credential selections instead of probing another world', async () => {
  const f = await fixture()
  await expect(auditCheckpointReceipts({ ...f.audit, worlds: [...f.audit.worlds, ...f.audit.worlds] })).rejects.toThrow('unique original worlds')
  await expect(auditCheckpointReceipts({ ...f.audit, worlds: [{ ...f.audit.worlds[0]!, binding: '0'.repeat(64) }] })).rejects.toThrow('unique original worlds')
  const audit = await auditCheckpointReceipts({ ...f.audit, worlds: [{ ...f.audit.worlds[0]!, endpointId: randomUUID() }] })
  expect(audit.status).toBe('blocked')
  expect(audit.issues.some(issue => issue.code === 'configuration_mismatch')).toBe(true)
})

it.each(['github-comment', 'github-review', 'feishu-reply'] as const)('prepares missing execution and %s acknowledgements in an authenticated held image', async kind => {
  const f = await fixture({ kind, pending: true, channel: true }), audit = await auditCheckpointReceipts(f.audit)
  const source = new DatabaseSync(join(f.audit.destination, 'orchestrator.sqlite'), { readOnly: true })
  const before = recoveryStateDigest(source); source.close()
  const options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }, prepared = await prepareCheckpointReceipts(options)
  expect(prepared.manifest.applied).toEqual({ commands: 1, mutations: 1, publications: 2 })
  expect(prepared.manifest.sessionBackend).toEqual({ sessions: 1, events: 1 })
  expect(prepared.manifest.controlConfiguration).toEqual({ claimant: true, publication: true, destinations: 1 })
  expect(prepared.manifest.sourceConfiguration).toEqual({ kinds: 3, enabled: 3, inactive: 0, retained: 0, configuration: expect.stringMatching(/^[a-f0-9]{64}$/) })
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

it.each(['missing', 'public', 'old', 'administrator', 'resource'] as const)('blocks recovery when the replacement claimant credential is %s', async kind => {
  const f = await fixture(), file = f.reserved.credentialFile
  if (kind === 'missing') await rm(file)
  else if (kind === 'public') await chmod(file, 0o644)
  else await copyFile(kind === 'old' ? f.authority.config.credentialFile : kind === 'administrator'
    ? f.authority.admin.connection.credentialFile : f.authority.resource.credentialFile, file)
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit).toMatchObject({ phase: 'complete', status: 'blocked', complete: true })
  expect(audit.issues).toContainEqual({ code: 'configuration_unavailable', resource: f.authority.config.authorityId, kind: 'configuration', id: 'claimant' })
  await expect(prepareCheckpointReceipts({ ...f.audit, auditId: audit.id, requestId: randomUUID() })).rejects.toThrow('complete matched audit')
  expect(await f.authority.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })).toMatchObject({ phase: 'vacant', epoch: 1 })
  expect(f.publisher.posts).toBe(1)
})

it.each(['missing', 'administrator', 'account', 'provider-file', 'linked', 'workspace'] as const)('blocks recovery with %s publication configuration', async kind => {
  const f = await fixture()
  let options: typeof f.audit & { publicationClient?: PublicationConnection } = f.audit
  if (kind === 'missing') await rm(f.publisher.connection.credentialFile)
  else if (kind === 'administrator') options = { ...f.audit, publicationClient: f.publisher.admin.config }
  else if (kind === 'account') f.publisher.login('different-account')
  else if (kind === 'provider-file') await rm(f.publisher.destination.credentialFile)
  else {
    const file = join(kind === 'workspace' ? f.remote.enrolled.grant.root : f.directory, 'selected-publisher.token')
    if (kind === 'linked') await symlink(f.publisher.connection.credentialFile, file)
    else await copyFile(f.publisher.connection.credentialFile, file)
    options = { ...f.audit, publicationClient: { ...f.publisher.connection, credentialFile: file } }
  }
  const audit = await auditCheckpointReceipts(options)
  expect(audit.status).toBe('blocked')
  expect(audit.issues).toContainEqual({ code: 'configuration_unavailable', resource: f.publisher.connection.serviceId, kind: 'configuration', id: 'publication' })
  expect(f.publisher.posts).toBe(1); expect(f.read().hold?.state).toBe('staged')
})

it('requires an explicit client selection when an older checkpoint lacks its publication credential path', async () => {
  const f = await fixture({ omitPublicationCredential: true }), missing = await auditCheckpointReceipts(f.audit)
  expect(missing.issues).toContainEqual({ code: 'configuration_missing', resource: f.publisher.connection.serviceId, kind: 'configuration', id: 'publication' })
  const options = { ...f.audit, publicationClient: f.publisher.connection }, audit = await auditCheckpointReceipts(options)
  expect(audit.status).toBe('matched')
  const preparation = { ...options, auditId: audit.id, requestId: randomUUID() }, image = await prepareCheckpointReceipts(preparation)
  expect(image.manifest.controlConfiguration).toEqual({ claimant: true, publication: true, destinations: 1 })
  await expect(prepareCheckpointReceipts({ ...preparation, publicationClient: { ...f.publisher.connection, timeoutMs: 5000 } })).rejects.toThrow('request differs')
  await rm(f.reserved.credentialFile); await rm(f.publisher.connection.credentialFile)
  expect(await prepareCheckpointReceipts(preparation)).toEqual(image)
})

it('refuses a substituted publisher identity in the selected recovery client', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts({ ...f.audit, publicationClient: { ...f.publisher.connection, serviceId: randomUUID() } })
  expect(audit.issues).toContainEqual({ code: 'configuration_mismatch', resource: f.publisher.connection.serviceId, kind: 'configuration', id: 'publication' })
})

it.each(['claimant', 'publisher', 'provider'] as const)('rechecks %s configuration after audit and again before publishing the held image', async kind => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit), call = PublicationClient.prototype.call
  let changed = false
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.receipt' && !changed) {
      changed = true
      if (kind === 'claimant') await rm(f.reserved.credentialFile)
      else if (kind === 'publisher') await chmod(f.publisher.connection.credentialFile, 0o644)
      else f.publisher.login('different-account')
    }
    return result as T
  })
  await expect(prepareCheckpointReceipts({ ...f.audit, auditId: audit.id, requestId: randomUUID() })).rejects.toThrow('configuration_unavailable')
  expect(changed).toBe(true)
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
  expect(f.read().hold?.state).toBe('staged'); expect(f.publisher.posts).toBe(1)
})

it('does not reuse an audit after the configured provider account changes', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit)
  f.publisher.login('different-account')
  await expect(prepareCheckpointReceipts({ ...f.audit, auditId: audit.id, requestId: randomUUID() })).rejects.toThrow('configuration_unavailable')
  expect((await readdir(f.audit.destination)).some(name => name.startsWith('prepared-'))).toBe(false)
})

it('requires actual destination Sessions, then verifies an imported backend without appending or granting execution', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit), context = new Context()
  cleanup.push(() => context.fiber.dispose())
  await context.plugin(Jsonl, { root: join(f.directory, 'destination-sessions'), compression: 'none' })
  const persistence = context.sessionPersistence, options = { ...f.audit, persistence, auditId: audit.id, requestId: randomUUID() }
  await expect(prepareCheckpointReceipts(options)).rejects.toThrow('missing checkpoint history')
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
  await importCheckpointSessions(f.audit.checkpoint, f.audit.keyFile, f.audit.destination, persistence)
  const create = vi.spyOn(persistence, 'create'), prepared = await prepareCheckpointReceipts(options)
  expect(create).not.toHaveBeenCalled(); expect(prepared.manifest.sessionBackend).toEqual({ sessions: 1, events: 1 })
  expect(await verifyReceiptImage(prepared.path, f.audit.keyFile)).toEqual(prepared.manifest)
  expect(f.read().hold?.state).toBe('staged'); expect(prepared.manifest.executionOwnership).toBe(false)
  const writer = await persistence.open(SessionId('audit-master'), 'write')
  await writer.append([{ type: 'user/message', seq: SessionSeq(1), time: 1, surfaceOp: 'append', data: { role: 'user', id: MessageId('later'),
    source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Later history' }] } }]); await writer.close()
  // An original-ID retry retrieves historical authenticated evidence; it does not reauthorize activation.
  expect(await prepareCheckpointReceipts(options)).toEqual(prepared)
})

it('keeps destination writers claimed throughout preparation and rejects a newly related Session before publication', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit), call = PublicationClient.prototype.call
  let checked = false
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const result = await call.call(this, request, signal)
    if (request.op === 'recovery.receipt' && !checked) {
      checked = true
      await expect(f.audit.persistence.open(SessionId('audit-master'), 'write')).rejects.toThrow()
      const child = await f.audit.persistence.create({ ...Session.create(SessionId('later-child')).header, parentSession: SessionId('audit-master') })
      await child.flush(); await child.close()
    }
    return result as T
  })
  await expect(prepareCheckpointReceipts({ ...f.audit, auditId: audit.id, requestId: randomUUID() })).rejects.toThrow('extra related descendant')
  expect(checked).toBe(true)
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
  const released = await f.audit.persistence.open(SessionId('audit-master'), 'write'); await released.close()
  expect(f.read().hold?.state).toBe('staged'); expect(f.publisher.posts).toBe(1)
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
  f.inference.unregister()
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

it('authenticates older held image manifests without treating absent configuration or Session evidence as a new verification', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit)
  const prepared = await prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })
  const { sessionBackend: _, controlConfiguration: __, inferenceConfiguration: ___, consumedInputs: ____, sourceConfiguration: _____, ...manifest } = prepared.manifest, key = recoveryKey(f.audit.keyFile)
  try {
    const mac = createHmac('sha256', key).update('dsh-receipt-image:1\n').update(JSON.stringify(manifest)).digest('hex')
    await writeFile(join(prepared.path, 'prepared.json'), JSON.stringify({ manifest, mac }))
  } finally { key.fill(0) }
  const verified = await verifyReceiptImage(prepared.path, f.audit.keyFile)
  expect(verified).toEqual(manifest); expect(verified.sessionBackend).toBeUndefined(); expect(verified.controlConfiguration).toBeUndefined(); expect(verified.executionOwnership).toBe(false)
  expect(verified.inferenceConfiguration).toBeUndefined(); expect(verified.consumedInputs).toBeUndefined(); expect(verified.sourceConfiguration).toBeUndefined()
})

it('repairs consumed input acknowledgements only in the signed held image and preserves historical retries', async () => {
  const f = await fixture({ input: 'consumed' }), audit = await auditCheckpointReceipts(f.audit)
  const options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }, prepared = await prepareCheckpointReceipts(options)
  expect(prepared.manifest.consumedInputs).toEqual({ tickets: 1, inputs: 1, consumed: 1, readMarkers: 1, undelivered: 1 })
  const read = (directory: string) => {
    const db = new DatabaseSync(join(directory, 'orchestrator.sqlite'), { readOnly: true })
    try { return JSON.parse(String(db.prepare('SELECT value FROM ticket WHERE id=?').get('ticket')!.value)) } finally { db.close() }
  }
  expect(read(join(f.directory, 'state'))).toEqual(inputTicket())
  expect(read(f.audit.destination)).toEqual(inputTicket())
  expect(read(prepared.path)).toEqual({ ...inputTicket(), inputs: [{ ...inputTicket().inputs[0], readAt: inputTime }], undelivered: [] })
  expect(await verifyReceiptImage(prepared.path, f.audit.keyFile)).toEqual(prepared.manifest)
  expect(f.read().hold?.state).toBe('staged'); expect(prepared.manifest.executionOwnership).toBe(false)
  f.inference.unregister(); f.audit.sources.current = () => undefined; expect(await prepareCheckpointReceipts(options)).toEqual(prepared)
})
it('refuses contradictory read acknowledgements before inference and discards the unpublished image', async () => {
  const f = await fixture({ input: 'missing' }), audit = await auditCheckpointReceipts(f.audit)
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toMatchObject({ code: 'input_read_missing' })
  expect(f.inference.adapter.calls).toEqual([])
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
  expect(f.read().hold?.state).toBe('staged'); expect(f.publisher.posts).toBe(1)
})

it.each(['before', 'during', 'late'] as const)('retains the restore hold when source registration is unavailable or changes %s preparation', async when => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit)
  if (when === 'before') f.audit.sources.current = () => undefined
  else f.inference.adapter.before = async () => {
    if (f.inference.adapter.calls.length === (when === 'during' ? 1 : 2)) {
      const catalog = f.audit.sources.current()!
      const contract = catalog.snapshot().contracts.find(contract => contract.kind === 'workspace')!
      catalog.register({ ...contract, kind: 'changed' })
    }
  }
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow(when === 'before' ? 'source_configuration_missing' : 'source_configuration_changed')
  expect((await readdir(f.audit.destination)).filter(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toEqual([])
  expect(f.read().hold?.state).toBe('staged'); expect(f.publisher.posts).toBe(1)
  if (when === 'before') expect(f.inference.adapter.calls).toEqual([])
})

it.each(['before', 'during'] as const)('retains the restore hold when inference fails %s preparation', async when => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit)
  if (when === 'before') f.inference.unregister()
  else f.inference.adapter.before = async () => { if (f.inference.adapter.calls.length === 2) throw new Error('synthetic-provider-secret') }
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('configuration_unavailable')
  expect((await readdir(f.audit.destination)).some(name => name.startsWith('prepared-') || name.startsWith('.prepare-'))).toBe(false)
  expect(f.read().hold?.state).toBe('staged'); expect(f.publisher.posts).toBe(1)
})

it('reconciles all seven original administrative actions without resending or adopting newer grants and credentials', async () => {
  const f = await fixture({ administration: true }), audit = await auditCheckpointReceipts(f.audit)
  expect(audit).toMatchObject({ status: 'matched', issueCount: 0, matched: 12 })
  const before = f.remote.endpoint.journal.db.prepare('SELECT * FROM remote_receipt ORDER BY id').all()
  const options = { ...f.audit, requestId: randomUUID(), auditId: audit.id }, prepared = await prepareCheckpointReceipts(options)
  expect(prepared.manifest.administration).toEqual({ verified: 7, recovered: 1, superseded: 2 })
  expect(await verifyReceiptImage(prepared.path, f.audit.keyFile)).toEqual(prepared.manifest)
  expect(await prepareCheckpointReceipts(options)).toEqual(prepared)
  const db = new DatabaseSync(join(prepared.path, 'orchestrator.sqlite'), { readOnly: true })
  try {
    const commands = db.prepare('SELECT value FROM operator_endpoint_command').all().map(row => JSON.parse(String(row.value)))
    const find = (action: string) => commands.find(command => command.request.op === action && command.phase !== 'refused')
    expect(find('grant.create')).toMatchObject({ phase: 'superseded', recovery: { originalPhase: 'unknown' } })
    expect(find('grant.create').result).toBeUndefined()
    expect(find('grant.change')).toMatchObject({ phase: 'recovered', result: { grant: { epoch: 2 } } })
    expect(find('grant.change').credentialPin).toBeUndefined()
    expect(find('credential.import')).toMatchObject({ phase: 'superseded', result: { credential: { revision: 1, enabled: true } } })
    expect(find('credential.revoke')).toMatchObject({ phase: 'done', result: { credential: { revision: 2, enabled: false } } })
    for (const action of ['job.cancel', 'job.reconcile', 'operation.reconcile']) expect(find(action)).toMatchObject({ phase: 'done', recovery: { originalPhase: 'unknown' } })
    expect(commands.filter(command => command.phase === 'refused')).toHaveLength(1)
    expect(JSON.stringify(commands)).not.toContain('synthetic-administrator-secret')
  } finally { db.close() }
  const source = new DatabaseSync(join(f.audit.destination, 'orchestrator.sqlite'), { readOnly: true })
  try { expect(source.prepare("SELECT count(*) AS n FROM operator_endpoint_command WHERE value ->> '$.phase'='unknown'").get()!.n).toBe(7) } finally { source.close() }
  expect(f.remote.endpoint.journal.db.prepare('SELECT * FROM remote_receipt ORDER BY id').all()).toEqual(before)
})

it('restricts historical administration inspection to pinned administrators without exposing credentials or command payloads', async () => {
  const f = await fixture({ administration: true }), audit = await auditCheckpointReceipts(f.audit)
  const db = new DatabaseSync(join(f.audit.destination, 'orchestrator.sqlite'), { readOnly: true })
  const commands = db.prepare('SELECT value FROM operator_endpoint_command').all().map(row => JSON.parse(String(row.value))); db.close()
  const revision = audit.resources.find(resource => resource.identity.kind === 'endpoint')!.revision
  for (const command of commands) {
    const request = { op: 'recovery.administration' as const, revision, ...administrationRequest(command) }
    const observed = AdministrationObservation.parse(await f.remote.admin.call(request))
    expect(observed.found).toBe(command.phase !== 'refused')
    expect(JSON.stringify(observed)).not.toMatch(/synthetic-administrator-secret|private-command-payload|private-file-payload|"digest"|"argv"|"credential"\s*:/)
    await expect(f.remote.client.call(request)).rejects.toThrow('administration')
    if (observed.found) await expect(f.remote.admin.call({ ...request, requestHash: 'f'.repeat(64) })).rejects.toThrow('another payload')
  }
})

it.each(['missing', 'changed'] as const)('blocks an original administrative receipt that is %s', async mode => {
  const f = await fixture({ administration: true })
  const db = new DatabaseSync(join(f.audit.destination, 'orchestrator.sqlite'), { readOnly: true })
  const command = JSON.parse(String(db.prepare("SELECT value FROM operator_endpoint_command WHERE value ->> '$.phase'='unknown' LIMIT 1").get()!.value)); db.close()
  if (mode === 'missing') f.remote.endpoint.journal.db.prepare('DELETE FROM remote_receipt WHERE id=?').run(command.id)
  else f.remote.endpoint.journal.db.prepare('UPDATE remote_receipt SET fingerprint=? WHERE id=?').run('f'.repeat(64), command.id)
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('blocked')
  expect(audit.issues).toContainEqual({ code: mode === 'missing' ? 'administration_missing' : 'administration_mismatch', resource: command.endpointId, kind: 'administration', id: command.id })
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('complete matched audit')
})

it('invalidates an audit on administrative receipt changes even when effect and grant metadata are unchanged', async () => {
  const f = await fixture(), audit = await auditCheckpointReceipts(f.audit)
  f.remote.endpoint.journal.db.prepare('UPDATE remote_receipt SET value=value WHERE id=?').run('enroll')
  await expect(prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).rejects.toThrow('changed')
})

it('matches active-world credential versions without exposing credential content or private digests', async () => {
  const f = await fixture({ credential: true }), audit = await auditCheckpointReceipts(f.audit)
  expect(audit).toMatchObject({ status: 'matched', matched: 6 })
  const page = InventoryPage.parse(await f.remote.admin.call({ op: 'recovery.inventory', offset: 0 }))
  expect(page.items.find(item => item.kind === 'credential')).toMatchObject({ id: f.importedCredential!.id, phase: 'enabled', requestHash: fingerprint({
    id: f.importedCredential!.id, version: f.importedCredential!.version, variable: 'RECOVERY_FIXTURE', mode: 'env' }) })
  expect(JSON.stringify(page)).not.toMatch(/synthetic-recovery-secret|"digest"/)
  expect((await prepareCheckpointReceipts({ ...f.audit, requestId: randomUUID(), auditId: audit.id })).manifest.administration).toEqual({ verified: 0, recovered: 0, superseded: 0 })
})

it('blocks an active world whose credential was rotated after capture and keeps revoked worlds non-executable', async () => {
  const f = await fixture({ credential: true, rotateCredential: true }), audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('blocked')
  expect(audit.issues).toContainEqual({ code: 'receipt_mismatch', resource: f.remote.connection.endpointId, kind: 'credential', id: 'recovery-fixture' })
  const revoked = await fixture({ credential: true, rotateCredential: true, revoked: true })
  expect((await auditCheckpointReceipts(revoked.audit)).status).toBe('matched')
  expect(revoked.read().hold?.state).toBe('staged')
})

it('blocks credential revocation even when the original credential version and grant are unchanged', async () => {
  const f = await fixture({ credential: true, revokeCredential: true })
  // Fault injection: a stale grant row must not hide the independently disabled credential catalog entry.
  // Freeze the periodic correction of that injected row so this tests catalog evidence, not a concurrent revision change.
  vi.spyOn(f.remote.endpoint as unknown as { sweep(): void }, 'sweep').mockImplementation(() => {})
  f.remote.endpoint.journal.saveGrant(f.remote.enrolled.grant)
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('blocked')
  expect(audit.issues).toContainEqual({ code: 'receipt_mismatch', resource: f.remote.connection.endpointId, kind: 'credential', id: 'recovery-fixture' })
})

it('rejects changed administrative reconciliation evidence under the original request ID', async () => {
  const f = await fixture({ administration: true }), job = f.remote.endpoint.journal.job(f.job.id)
  job.reconciled = { at: job.reconciled!.at, note: 'Different reconciliation evidence' }; f.remote.endpoint.journal.saveJob(job)
  const audit = await auditCheckpointReceipts(f.audit)
  expect(audit.status).toBe('blocked')
  expect(audit.issues.some(issue => issue.kind === 'administration' && issue.code === 'administration_mismatch')).toBe(true)
})
