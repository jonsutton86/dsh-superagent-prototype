import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KV } from '../kv.ts'
import { credentialDigest, privateCredential } from '../environments/endpoint-files.ts'
import { OwnershipClient, type OwnershipConnection } from '../ownership/client.ts'
import { OwnershipView, type RecoveryReservation, type OwnershipStamp } from '../ownership/protocol.ts'
import { InventoryPage, type InventoryItem, type InventoryRequest } from '../ownership/inventory.ts'
import { sameOwner } from '../ownership/gate.ts'
import { RemoteClient, type RemoteConnection } from '../remote/client.ts'
import { fingerprint, inside } from '../remote/journal.ts'
import { worldBinding, type WorldRecord } from '../remote/world-journal.ts'
import type { ExecutionReceipt } from '../remote/effects.ts'
import { PublicationClient, type PublicationConnection } from '../publication/client.ts'
import { ExternalReceipt, Publication, type PublicationReceipt } from '../publication/protocol.ts'
import { AdministrationMismatch, administrationRequest, observeAdministration, type SavedAdministration } from './administration.ts'
import { AdministrationObservation } from '../remote/recovery.ts'
import { RemoteError, type AdministrationRead } from '../remote/protocol.ts'
import type { z } from 'zod'
import { withVerifiedStagedCheckpoint } from './checkpoint.ts'

export interface AuditCheckpointReceipts {
  checkpoint: string; keyFile: string; destination: string; authority: OwnershipConnection & { coordinatorId: string };
  endpoints: Omit<RemoteConnection, 'lifetime' | 'ownership'>[]; publication?: PublicationConnection; signal?: AbortSignal
}
export interface ReceiptAudit {
  id: string; checkpoint: string; digest: string; at: string; phase: 'running' | 'complete' | 'failed'; status: 'matched' | 'blocked';
  recovery: RecoveryReservation; epoch: number; complete: boolean; executionOwnership: false;
  resources: { identity: InventoryPage['identity']; revision: string; total: number; quiescent: boolean }[];
  matched: number; observed: number; issueCount: number; issues: { code: string; resource?: string; kind?: string; id?: string }[]; problem?: string
}
interface Expected {
  kind: InventoryItem['kind']; id: string; requestHash: string; grantId?: string; epoch?: number; ownership?: OwnershipStamp;
  attempts?: OwnershipStamp[]; phase?: string; resultHash?: string; absent?: boolean; revoked?: boolean
}
function* rows<T>(db: DatabaseSync, table: string): Generator<T> {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    for (const row of db.prepare(`SELECT value FROM ${table}`).iterate()) yield JSON.parse(String(row.value)) as T
}
const key = (item: { kind: string; id: string }) => item.kind + ':' + item.id

