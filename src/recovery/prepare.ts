import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { Store } from '../app/store.ts'
import type { OutboundMessage } from '../core/index.ts'
import { KV } from '../kv.ts'
import { credentialDigest, privateCredential } from '../environments/endpoint-files.ts'
import { OwnershipClient } from '../ownership/client.ts'
import { OwnershipStamp, OwnershipView } from '../ownership/protocol.ts'
import { sameOwner } from '../ownership/gate.ts'
import { InventoryPage, InventoryReceipt, type InventoryRequest, type ReceiptRequest } from '../ownership/inventory.ts'
import { RemoteClient } from '../remote/client.ts'
import { AdministrationObservation, RevocationObservation } from '../remote/recovery.ts'
import { administrationRequest, observeAdministration, type SavedAdministration } from './administration.ts'
import { observeRevocation, revocationRequest } from './revocation.ts'
import { worldConfigurations, verifyWorldConfiguration, type WorldConfigurationCheck } from './configuration.ts'
import { EffectOwner, type AdministrationRead, type RevocationRead } from '../remote/protocol.ts'
import { ExecutionEffects, type ExecutionReceipt } from '../remote/effects.ts'
import { fingerprint, inside } from '../remote/journal.ts'
import type { WorldRecord } from '../remote/world-journal.ts'
import { PublicationClient } from '../publication/client.ts'
import { ExternalReceipt, Publication, PublicationReceipt } from '../publication/protocol.ts'
import { withVerifiedStagedCheckpoint } from './checkpoint.ts'
import type { RecoveryIntent } from './ownership.ts'
import type { AuditCheckpointReceipts, ReceiptAudit } from './audit.ts'
import { recoveryKey } from './crypto.ts'
import { ReceiptImage, recoveryFileDigest, sealReceiptImage, syncRecoveryPath, verifyReceiptImage } from './image.ts'
import { withVerifiedSessionBackend, type SessionArchive } from './sessions.ts'
import { controlConfigurationChecks, verifyControlConfigurations, type ControlConfigurationCheck, type ControlConfigurationVerification } from './control.ts'
import { inferenceConfigurationCheck, type RecoveryInferenceHost } from './inference.ts'
import { reconcileConsumedInputs, type InputStateReconciliation } from './inputs.ts'
import { sourceConfigurationCheck, type RecoverySourceHost } from './sources.ts'
import { reconcileStateGraph, type StateGraphReconciliation } from './graph.ts'
import { verifyConnectorState, type ConnectorStateVerification } from './connectors.ts'
import { verifyWorkspaceState, type WorkspaceStateVerification } from './workspace.ts'
import { verifyResultState, type ResultStateVerification } from './results.ts'

export interface PrepareCheckpointReceipts extends AuditCheckpointReceipts { requestId: string; auditId: string; persistence: SessionPersistence; inference: RecoveryInferenceHost; sources: RecoverySourceHost }
export interface ReceiptPreparation {
  requestId: string; auditId: string; requestHash: string; phase: 'requested' | 'prepared'; audit: ReceiptAudit; image?: ReceiptImage
}
const observation = z.object({ id: z.string(), grantId: z.string(), epoch: z.number().int().positive(), fingerprint: z.string(),
  phase: z.enum(['accepted', 'started', 'settled', 'unknown']), owner: EffectOwner, ownership: OwnershipStamp, quiescent: z.literal(true),
  failed: z.boolean(), outcome: z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict().optional(),
  reconciledAt: z.string().datetime().optional() }).strict()
function* rows<T>(db: DatabaseSync, table: string): Generator<T> {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    for (const row of db.prepare(`SELECT value FROM ${table}`).iterate()) yield JSON.parse(String(row.value)) as T
}
const get = <T>(db: DatabaseSync, key: string): T | undefined => {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : undefined
}
const exists = async (path: string) => { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }

