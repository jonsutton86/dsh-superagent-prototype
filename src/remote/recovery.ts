/** Read original administrative receipts without dispatching, issuing a credential or adopting a current generation. */
import { z } from 'zod'
import { CredentialMetadata, GrantMetadata } from '../environments/endpoint-model.ts'
import { InventoryPage } from '../ownership/inventory.ts'
import { AdministrationRead, RemoteError } from './protocol.ts'
import type { RemoteJournal } from './journal.ts'

const reconciled = z.object({ at: z.string(), note: z.string().max(2000) }).strict()
export const RecoveryJob = z.object({ id: z.string(), grantId: z.string(), epoch: z.number().int().positive(),
  phase: z.enum(['accepted', 'started', 'settled', 'unknown']), createdAt: z.string(), updatedAt: z.string(),
  cancelRequested: z.boolean(), quiescent: z.boolean().nullable(), reconciled: reconciled.optional() })
export const RecoveryOperation = z.object({ id: z.string(), grantId: z.string(), epoch: z.number().int().positive(), kind: z.string(),
  phase: z.enum(['started', 'settled', 'unknown']), at: z.string(), reconciled: reconciled.optional() })
export const AdministrationObservation = z.object({ revision: InventoryPage.shape.revision, identity: InventoryPage.shape.identity,
  quiescent: z.boolean(), id: z.string(), action: AdministrationRead.shape.action, requestHash: AdministrationRead.shape.requestHash,
  found: z.boolean(), result: z.union([z.string(), CredentialMetadata]).optional(),
  current: z.union([GrantMetadata, CredentialMetadata, RecoveryJob, RecoveryOperation]).optional() }).strict()
export type AdministrationObservation = z.infer<typeof AdministrationObservation>

export function readAdministration(journal: RemoteJournal, request: z.infer<typeof AdministrationRead>,
  identity: AdministrationObservation['identity'], quiescent: boolean): AdministrationObservation {
  const result = journal.receipt<unknown>(request.id, request.requestHash)
  const base = { revision: request.revision, identity, quiescent, id: request.id, action: request.action, requestHash: request.requestHash }
  if (result === undefined) return { ...base, found: false }
  let current: AdministrationObservation['current'], saved: AdministrationObservation['result']
  if (request.action === 'credential.import' || request.action === 'credential.revoke') {
    saved = CredentialMetadata.parse(result)
    const row = journal.db.prepare('SELECT value FROM remote_credential WHERE id=?').get(saved.id)
    if (row) current = CredentialMetadata.parse(JSON.parse(String(row.value)))
  } else {
    saved = z.string().min(1).max(100).parse(result)
    if (request.action === 'grant.create' || request.action === 'grant.change') current = GrantMetadata.parse(journal.grant(saved))
    else if (request.action === 'operation.reconcile') {
      const operation = journal.operation(saved); if (operation) current = RecoveryOperation.parse(operation)
    } else current = RecoveryJob.parse(journal.job(saved))
  }
  if (!current) throw new RemoteError(409, 'receipt_mismatch', 'Original administrative receipt has no current resource record')
  return AdministrationObservation.parse({ ...base, found: true, result: saved, current })
}