/** Compare every enrolled resource against authenticated original intents; persist observations without replay, history repair or activation. */
export async function auditCheckpointReceipts(options: AuditCheckpointReceipts): Promise<ReceiptAudit> {
  const bounded = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(120_000)])
  return withVerifiedStagedCheckpoint(options.checkpoint, options.keyFile, options.destination, bounded,
    async ({ root, archive, manifest, db, signal }) => {
      const get = <T>(key: string): T | undefined => { const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) : undefined }
      const reservation = get<import('./ownership.ts').RecoveryIntent>(KV.recovery.reservation), binding = get<{ authorityId: string; coordinatorId: string }>(KV.runtime.ownership)
      if (!reservation?.recovery || reservation.phase !== 'reserved' || reservation.credentialFile !== join(root, 'recovery-claimant.token')
        || reservation.recovery.checkpoint !== manifest.id || reservation.recovery.digest !== fingerprint(manifest)
        || binding?.authorityId !== options.authority.authorityId || binding.coordinatorId !== options.authority.coordinatorId)
        throw new Error('Receipt audit requires the original authority and matching held recovery reservation')
      const report: ReceiptAudit = { id: randomUUID(), checkpoint: manifest.id, digest: fingerprint(manifest), at: new Date().toISOString(),
        phase: 'running', status: 'blocked', recovery: reservation.recovery, epoch: reservation.request.epoch, complete: false,
        executionOwnership: false, resources: [], matched: 0, observed: 0, issueCount: 0, issues: [] }
      const save = () => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KV.recovery.audit, JSON.stringify(report))
      const issue = (code: string, resource?: string, item?: { kind: string; id: string }) => {
        report.issueCount++; if (report.issues.length < 1000) report.issues.push({ code, ...(resource ? { resource } : {}), ...item ? { kind: item.kind, id: item.id } : {} })
      }
      save()
      try {
        if (options.endpoints.length > 256 || new Set(options.endpoints.map(value => value.endpointId)).size !== options.endpoints.length)
          throw new Error('Supply unique endpoint identities within the authority resource bound')
        const pin = (file: string) => {
          const canonical = realpathSync(file)
          if (manifest.executionWorkspaces.some(workspace => {
            let path = resolve(workspace); try { path = realpathSync(path) } catch { /* Check future roots too. */ }
            return inside(path, canonical)
          })) throw new Error('Recovery administrator credentials must stay outside execution workspaces')
          const digest = credentialDigest(privateCredential(file)); return () => privateCredential(file, digest)
        }
        const authority = new OwnershipClient(options.authority, pin(options.authority.credentialFile))
        const inspect = async () => {
          const view = OwnershipView.parse(await authority.call({ op: 'coordinator.inspect', id: options.authority.coordinatorId }, signal))
          if (view.phase !== 'vacant' || view.epoch !== report.epoch || fingerprint(view.recovery) !== fingerprint(report.recovery))
            throw new Error('Ownership changed after checkpoint reservation; the restore remains held')
          return view
        }
        const initial = await inspect(), expected = new Map<string, Map<string, Expected>>(), worldEndpoints = new Set<string>(); let expectedCount = 0
        const add = (resource: string, item: Expected) => {
          let items = expected.get(resource); if (!items) expected.set(resource, items = new Map())
          const previous = items.get(key(item))
          if (previous && fingerprint(previous) !== fingerprint(item)) throw new Error('Checkpoint contains conflicting original receipt identities')
          if (!previous && ++expectedCount > 100_000) throw new Error('Checkpoint receipt inventory exceeds the audit bound')
          items.set(key(item), item)
        }
        for (const file of manifest.files.filter(file => file.kind === 'world')) {
          signal.throwIfAborted()
          const world = new DatabaseSync(join(archive, file.member), { readOnly: true })
          try {
            const record = JSON.parse(String(world.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value)) as WorldRecord
            worldEndpoints.add(record.endpointId)
            add(record.endpointId, { kind: 'grant', id: record.grant.id, requestHash: worldBinding(record.endpointId, record.grant), epoch: record.grant.epoch,
              revoked: record.phase === 'revoked' && record.revocation?.receipt?.quiescent === true })
            if (record.phase !== 'revoked') for (const credential of record.grant.credentials ?? []) add(record.endpointId, {
              kind: 'credential', id: credential.id, requestHash: fingerprint({ id: credential.id, version: credential.version, variable: credential.variable, mode: credential.mode }), phase: 'enabled' })
            for (const item of rows<ExecutionReceipt>(world, 'execution_effect')) add(record.endpointId, { kind: item.kind, id: item.id,
              requestHash: item.fingerprint, grantId: item.grantId, epoch: item.epoch, ownership: item.ownership,
              ...(item.quiescent && item.phase !== 'unknown' ? { phase: item.phase } : {}), absent: item.phase === 'refused' && item.quiescent === true,
              ...(item.kind === 'command' && item.outcome ? { resultHash: fingerprint(item.outcome) } : {}) })
          } finally { world.close() }
        }
        const publication = get<{ serviceId: string }>(KV.runtime.publication)
        if (publication?.serviceId !== options.publication?.serviceId) throw new Error('Receipt audit requires the original publication service configuration')
        type SavedPublication = { id: string; intent?: Publication; publication?: Publication; attempts: OwnershipStamp[]; receipt?: PublicationReceipt }
        for (const table of ['workspace_publication', 'channel_publication']) for (const item of rows<SavedPublication>(db, table)) {
          if (!publication) throw new Error('Publication intents lack their original service binding')
          const intent = Publication.parse(item.intent ?? item.publication)
          if (intent.id !== item.id) throw new Error('Checkpoint publication intent is invalid')
          add(publication.serviceId, { kind: 'publication', id: item.id, requestHash: fingerprint(intent), attempts: item.attempts,
            ...(item.receipt && !['accepted', 'started', 'unknown'].includes(item.receipt.phase) ? { phase: item.receipt.phase } : {}),
            ...(item.receipt?.external ? { resultHash: fingerprint(ExternalReceipt.parse(item.receipt.external)) } : {}) })
          add(publication.serviceId, { kind: 'destination', id: intent.destination, requestHash: intent.destinationHash })
        }
        const clients: { id: string; kind: 'endpoint' | 'publication'; call(request: InventoryRequest): Promise<unknown>; administration?(request: z.infer<typeof AdministrationRead>): Promise<unknown> }[] = options.endpoints.map(config => {
          const client = new RemoteClient(config, undefined, undefined, pin(config.credentialFile))
          return { id: config.endpointId, kind: 'endpoint', call: request => client.call(request, signal), administration: request => client.call(request, signal) }
        })
        if (options.publication) {
          pin(options.publication.credentialFile)()
          const client = new PublicationClient(options.publication)
          clients.push({ id: options.publication.serviceId, kind: 'publication', call: request => client.call(request, signal) })
        }
        const seenResources = new Set<string>(), seenServices = new Set<string>(); let count = 0
        for (const client of clients) {
          let offset = 0, first: InventoryPage | undefined
          const seen = new Set<string>(), wanted = expected.get(client.id) ?? new Map<string, Expected>()
          for (;;) {
            signal.throwIfAborted()
            const page = InventoryPage.parse(await client.call({ op: 'recovery.inventory', offset, ...(first ? { revision: first.revision } : {}) }))
            if (page.identity.id !== client.id || page.identity.kind !== client.kind || page.identity.authorityId !== options.authority.authorityId
              || page.identity.coordinatorId !== options.authority.coordinatorId || !initial.resources.includes(page.identity.resourceId)
              || page.offset !== offset || first && (page.revision !== first.revision || page.total !== first.total || fingerprint(page.identity) !== fingerprint(first.identity))
              || page.items.length !== Math.min(50, page.total - offset) || page.nextOffset !== (offset + page.items.length < page.total ? offset + page.items.length : null))
              throw new Error('Recovery resource inventory identity, revision or pagination differs')
            if (!first) {
              if (seenResources.has(page.identity.resourceId) || seenServices.has(client.id)) throw new Error('Two services claim the same recovery resource')
              seenResources.add(page.identity.resourceId); seenServices.add(client.id); first = page
              report.resources.push({ identity: page.identity, revision: page.revision, total: page.total, quiescent: page.quiescent })
            }
            if (!page.quiescent) issue('resource_not_quiescent', client.id)
            for (const item of page.items) {
              if (++count > 100_000 || seen.has(key(item))) throw new Error('Recovery inventory exceeds its bound or repeats an item')
              seen.add(key(item)); const saved = wanted.get(key(item))
              if (!saved) { if (['command', 'mutation', 'publication'].includes(item.kind)) issue('unrecorded_effect', client.id, item); continue }
              const revoked = saved.revoked && item.kind === 'grant' && item.phase === 'disabled' && item.epoch === saved.epoch! + 1
              const different = !revoked && (item.requestHash !== saved.requestHash || saved.epoch !== undefined && item.epoch !== saved.epoch)
                || saved.grantId !== undefined && item.grantId !== saved.grantId || saved.phase !== undefined && item.phase !== saved.phase
                || saved.resultHash !== undefined && item.resultHash !== saved.resultHash
                || saved.ownership && (!item.ownership || !sameOwner(item.ownership, saved.ownership))
                || saved.attempts && (!item.ownership || !saved.attempts.some(owner => sameOwner(owner, item.ownership!)))
              const effect = ['command', 'mutation', 'publication'].includes(item.kind)
              if (different || effect && (!item.ownership || item.ownership.coordinatorId !== options.authority.coordinatorId || item.ownership.epoch > report.epoch))
                issue('receipt_mismatch', client.id, item)
              else if (!item.settled) issue('effect_unsettled', client.id, item)
              else { report.matched++; if (effect && saved.phase === undefined) report.observed++ }
            }
            if (page.nextOffset === null) break
            offset = page.nextOffset
          }
          for (const item of wanted.values()) if (!seen.has(key(item)) && !item.absent) issue('receipt_missing', client.id, item)
        }
        for (const resource of initial.resources) if (!seenResources.has(resource)) issue('resource_missing', resource)
        for (const endpoint of worldEndpoints) if (!seenServices.has(endpoint)) issue('endpoint_missing', endpoint)
        for (const command of rows<SavedAdministration>(db, 'operator_endpoint_command')) {
          if (++expectedCount > 100_000) throw new Error('Checkpoint receipt inventory exceeds the audit bound')
          const resource = report.resources.find(resource => resource.identity.id === command.endpointId)
          const client = clients.find(client => client.id === command.endpointId)
          if (!resource || !client?.administration) { issue('endpoint_missing', command.endpointId); continue }
          try {
            const observed = AdministrationObservation.parse(await client.administration({ op: 'recovery.administration', revision: resource.revision, ...administrationRequest(command) }))
            if (observed.revision !== resource.revision || fingerprint(observed.identity) !== fingerprint(resource.identity)) throw new Error('Administrative recovery resource identity or revision differs')
            const result = observeAdministration(command, observed)
            if (result) { report.matched++; if (command.phase === 'pending' || command.phase === 'unknown') report.observed++ }
          } catch (error) {
            if (error instanceof AdministrationMismatch) issue(error.code, command.endpointId, { kind: 'administration', id: command.id })
            else if (error instanceof RemoteError && ['request_conflict', 'not_found', 'receipt_mismatch'].includes(error.code))
              issue('administration_mismatch', command.endpointId, { kind: 'administration', id: command.id })
            else throw error
          }
        }
        // Revalidate every revision after all resources were collected, then recheck the independent ownership cut.
        for (const resource of report.resources) {
          const page = InventoryPage.parse(await clients.find(client => client.id === resource.identity.id)!.call({
            op: 'recovery.inventory', revision: resource.revision, offset: resource.total }))
          if (page.revision !== resource.revision || page.total !== resource.total || page.offset !== resource.total || page.items.length || page.nextOffset !== null
            || fingerprint(page.identity) !== fingerprint(resource.identity)) throw new Error('Recovery inventory changed during final verification')
          if (!page.quiescent) issue('resource_not_quiescent', resource.identity.id)
        }
        const final = await inspect()
        if (fingerprint(final.resources) !== fingerprint(initial.resources)) throw new Error('Enrolled resources changed during the audit')
        signal.throwIfAborted(); report.complete = seenResources.size === initial.resources.length && [...worldEndpoints].every(id => seenServices.has(id))
        report.phase = 'complete'; report.status = report.issueCount ? 'blocked' : 'matched'; save()
        return report
      } catch (error) {
        report.phase = 'failed'; report.status = 'blocked'; report.complete = false; report.problem = 'Receipt audit did not complete; rerun it after resolving the reported failure'; save()
        throw error
      }
    })
}
