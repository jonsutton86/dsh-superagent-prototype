/** Workspace contracts: one durable intent, private transfer, and explicit approval history. Browser-safe. */
import { z } from 'zod'
import { OwnershipStamp } from '../ownership/protocol.ts'
import { EvidenceSeal } from '../verification/review-model.ts'
import { RepositoryDestinationView, RepositoryPublication, RepositoryTransfer, RepositoryTransferReceipt, RepositoryReceipt } from './repository-model.ts'

const id = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/), at = z.string().datetime()
export const PrepareRepositoryPublication = RepositoryPublication.pick({ destination: true, destinationHash: true, title: true, body: true, draft: true })
  .extend({ requestId: id }).strict()
export type PrepareRepositoryPublication = z.infer<typeof PrepareRepositoryPublication>
export const ApproveRepositoryPublication = z.object({ requestId: id }).strict()
export type ApproveRepositoryPublication = z.infer<typeof ApproveRepositoryPublication>
export const WorkspaceRepositoryPublication = z.object({
  id, serviceId: z.string().min(1), exportId: id, exportFingerprint: digest, fingerprint: digest,
  request: PrepareRepositoryPublication, destination: RepositoryDestinationView,
  transfer: RepositoryTransfer, publication: RepositoryPublication,
  owners: z.array(OwnershipStamp).min(1).max(100),
  approvals: z.array(z.object({ id, at, owner: OwnershipStamp, dispatched: z.boolean(),
    evidence: z.array(EvidenceSeal).min(1).max(32).optional() }).strict()).max(40),
  phase: z.enum(['preparing', 'ready', 'held', 'unknown', 'published', 'cancelled', 'reconciled']),
  cancelRequested: z.boolean(), createdAt: at, updatedAt: at, problem: z.string().max(1000).optional(),
  transferReceipt: RepositoryTransferReceipt.optional(), receipt: RepositoryReceipt.optional(),
}).strict()
export type WorkspaceRepositoryPublication = z.infer<typeof WorkspaceRepositoryPublication>
export type RepositoryPublicationView = Pick<WorkspaceRepositoryPublication,
  'id' | 'exportId' | 'destination' | 'phase' | 'cancelRequested' | 'createdAt' | 'updatedAt' | 'problem' | 'receipt'> & {
    publication: RepositoryPublication; transfer: RepositoryTransfer; received: number;
    approvals: { id: string; at: string; dispatched: boolean }[]
  }