/** Apply only original receipt observations to a separately authenticated image; the source and new image remain held. */
export async function prepareCheckpointReceipts(options: PrepareCheckpointReceipts): Promise<{ path: string; manifest: ReceiptImage }> {
  z.string().uuid().parse(options.requestId); z.string().uuid().parse(options.auditId)
  const bounded = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
  return withVerifiedStagedCheckpoint(options.checkpoint, options.keyFile, options.destination, bounded, async ({ root, archive, manifest, db, signal }) => {
    const requestHash = fingerprint({ requestId: options.requestId, auditId: options.auditId, digest: fingerprint(manifest),
      authority: options.authority, endpoints: options.endpoints.map(({ url, endpointId, credentialFile }) => ({ url, endpointId, credentialFile })).sort((a, b) => a.endpointId.localeCompare(b.endpointId)),
      publication: options.publication, ...(options.worlds?.length ? { worlds: [...options.worlds].sort((a, b) => a.binding.localeCompare(b.binding)) } : {}),
      ...(options.publicationClient ? { publicationClient: options.publicationClient } : {}) }), target = join(root, 'prepared-' + options.requestId)
    let intent = get<ReceiptPreparation>(db, KV.recovery.preparation)
    const save = () => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KV.recovery.preparation, JSON.stringify(intent))
    if (intent && (intent.requestId !== options.requestId || intent.auditId !== options.auditId || intent.requestHash !== requestHash))
      throw new Error('Prepared recovery request differs; retry the original request or stage a separate restore')
    if (!intent) {
      const audit = get<ReceiptAudit>(db, KV.recovery.audit)
      if (!audit || audit.id !== options.auditId || audit.phase !== 'complete' || !audit.complete || audit.status !== 'matched' || audit.issueCount !== 0
        || audit.checkpoint !== manifest.id || audit.digest !== fingerprint(manifest) || !audit.resources.every(resource => resource.quiescent))
        throw new Error('Preparing receipts requires the selected complete matched audit')
      if (await exists(target)) throw new Error('Prepared recovery refuses an existing destination')
      intent = { requestId: options.requestId, auditId: options.auditId, requestHash, phase: 'requested', audit }; save()
    }
    if (await exists(join(target, 'prepared.json'))) {
      const image = await verifyReceiptImage(target, options.keyFile, signal)
      if (image.requestId !== intent.requestId || image.requestHash !== intent.requestHash || image.auditId !== intent.auditId
        || image.checkpoint !== manifest.id || image.digest !== fingerprint(manifest) || intent.image && fingerprint(image) !== fingerprint(intent.image))
        throw new Error('Prepared recovery image differs from its original request')
      intent.phase = 'prepared'; intent.image = image; save(); return { path: target, manifest: image }
    }
    if (intent.phase === 'prepared') throw new Error('The original prepared recovery image is missing; it cannot be recreated as a new result')
    // An interrupted mkdir/rename has an empty private reservation. Never replace a nonempty or linked target.
    if (await exists(target)) {
      const stat = await lstat(target)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || (await readdir(target)).length)
        throw new Error('Unfinished prepared recovery destination is not an empty private reservation')
      await rmdir(target)
    }
    const audit = intent.audit, reservation = get<RecoveryIntent>(db, KV.recovery.reservation), binding = get<{ authorityId: string; coordinatorId: string }>(db, KV.runtime.ownership)
    if (!reservation?.recovery || reservation.phase !== 'reserved' || reservation.credentialFile !== join(root, 'recovery-claimant.token')
      || fingerprint(reservation.recovery) !== fingerprint(audit.recovery) || reservation.request.epoch !== audit.epoch
      || binding?.authorityId !== options.authority.authorityId || binding.coordinatorId !== options.authority.coordinatorId)
      throw new Error('Prepared recovery requires its original held reservation and authority')
    const pin = (file: string) => {
      const canonical = realpathSync(file)
      if (manifest.executionWorkspaces.some(workspace => { let path = resolve(workspace); try { path = realpathSync(path) } catch { /* Future workspace. */ } return inside(path, canonical) }))
        throw new Error('Recovery administrator credentials must stay outside execution workspaces')
      const digest = credentialDigest(privateCredential(file)); return () => privateCredential(file, digest)
    }
    const authority = new OwnershipClient(options.authority, pin(options.authority.credentialFile))
    const administrators = new Map<string, (request: z.infer<typeof AdministrationRead> | z.infer<typeof RevocationRead>) => Promise<unknown>>()
    const clients = new Map<string, (request: InventoryRequest | ReceiptRequest) => Promise<unknown>>()
    for (const config of options.endpoints) {
      if (clients.has(config.endpointId) || clients.size >= 256) throw new Error('Supply unique bounded recovery resources')
      const client = new RemoteClient(config, undefined, undefined, pin(config.credentialFile)); clients.set(config.endpointId, request => client.call(request, signal)); administrators.set(config.endpointId, request => client.call(request, signal))
    }
    if (options.publication) {
      if (clients.has(options.publication.serviceId)) throw new Error('Duplicate recovery resource')
      pin(options.publication.credentialFile)(); const client = new PublicationClient(options.publication)
      clients.set(options.publication.serviceId, request => client.call(request, signal))
    }
    const inspect = async () => {
      const view = OwnershipView.parse(await authority.call({ op: 'coordinator.inspect', id: options.authority.coordinatorId }, signal))
      if (view.phase !== 'vacant' || view.epoch !== audit.epoch || fingerprint(view.recovery) !== fingerprint(audit.recovery)
        || fingerprint([...view.resources].sort()) !== fingerprint(audit.resources.map(resource => resource.identity.resourceId).sort()))
        throw new Error('Recovery ownership or enrolled resources changed; execution remains held')
    }
    const validate = async () => {
      await inspect()
      if (clients.size !== audit.resources.length || new Set(audit.resources.map(resource => resource.identity.id)).size !== clients.size)
        throw new Error('Prepared recovery requires the complete audited resource set')
      for (const resource of audit.resources) {
        const call = clients.get(resource.identity.id)
        if (!call || resource.identity.authorityId !== options.authority.authorityId || resource.identity.coordinatorId !== options.authority.coordinatorId)
          throw new Error('Prepared recovery resource identity differs')
        const page = InventoryPage.parse(await call({ op: 'recovery.inventory', revision: resource.revision, offset: resource.total }))
        if (page.revision !== resource.revision || page.total !== resource.total || page.offset !== resource.total || page.items.length || page.nextOffset !== null
          || !page.quiescent || fingerprint(page.identity) !== fingerprint(resource.identity)) throw new Error('Prepared recovery inventory changed')
      }
      await inspect(); signal.throwIfAborted()
    }
    const receipt = async (resourceId: string, kind: ReceiptRequest['kind'], id: string, requestHash: string) => {
      const resource = audit.resources.find(resource => resource.identity.id === resourceId), call = clients.get(resourceId)
      if (!resource || !call) throw new Error('Original receipt lacks its audited resource')
      const value = InventoryReceipt.parse(await call({ op: 'recovery.receipt', revision: resource.revision, kind, id }))
      if (value.revision !== resource.revision || fingerprint(value.identity) !== fingerprint(resource.identity) || !value.quiescent
        || value.item.kind !== kind || value.item.id !== id || value.item.requestHash !== requestHash || !value.item.settled
        || !value.item.ownership || value.item.ownership.coordinatorId !== options.authority.coordinatorId || value.item.ownership.epoch > audit.epoch)
        throw new Error('Prepared recovery receipt does not match its audited original intent')
      return value
    }
    await validate()
    return withVerifiedSessionBackend(options.persistence, archive, manifest.sessions as unknown as SessionArchive[], signal, async (sessionBackend, recheckSessions) => {
      const sourceCheck = sourceConfigurationCheck(options.sources, db, signal), sourceConfiguration = sourceCheck.verify()
      const inferenceCheck = await inferenceConfigurationCheck(options.inference, db, archive, manifest.sessions as unknown as SessionArchive[], manifest.masterId, signal)
      let inferenceConfiguration: Awaited<ReturnType<typeof inferenceCheck.verify>>, consumedInputs: InputStateReconciliation,
        stateGraph: StateGraphReconciliation, connectorState: ConnectorStateVerification, workspaceState: WorkspaceStateVerification, resultState: ResultStateVerification
      const administration = { verified: 0, recovered: 0, superseded: 0 }
      const revocations = { verified: 0, recovered: 0 }
      const worlds: WorldRecord[] = []
      let configurationChecks: WorldConfigurationCheck[] = []
      let controlChecks: ControlConfigurationCheck[] = [], controlConfiguration: ControlConfigurationVerification
      const staging = await mkdtemp(join(root, '.prepare-')), applied = { commands: 0, mutations: 0, publications: 0 }
      try {
        const storePath = join(staging, 'orchestrator.sqlite'); await backup(db, storePath); await chmod(storePath, 0o600)
        for (const file of manifest.files.filter(file => file.kind !== 'store')) { signal.throwIfAborted(); await copyFile(join(archive, file.member), join(staging, file.member)) }
        for (const file of manifest.files.filter(file => file.kind === 'world')) {
          const world = new DatabaseSync(join(staging, file.member)); world.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL')
          try {
            const record = JSON.parse(String(world.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value)) as WorldRecord
            worlds.push(record)
            if (record.revocation) {
              const resource = audit.resources.find(resource => resource.identity.id === record.endpointId), call = administrators.get(record.endpointId)
              if (!resource || !call) throw new Error('Original revocation lacks its audited resource')
              const observed = RevocationObservation.parse(await call({ op: 'recovery.revocation', revision: resource.revision, ...revocationRequest(record) }))
              if (observed.revision !== resource.revision || fingerprint(observed.identity) !== fingerprint(resource.identity)) throw new Error('Prepared revocation resource identity differs')
              const result = observeRevocation(record, observed)
              const updated = world.prepare('UPDATE execution_world SET value=? WHERE id=1').run(JSON.stringify(result))
              if (Number(updated.changes) !== 1) throw new Error('Prepared world revocation row is missing')
              revocations.verified++; if (record.phase !== 'revoked' || !record.revocation.receipt?.quiescent) revocations.recovered++
            } else if (record.phase !== 'active') throw new Error('Prepared revoked world lacks its original intent')
            const originals = [...rows<ExecutionReceipt>(world, 'execution_effect')], effects = new ExecutionEffects(world)
            for (const original of originals) {
              signal.throwIfAborted(); if (original.phase === 'refused' && original.quiescent === true) continue
              const remote = await receipt(record.endpointId, original.kind, original.id, original.fingerprint), value = observation.parse(remote.observation)
              if (value.id !== original.id || value.grantId !== original.grantId || value.epoch !== original.epoch || value.fingerprint !== original.fingerprint
                || fingerprint(value.owner) !== fingerprint(original.owner) || value.phase !== remote.item.phase || value.grantId !== remote.item.grantId
                || value.epoch !== remote.item.epoch || !sameOwner(value.ownership, remote.item.ownership!)
                || original.ownership && !sameOwner(value.ownership, original.ownership)
                || original.quiescent && original.phase !== 'unknown' && original.phase !== value.phase
                || original.kind === 'command' && (fingerprint(value.outcome ?? null) !== remote.item.resultHash || original.outcome && fingerprint(original.outcome) !== fingerprint(value.outcome))
                || original.kind === 'mutation' && (value.outcome !== undefined || value.phase !== 'settled' && !value.reconciledAt))
                throw new Error('Prepared endpoint observation differs from the original effect')
              const reconciled = value.reconciledAt ? { at: value.reconciledAt, note: 'Independent endpoint reconciliation verified during held recovery' } : undefined
              effects.observed({ op: original.kind === 'command' ? 'job.get' : 'operation.get', id: original.id }, { ...value, reconciled,
                ...(original.kind === 'command' ? { request: { owner: value.owner }, error: value.failed ? 'Independent endpoint recorded a command failure' : undefined }
                  : { error: value.failed ? { code: 'recovered_failure', message: 'Independent endpoint recorded a mutation failure' } : undefined }) })
              applied[original.kind === 'command' ? 'commands' : 'mutations']++
            }
            effects.close()
          } finally { world.close() }
        }
        const store = new Store(storePath)
        try {
          consumedInputs = await reconcileConsumedInputs(store.db, archive, manifest.sessions as unknown as SessionArchive[], signal)
          inferenceConfiguration = await inferenceCheck.verify()
          configurationChecks = worldConfigurations(options.worlds ?? [], store.db, worlds)
          controlChecks = controlConfigurationChecks(options, store.db, reservation, audit, [...manifest.executionWorkspaces, ...worlds.map(world => world.grant.root)], signal)
          controlConfiguration = await verifyControlConfigurations(controlChecks)
          for (const check of configurationChecks) await verifyWorldConfiguration(check,
            audit.resources.find(resource => resource.identity.id === check.original.endpointId), manifest.executionWorkspaces, signal)
          for (const original of rows<SavedAdministration>(store.db, 'operator_endpoint_command')) {
            const resource = audit.resources.find(resource => resource.identity.id === original.endpointId), call = administrators.get(original.endpointId)
            if (!resource || !call) throw new Error('Original administrative intent lacks its audited resource')
            const observed = AdministrationObservation.parse(await call({ op: 'recovery.administration', revision: resource.revision, ...administrationRequest(original) }))
            if (observed.revision !== resource.revision || fingerprint(observed.identity) !== fingerprint(resource.identity)) throw new Error('Prepared administrative resource identity differs')
            const result = observeAdministration(original, observed)
            if (result) {
              const updated = store.db.prepare('UPDATE operator_endpoint_command SET value=? WHERE id=?').run(JSON.stringify(result), `${original.endpointId}:${original.id}`)
              if (Number(updated.changes) !== 1) throw new Error('Original administrative row identity differs from its receipt')
              administration.verified++; if (result.phase === 'recovered') administration.recovered++; if (result.phase === 'superseded') administration.superseded++
            }
          }
          type Saved = { id: string; intent?: Publication; publication?: Publication; attempts: OwnershipStamp[]; receipt?: PublicationReceipt;
            phase: string; problem?: string; updatedAt?: string; original?: OutboundMessage; messageId?: string }
          for (const table of ['workspace_publication', 'channel_publication']) for (const original of rows<Saved>(store.db, table)) {
            const publication = Publication.parse(original.intent ?? original.publication)
            const remote = await receipt(options.publication!.serviceId, 'publication', original.id, fingerprint(publication)), value = PublicationReceipt.parse(remote.observation)
            if (value.id !== original.id || publication.id !== original.id || value.destination !== publication.destination || value.destinationHash !== publication.destinationHash
              || value.hash !== publication.hash || value.bytes !== Buffer.byteLength(publication.text) || fingerprint(value.artifact ?? value.message) !== fingerprint(publication.artifact ?? publication.message)
              || !original.attempts.some(owner => sameOwner(owner, value.ownership)) || !sameOwner(value.ownership, remote.item.ownership!) || value.phase !== remote.item.phase
              || ['accepted', 'started', 'unknown'].includes(value.phase) || fingerprint(value.external ? ExternalReceipt.parse(value.external) : null) !== remote.item.resultHash
              || original.receipt && !['accepted', 'started', 'unknown'].includes(original.receipt.phase) && original.receipt.phase !== value.phase
              || original.receipt?.external && fingerprint(ExternalReceipt.parse(original.receipt.external)) !== fingerprint(value.external))
              throw new Error('Prepared publication observation differs from the original intent')
            original.receipt = value; original.phase = 'observed'; original.updatedAt = new Date().toISOString(); delete original.problem
            store.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(original), original.id)
            if (table === 'channel_publication') {
              if (!original.original || original.original.id !== publication.message?.id || original.messageId !== original.original.id)
                throw new Error('Channel publication lacks its original Outbox identity')
              store.receipts.settle(original.original, value.phase === 'sent' ? 'sent' : 'channelGone')
            }
            applied.publications++
          }
          stateGraph = await reconcileStateGraph(store.db, signal)
          connectorState = await verifyConnectorState(store.db, signal)
          workspaceState = await verifyWorkspaceState(store.db, signal)
          resultState = await verifyResultState(store.db, signal)
          store.set(KV.recovery.hold, { checkpoint: manifest.id, at: new Date().toISOString(), state: 'prepared', requestId: intent.requestId })
          store.db.prepare('DELETE FROM kv WHERE key=?').run(KV.recovery.preparation)
          store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE')
        } finally { store.close() }
        const files: ReceiptImage['files'] = []
        for (const file of manifest.files) {
          const member = file.kind === 'store' ? 'orchestrator.sqlite' : file.member
          files.push({ member, kind: file.kind, ...await recoveryFileDigest(join(staging, member), signal), ...(file.binding ? { binding: file.binding } : {}) })
          await syncRecoveryPath(join(staging, member))
        }
        const image = ReceiptImage.parse({ version: 1, requestId: intent.requestId, requestHash, checkpoint: manifest.id, digest: fingerprint(manifest),
          auditId: audit.id, at: new Date().toISOString(), recovery: audit.recovery, epoch: audit.epoch, resources: audit.resources, applied, files, executionOwnership: false, administration, revocations,
          executionConfiguration: { worlds: configurationChecks.length, bindings: configurationChecks.reduce((total, check) => total + (check.original.grant.credentials?.length ?? 0), 0) }, sessionBackend, controlConfiguration, inferenceConfiguration, consumedInputs, sourceConfiguration, stateGraph, connectorState, workspaceState, resultState })
        const key = recoveryKey(options.keyFile)
        try { await writeFile(join(staging, 'prepared.json'), sealReceiptImage(image, key), { flag: 'wx', mode: 0o600 }) } finally { key.fill(0) }
        await syncRecoveryPath(join(staging, 'prepared.json')); await syncRecoveryPath(staging)
        for (const check of configurationChecks) await verifyWorldConfiguration(check,
          audit.resources.find(resource => resource.identity.id === check.original.endpointId), manifest.executionWorkspaces, signal)
        await verifyControlConfigurations(controlChecks)
        sourceCheck.verify()
        await inferenceCheck.verify()
        await validate()
        await recheckSessions()
        sourceCheck.verify()
        await mkdir(target, { mode: 0o700 }); await rename(staging, target); await syncRecoveryPath(root)
        intent.phase = 'prepared'; intent.image = image; save()
        return { path: target, manifest: image }
      } finally { await rm(staging, { recursive: true, force: true }) }
    })
  })
}
