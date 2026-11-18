/** Host-owned original stop identities and bounded operator views; no model cancellation authority. */
import { z } from 'zod'

const id = z.string().min(1).max(200), digest = z.string().regex(/^[a-f0-9]{64}$/), at = z.iso.datetime()
export const StopScope = z.enum(['all', 'jobs', 'descendants', 'legacy'])
export const StopState = z.enum(['prepared', 'observing', 'unknown', 'quiet', 'dormant'])
export const StopProof = z.enum(['registry', 'remote', 'operator', 'undispatched'])
export const StopExecution = z.object({ directory: z.string().max(4096), mode: z.enum(['local', 'repository']).optional(),
  environment: z.object({ environmentId: id, revision: z.number().int().positive(), epoch: z.number().int().positive(), world: id.optional() }).strict().optional() }).strict()
export const StopRecordSchema = z.object({ version: z.literal(1), id, ticketId: id, assignmentId: id, sessionId: id,
  revision: z.number().int().positive(), scope: StopScope, state: StopState, reason: z.string().max(300),
  execution: StopExecution.nullable(), world: id.nullable(), executionBindingHash: digest, scopeHash: digest,
  createdAt: at, instance: id.nullable(), legacy: z.boolean(), keepInbox: z.boolean(), ownTurn: z.boolean(),
  jobIds: z.array(id).max(256), sessions: z.array(id).max(128), dispatched: z.boolean(), coverageConsumed: z.boolean().default(false),
  proof: StopProof.nullable(), settledAt: at.nullable(), attestationId: id.nullable() }).strict().superRefine((record, ctx) => {
    if (record.sessionId !== 'worker-' + record.ticketId || !record.sessions.includes(record.sessionId)
      || new Set(record.sessions).size !== record.sessions.length || new Set(record.jobIds).size !== record.jobIds.length
      || (record.scope === 'legacy') !== record.legacy || record.state === 'dormant' && !record.legacy
      || (record.state === 'quiet') !== (record.proof !== null && record.settledAt !== null)
      || record.state !== 'quiet' && (record.proof !== null || record.settledAt !== null)
      || (record.proof === 'operator') !== (record.attestationId !== null)
      || record.proof === 'remote' && record.world === null || record.proof === 'operator' && record.world !== null
      || record.execution?.environment?.world && record.world !== record.execution.environment.world)
      ctx.addIssue({ code: 'custom', message: 'Inconsistent original stop evidence' })
  })
export type StopRecord = z.infer<typeof StopRecordSchema>
export interface StopHoldSummary {
  id: string; ticketId: string; assignmentId: string; sessionId: string; revision: number;
  scope: z.infer<typeof StopScope>; state: z.infer<typeof StopState>; reason: string;
  executionBindingHash: string; scopeHash: string; proof: z.infer<typeof StopProof> | null; legacy: boolean;
}
export interface StopDetail extends StopHoldSummary {
  createdAt: string; settledAt: string | null; targets: { jobIds: string[]; sessions: string[] };
  execution: StopRecord['execution']; world: string | null;
  canRecheck: boolean; canAttest: boolean;
}
export const StopAttestationRequest = z.object({ schema: z.literal(1), requestId: id, expectedRevision: z.number().int().positive(),
  executionBindingHash: digest, scopeHash: digest, confirmed: z.literal(true), note: z.string().trim().min(1).max(2000) }).strict()
export type StopAttestationRequest = z.infer<typeof StopAttestationRequest>
export const StopAttestationReceiptSchema = z.object({ version: z.literal(1), requestId: id, stopId: id, ticketId: id, assignmentId: id,
  request: StopAttestationRequest, requestHash: digest, phase: z.enum(['pending', 'accepted', 'refused']), acceptedAt: at,
  settledAt: at.nullable(), reason: z.string().max(300), observedRevision: z.number().int().positive() }).strict().superRefine((receipt, ctx) => {
    if (receipt.requestId !== receipt.request.requestId || (receipt.phase === 'pending') !== (receipt.settledAt === null))
      ctx.addIssue({ code: 'custom', message: 'Inconsistent original attestation receipt' })
  })
export type StopAttestationReceipt = z.infer<typeof StopAttestationReceiptSchema>
export const stopHeld = (record: Pick<StopRecord, 'state'>): boolean => record.state !== 'quiet' && record.state !== 'dormant'
export const stopSummary = (record: StopRecord): StopHoldSummary => ({ id: record.id, ticketId: record.ticketId,
  assignmentId: record.assignmentId, sessionId: record.sessionId, revision: record.revision, scope: record.scope, state: record.state,
  reason: record.reason, executionBindingHash: record.executionBindingHash, scopeHash: record.scopeHash, proof: record.proof, legacy: record.legacy })
