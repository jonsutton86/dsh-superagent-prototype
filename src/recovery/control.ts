/** Read-only proof of recovery claimant and coordinator publication configuration, without acquiring execution authority. */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { KV } from '../kv.ts'
import { credentialDigest, privateCredential } from '../environments/endpoint-files.ts'
import { OwnershipClient } from '../ownership/client.ts'
import { OwnershipError, OwnershipView } from '../ownership/protocol.ts'
import { PublicationClient } from '../publication/client.ts'
import { DestinationView, PublicationConfigurationObservation, PublicationError } from '../publication/protocol.ts'
import { fingerprint, inside } from '../remote/journal.ts'
import type { AuditCheckpointReceipts, ReceiptAudit } from './audit.ts'
import { ConfigurationMismatch } from './configuration.ts'
import type { RecoveryIntent } from './ownership.ts'

export interface ControlConfigurationCheck { kind: 'claimant' | 'publication'; resource: string; verify(): Promise<number> }
export interface ControlConfigurationVerification { claimant: true; publication: boolean; destinations: number }

export function controlConfigurationChecks(options: Pick<AuditCheckpointReceipts, 'authority' | 'publication' | 'publicationClient'>,
  db: DatabaseSync, reservation: RecoveryIntent, audit: Pick<ReceiptAudit, 'epoch' | 'recovery' | 'resources'>,
  workspaces: readonly string[], signal: AbortSignal): ControlConfigurationCheck[] {
  const pin = (file: string | undefined) => {
    let digest: string | undefined
    return () => {
      if (!file) throw new ConfigurationMismatch('configuration_missing')
      try {
        const path = realpathSync(file)
        if (workspaces.some(root => {
          let canonical = resolve(root); try { canonical = realpathSync(root) } catch { /* Also exclude future workspace roots. */ }
          return inside(canonical, path)
        })) throw new Error('Control credential is inside an execution workspace')
        const value = privateCredential(file, digest); digest ??= credentialDigest(value); return value
      } catch { throw new ConfigurationMismatch('configuration_unavailable') }
    }
  }
  const credential = pin(reservation.credentialFile)
  const claimant = new OwnershipClient({ ...options.authority, credentialFile: reservation.credentialFile }, credential)
  const checks: ControlConfigurationCheck[] = [{ kind: 'claimant', resource: options.authority.authorityId, verify: async () => {
    try {
      const view = OwnershipView.parse(await claimant.call({ op: 'recovery.claimant' }, signal))
      if (view.coordinatorId !== options.authority.coordinatorId || view.phase !== 'vacant' || view.epoch !== audit.epoch
        || fingerprint(view.recovery) !== fingerprint(audit.recovery)
        || fingerprint([...view.resources].sort()) !== fingerprint(audit.resources.map(resource => resource.identity.resourceId).sort()))
        throw new ConfigurationMismatch('configuration_mismatch')
      credential(); return 0
    } catch (error) {
      if (error instanceof OwnershipError && [401, 403].includes(error.status)) throw new ConfigurationMismatch('configuration_unavailable')
      throw error
    }
  } }]
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(KV.runtime.publication)
  const original = row ? JSON.parse(String(row.value)) as { serviceId: string; credentialFile?: string } : undefined
  if (!original && !options.publicationClient) return checks
  const connection = options.publicationClient ?? (options.publication && original?.credentialFile
    ? { ...options.publication, credentialFile: original.credentialFile } : undefined)
  const publisherCredential = pin(connection?.credentialFile)
  let publisher: PublicationClient | undefined
  checks.push({ kind: 'publication', resource: original?.serviceId ?? options.publicationClient!.serviceId, verify: async () => {
    if (!connection) throw new ConfigurationMismatch('configuration_missing')
    const resource = audit.resources.find(resource => resource.identity.id === connection.serviceId)
    if (!original || connection.serviceId !== original.serviceId || !resource || resource.identity.kind !== 'publication')
      throw new ConfigurationMismatch('configuration_mismatch')
    try {
      publisherCredential(); publisher ??= new PublicationClient(connection)
      const destinations = z.array(DestinationView).min(1).max(100).parse(await publisher.call({ op: 'destinations' }, signal))
      if (new Set(destinations.map(destination => destination.id)).size !== destinations.length) throw new Error('Publication destination catalog repeats an identity')
      for (const { hash, ...destination } of destinations) {
        if (fingerprint(destination) !== hash) throw new ConfigurationMismatch('configuration_mismatch')
        const observed = PublicationConfigurationObservation.parse(await publisher.call({ op: 'recovery.destination',
          revision: resource.revision, destination: destination.id, destinationHash: hash }, signal))
        if (observed.revision !== resource.revision || fingerprint(observed.identity) !== fingerprint(resource.identity)
          || observed.destination !== destination.id || observed.destinationHash !== hash) throw new ConfigurationMismatch('configuration_mismatch')
      }
      publisherCredential(); signal.throwIfAborted(); return destinations.length
    } catch (error) {
      if (error instanceof PublicationError && ([401, 403].includes(error.status) || ['configuration_unavailable', 'recovery_busy'].includes(error.code)))
        throw new ConfigurationMismatch('configuration_unavailable')
      if (error instanceof PublicationError && ['destination_changed', 'destination_missing'].includes(error.code)) throw new ConfigurationMismatch('configuration_mismatch')
      throw error
    }
  } })
  return checks
}

export async function verifyControlConfigurations(checks: readonly ControlConfigurationCheck[]): Promise<ControlConfigurationVerification> {
  let claimant = false, publication = false, destinations = 0
  for (const check of checks) {
    const count = await check.verify()
    if (check.kind === 'claimant') claimant = true
    else { publication = true; destinations += count }
  }
  if (!claimant) throw new ConfigurationMismatch('configuration_missing')
  return { claimant, publication, destinations }
}
