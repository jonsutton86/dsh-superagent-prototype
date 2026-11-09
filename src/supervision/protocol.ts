/** Shared, bounded supervision protocol; observations and model assessments never convey authority. */
import { z } from 'zod'

export const ObservationSchema = z.object({
  id: z.string(), assignmentId: z.string().nullable(), revision: z.string(), title: z.string().max(500),
  scope: z.string().max(2000), stage: z.string(), updatedAt: z.string(),
  report: z.object({ state: z.string(), summary: z.string().max(2000), at: z.string() }).nullable(),
  canNudge: z.boolean(),
})
export const SnapshotSchema = z.object({
  instance: z.string(), at: z.string(), configured: z.boolean(), paused: z.boolean(),
  version: z.string(), tickets: z.array(ObservationSchema).max(100), nextOffset: z.number().int().nonnegative().nullable(),
  health: z.record(z.string(), z.object({ state: z.string(), detail: z.string().max(2000).optional() })),
})
export type Observation = z.infer<typeof ObservationSchema>
export type Snapshot = z.infer<typeof SnapshotSchema>
export const InterventionSchema = z.object({
  requestId: z.string().min(1).max(200), instance: z.string().min(1).max(100),
  ticketId: z.string().min(1).max(200), revision: z.string().min(1).max(100),
  action: z.literal('request_status'),
}).strict()
export type Intervention = z.infer<typeof InterventionSchema>
export interface InterventionResult { accepted: boolean; reason: string }
export const InterventionResultSchema = z.object({ accepted: z.boolean(), reason: z.string() })
export const AssessmentSchema = z.object({
  incidentId: z.string().min(1).max(200), incidentRevision: z.string().min(1).max(100),
  finding: z.enum(['progressing', 'stalled', 'blocked', 'drift', 'unknown']),
  evidence: z.string().min(1).max(2000),
}).strict()
export type Assessment = z.infer<typeof AssessmentSchema>

/** Timestamp is part of the immutable request ID, so expired receipts can be pruned without enabling a replay. */
export const AcknowledgeSchema = z.object({
  requestId: z.string().regex(/^wd-[0-9]{13}-[a-f0-9-]{36}$/),
  incidentId: z.string().min(1).max(200), revision: z.string().min(1).max(100), note: z.string().trim().max(2000),
}).strict()
export type Acknowledge = z.infer<typeof AcknowledgeSchema>
export interface Acknowledgement { requestId: string; revision: string; at: number; actor: 'local-operator'; note: string }
export interface AcknowledgementReceipt { incidentId: string; acknowledgement: Acknowledgement }
export const ACK_WINDOW_MS = 24 * 60 * 60 * 1000
export interface RetentionPolicy { closedDays: number; auditDays: number; maxClosed: number; maxAudit: number }
export const DEFAULT_RETENTION: RetentionPolicy = { closedDays: 30, auditDays: 90, maxClosed: 5000, maxAudit: 50000 }
export type IncidentFilter = 'open' | 'unacknowledged' | 'closed' | 'all'
export interface Page<T> { items: T[]; cursor: string | null }
/** Stable operator API failures distinguish stale evidence, expired history and malformed commands. */
export class WatchdogOperatorError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
