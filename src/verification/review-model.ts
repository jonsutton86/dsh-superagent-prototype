/** Evidence references accepted from operators and host-produced seals carried by approvals and receipts. */
import { z } from 'zod'
import { CheckCommandId, CheckRef } from './contracts.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().uuid(), revision = z.number().int().positive()
export const CheckSelection = z.object({ runId: CheckCommandId, evidenceHash: digest }).strict()
export type CheckSelection = z.infer<typeof CheckSelection>
export const CheckSelections = z.array(CheckSelection).max(32).refine(items => new Set(items.map(item => item.runId)).size === items.length, 'Select each check once')
export const EvidenceBinding = z.object({ selection: CheckSelection, artifact: z.object({ id, revision, hash: digest }).strict(),
  check: CheckRef.extend({ hash: digest }).strict(), snapshotHash: digest,
  execution: z.object({ binding: z.string().min(1).max(200), assignmentId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200) }).strict(),
  repository: z.object({ commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    contentTree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(), statusHash: digest.optional() }).strict().optional(),
  confinement: z.enum(['linux-bubblewrap', 'host-process']), checkedAt: z.string().datetime() }).strict()
export type EvidenceBinding = z.infer<typeof EvidenceBinding>
export const EvidenceSeal = EvidenceBinding.extend({ capture: z.object({ id: CheckCommandId, capturedAt: z.string().datetime(), finishedAt: z.string().datetime() }).strict(),
  validUntil: z.string().datetime() }).strict()
export type EvidenceSeal = z.infer<typeof EvidenceSeal>
export const FRESHNESS_WINDOW_MS = 60_000
export const ReviewRequest = z.object({ id: CheckCommandId, purpose: z.enum(['publication', 'acceptance']), target: digest, checks: CheckSelections }).strict()
export type ReviewRequest = z.infer<typeof ReviewRequest>
export interface EvidenceReview {
  id: string; purpose: ReviewRequest['purpose']; target: string; checks: CheckSelection[]; createdAt: string; updatedAt: string
  status: 'capturing' | 'ready' | 'held'; problem?: string; evidence?: EvidenceSeal[]
  attempts: { id: string; at: string; captures: { id: string; source: string; checkId: string }[] }[]
}
