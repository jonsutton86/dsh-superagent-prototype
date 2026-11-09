import { Context } from '@deepseek-ai/cordis'
import { inferenceFixture } from './inference.ts'
import { SourceCatalog } from '../../src/sources/catalog.ts'
import { recoverySourceHost } from '../../src/recovery/sources.ts'
import { inputMessage, inputTicket, inputTime, seedInputTicket } from './recovery-inputs.ts'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { createHmac, randomUUID } from 'node:crypto'
import { appendFile, chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { Runtime } from '../../src/app/runtime.ts'
import { testMachine } from './deployment.ts'
import { prepareCheckpointReceipts } from '../../src/recovery/prepare.ts'
import { verifyReceiptImage } from '../../src/recovery/image.ts'
import { recoveryStateDigest } from '../../src/recovery/state.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Endpoints } from '../../src/environments/endpoints.ts'
import { credentialDigest } from '../../src/environments/endpoint-files.ts'
import { administrationRequest } from '../../src/recovery/administration.ts'
import { revocationRequest } from '../../src/recovery/revocation.ts'
import { fingerprint } from '../../src/remote/journal.ts'
import type { EndpointCredential } from '../../src/remote/protocol.ts'
import { AdministrationObservation, RevocationObservation, WorldConfigurationObservation } from '../../src/remote/recovery.ts'
import { Store } from '../../src/app/store.ts'
import { KV } from '../../src/kv.ts'
import { createRecoveryKey, recoveryKey } from '../../src/recovery/crypto.ts'
import { createCheckpoint, importCheckpointSessions, stageCheckpoint } from '../../src/recovery/checkpoint.ts'
import { reserveCheckpointOwnership } from '../../src/recovery/ownership.ts'
import { auditCheckpointReceipts } from '../../src/recovery/audit.ts'
import { InventoryPage, InventoryReceipt } from '../../src/ownership/inventory.ts'
import { CoordinatorOwnership } from '../../src/ownership/lease.ts'
import { WorldJournal, worldBinding, type WorldRecord } from '../../src/remote/world-journal.ts'
import { RemoteClient } from '../../src/remote/client.ts'
import type { RemoteJob, RemoteOperation, RevocationReceipt, RpcInput } from '../../src/remote/protocol.ts'
import { PublicationClient, type PublicationConnection } from '../../src/publication/client.ts'
import { contentHash } from '../../src/publication/github.ts'
import type { DestinationView, Publication, PublicationReceipt, PublicationRpc } from '../../src/publication/protocol.ts'
import { ownershipAuthority } from './ownership-authority.ts'
import { remoteFixture } from './remote.ts'
import { publicationFixture } from './publication.ts'
import { scheduleDefinition, workspaceStateFixture } from './workspace-state.ts'
import { Library } from '../../src/workspace/library.ts'
import { Personas } from '../../src/personas/service.ts'
import { Usage } from '../../src/usage/service.ts'
import { Publications } from '../../src/publication/runtime.ts'
import { ChannelPublications } from '../../src/publication/channels.ts'

export async function recoveryAuditFixture(cleanup: (() => Promise<unknown>)[], options: { administration?: boolean; credential?: boolean; rotateCredential?: boolean; revokeCredential?: boolean; pending?: boolean; channel?: boolean; extra?: boolean; revoked?: boolean;
  managed?: boolean; changedPin?: boolean; omitPublicationCredential?: boolean; input?: 'consumed' | 'missing'; graph?: 'indexes' | 'conflict'; connector?: 'valid' | 'invalid'; workspace?: 'valid' | 'conflict'; results?: 'valid' | 'conflict'; registries?: 'valid' | 'conflict'; resources?: 'valid' | 'context-conflict' | 'budget-conflict'; publicationGraph?: 'approval-conflict' | 'grant-conflict' | 'outbox-conflict'; revocation?: 'lost' | 'unsettled' | 'unsent'; kind?: DestinationView['kind'] } = {}) {
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
  const library = new Library(store), artifact = library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'Publication evidence', summary: 'Original approval', content: text })
  const publications = new Publications({ store, library, ownership: owner, connection: publisher.connection, lifetime: new AbortController().signal, roots: () => [] })
  const approved = await publications.publish(artifact.id, { requestId: randomUUID(), revision: artifact.revision, hash: artifact.hash,
    destination: destination.id, destinationHash: destination.hash })
  const storedPublication = JSON.parse(String(store.db.prepare('SELECT value FROM workspace_publication WHERE id=?').get(approved.id)!.value))
  const publication: Publication = storedPublication.intent
  storedPublication.intent = Object.fromEntries(Object.entries(publication).reverse())
  if (options.pending) { delete storedPublication.receipt; storedPublication.phase = 'unknown' }
  store.db.prepare('UPDATE workspace_publication SET value=? WHERE id=?').run(JSON.stringify(storedPublication), publication.id)
  await publications.stop()
  if (options.omitPublicationCredential) store.set(KV.runtime.publication, { serviceId: publisher.connection.serviceId })
  let channel: Publication | undefined
  if (options.channel) {
    let deliveries: ChannelPublications
    const product = workspaceStateFixture(store, (mission, action) => deliveries.channel(mission, action))
    deliveries = new ChannelPublications({ store, ownership: owner, connection: publisher.connection, lifetime: new AbortController().signal,
      mission: id => product.workspace.get(id), destinations: async () => ({ configured: true, items: [destination] }), authorized: () => true })
    let mission = product.workspace.create({ requestId: randomUUID(), title: 'Delivery evidence', objective: 'Keep the original delivery grant', acceptance: 'Recorded receipt' })
    mission = product.workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Prepare reply', instructions: 'Prepare the result', owner: 'agent' })
    await deliveries.configure(mission.id, { requestId: randomUUID(), revision: 0, missionRevision: mission.revision, enabled: true,
      destination: destination.id, destinationHash: destination.hash })
    mission = product.workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
    const ticket = store.tickets.get(mission.actions[0]!.runs[0]!)!, trigger = store.triggers.get(ticket.origin.triggerId)!
    const message = { id: 'channel-message', channel: trigger.channel!, text, kind: 'reply' as const, ticketId: ticket.id }
    store.receipts.add(message)
    await deliveries.send(message)
    const stored = JSON.parse(String(store.db.prepare('SELECT value FROM channel_publication WHERE message=?').get(message.id)!.value))
    channel = stored.publication; delete stored.receipt; stored.phase = 'unknown'; stored.withdrawn = true
    store.db.prepare('UPDATE channel_publication SET value=? WHERE id=?').run(JSON.stringify(stored), stored.id)
    store.db.prepare('UPDATE outbox SET value=? WHERE id=?').run(JSON.stringify({ ...message, status: 'pending' }), message.id)
    await deliveries.stop()
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
    const submit = async (request: import('../../src/environments/endpoint-model.ts').EndpointAction) => {
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
    store.db.exec('CREATE TABLE managed_world (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE managed_world_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, world TEXT NOT NULL)')
    const at = new Date().toISOString(), grant = remote.enrolled.grant
    store.db.prepare('INSERT INTO managed_world_command VALUES (?,?,?)').run('original-activation', fingerprint('original-activation'), scope.world)
    if (world.read()!.revocation) store.db.prepare('INSERT INTO managed_world_command VALUES (?,?,?)').run('revoke-world', fingerprint({ op: 'revoke', id: scope.world,
      requestId: 'revoke-world', revision: 1, reason: 'Qualification revocation' }), scope.world)
    store.db.prepare('INSERT INTO managed_world VALUES (?,?)').run(scope.world, JSON.stringify({ id: scope.world, grant: remote.enrolled.grant,
      name: 'Original managed world', endpointId: remote.connection.endpointId, grantId: grant.id, epoch: grant.epoch, root: grant.root,
      revision: world.read()!.revocation ? 2 : 1, createdAt: at, updatedAt: at,
      enabled: !world.read()!.revocation, credentialPin: options.changedPin ? '0'.repeat(64) : credentialDigest(remote.enrolled.credential!),
      config: { endpointId: remote.connection.endpointId, url: remote.url, credentialFile: await realpath(remote.client.connection.credentialFile), stateDir: worldDir },
      ...(world.read()!.revocation ? { revoke: { requestId: 'revoke-world', reason: 'Qualification revocation' } } : {}) }))
  }
  if (options.input) {
    const ticket = inputTicket()
    if (options.input === 'missing') Object.assign(ticket.inputs[0]!, { readAt: inputTime })
    seedInputTicket(store, ticket)
    const worker = await context.sessionPersistence.create(Session.create(SessionId('worker-ticket')).header)
    try {
      if (options.input === 'consumed') await worker.append([{ type: 'user/message', seq: SessionSeq(0), time: Date.parse(inputTime), surfaceOp: 'append', data: inputMessage('input') }])
      await worker.flush()
    } finally { await worker.close() }
  }
  if (options.graph === 'indexes') store.db.exec("UPDATE trigger SET at='stale'; UPDATE decision SET thread='stale'; DELETE FROM trigger_thread")
  if (options.graph === 'conflict') {
    const ticket = store.tickets.get('ticket')!; ticket.mandate.scope = 'Changed authority'; store.tickets.save(ticket)
  }
  if (options.connector) store.set(KV.github.since, options.connector === 'valid' ? inputTime : 'private-invalid-cursor')
  if (options.results) {
    const library = new Library(store), record = library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'Captured artifact', summary: 'Original bytes', content: 'Original artifact bytes' })
    if (options.results === 'conflict') store.db.prepare('UPDATE workspace_blob SET data=? WHERE hash=?').run(Buffer.from('Changed artifact bytes'), record.hash)
  }
  if (options.registries) {
    const personas = new Personas(store), persona = await personas.create({ requestId: randomUUID(), definition: { name: 'Recorded researcher',
      description: 'Original identity', instructions: 'Preserve original evidence.', model: null, capabilities: ['read'], skills: [] } })
    personas.archive(persona.id, { requestId: randomUUID(), revision: 1, archived: true, reason: 'Retired for new work' })
    if (options.registries === 'conflict') store.db.exec('DELETE FROM persona_version')
  }
  if (options.resources) {
    const library = new Library(store), record = library.publish({ requestId: randomUUID(), kind: 'memory', title: 'Recall evidence', summary: 'Original context', content: 'Original context bytes' })
    library.recall.read({ id: record.id }, { role: 'router' }, new AbortController().signal)
    const usage = new Usage(store), owner = { sessionId: 'audit-master', root: 'audit-master', role: 'orchestrator' as const }
    usage.bind(owner.sessionId, owner.root)
    usage.configure({ requestId: randomUUID(), revision: 0, budgets: [], prices: [{ provider: 'fixture', model: 'current', input: 1000000, output: 2000000,
      cacheRead: 100000, cacheWrite: 1000000, note: 'Synthetic qualification rates' }] })
    usage.begin(owner, 'fixture', 'current', 'conversation', 100)
    if (options.resources === 'context-conflict') store.db.exec("UPDATE workspace_recall_attempt SET value=json_set(value,'$.charged.calls',0)")
    if (options.resources === 'budget-conflict') store.db.exec("UPDATE usage_call SET value=json_set(value,'$.reservedCost',0)")
  }
  if (options.workspace) {
    const product = workspaceStateFixture(store)
    const schedule = product.schedules.create({ requestId: randomUUID(), enabled: true, definition: scheduleDefinition() })
    product.schedules.tick()
    if (options.workspace === 'conflict') {
      const missionId = product.schedules.get(schedule.id).occurrences[0]!.missionId!
      const mission = JSON.parse(String(store.db.prepare('SELECT value FROM workspace_mission WHERE id=?').get(missionId)!.value))
      mission.actions[0].instructions = 'Substituted unapproved instructions'
      store.db.prepare('UPDATE workspace_mission SET value=? WHERE id=?').run(JSON.stringify(mission), missionId)
    }
  }
  if (options.publicationGraph === 'approval-conflict') store.db.exec("UPDATE workspace_publication SET value=json_set(value,'$.approval.revision',999)")
  if (options.publicationGraph === 'grant-conflict') store.db.exec("UPDATE delivery_grant SET fingerprint='" + '0'.repeat(64) + "'")
  if (options.publicationGraph === 'outbox-conflict') store.db.exec("UPDATE outbox SET value=json_set(value,'$.text','private-substitution') WHERE id='channel-message'")
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
  return { context, stateDir, worldDir, directory, checkpoint, reserved, audit, authority, remote, publisher, publication, job: settled, written, channel, importedCredential, inference, read }
}
