/** Client-safe metadata vocabulary. Activity is evidence for assessment, never proof of progress or execution authority. */
import { z } from 'zod'

export const EXECUTION_EVIDENCE_LIMIT = 256
const count = z.number().int().min(0).max(EXECUTION_EVIDENCE_LIMIT)
const availability = z.enum(['available', 'unavailable'])
const sampleRevision = z.string().regex(/^[a-f0-9]{64}$/).nullable()
export const JobEvidenceCountsSchema = z.object({ running: count, stopping: count, completed: count, killed: count, failed: count, unknown: count }).strict()
export const RemoteExecutionEvidenceSchema = z.object({
  availability: z.enum(['available', 'unavailable', 'not_applicable']), attribution: z.literal('assignment'),
  coverage: z.enum(['complete', 'partial', 'unavailable']), sampled: count, sampleRevision,
  phases: z.object({ pending: count, accepted: count, started: count, settled: count, refused: count, unknown: count }).strict(),
  quiescence: z.object({ confirmed: count, unconfirmed: count, unknown: count }).strict(),
  outcomes: z.object({ succeeded: count, failed: count, signalled: count, unknown: count }).strict(),
}).strict()
export type RemoteExecutionEvidence = z.infer<typeof RemoteExecutionEvidenceSchema>
export const ExecutionEvidenceSchema = z.object({
  version: z.literal(1), assignmentId: z.string().min(1).max(300).nullable(),
  session: z.object({ id: z.string().min(1).max(300), availability, state: z.enum(['idle', 'running', 'unknown']),
    attribution: z.literal('session'), assignmentAttribution: z.literal('unknown') }).strict(),
  jobs: z.object({ availability, attribution: z.literal('session'), assignmentAttribution: z.literal('unknown'),
    lifecycleAttribution: z.literal('unknown'), coverage: z.enum(['complete', 'partial', 'unavailable']), sampled: count, sampleRevision,
    counts: JobEvidenceCountsSchema, handedOff: z.object({ running: count, stopping: count }).strict(),
    outputBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() }).strict(),
  subagents: z.object({ availability, attribution: z.literal('observed-session-lineage'), assignmentAttribution: z.literal('unknown'),
    coverage: z.enum(['loaded-only', 'unavailable']), sampled: count, sampleRevision, truncated: z.boolean(),
    counts: z.object({ running: count, idle: count, unknown: count }).strict() }).strict(),
  executor: z.object({ availability, provenance: z.literal('process-local'), retrying: z.boolean(), turnRetryAttempts: count, launchRetryAttempts: count,
    settling: z.boolean(), preparing: z.boolean(), stopping: z.boolean(), knownHandedOffJobs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
  remoteEffects: RemoteExecutionEvidenceSchema,
}).strict()
export type ExecutionEvidence = z.infer<typeof ExecutionEvidenceSchema>

export function emptyRemoteExecutionEvidence(availability: RemoteExecutionEvidence['availability'] = 'unavailable'): RemoteExecutionEvidence {
  return { availability, attribution: 'assignment', coverage: availability === 'not_applicable' ? 'complete' : 'unavailable', sampled: 0, sampleRevision: null,
    phases: { pending: 0, accepted: 0, started: 0, settled: 0, refused: 0, unknown: 0 },
    quiescence: { confirmed: 0, unconfirmed: 0, unknown: 0 }, outcomes: { succeeded: 0, failed: 0, signalled: 0, unknown: 0 } }
}

/** Missing observations carry explicit unavailability, never a positive zero-work or healthy-state claim. */
export function unavailableExecutionEvidence(sessionId = 'unknown', assignmentId: string | null = null): ExecutionEvidence {
  return { version: 1, assignmentId, session: { id: sessionId, availability: 'unavailable', state: 'unknown', attribution: 'session', assignmentAttribution: 'unknown' },
    jobs: { availability: 'unavailable', attribution: 'session', assignmentAttribution: 'unknown', lifecycleAttribution: 'unknown',
      coverage: 'unavailable', sampled: 0, sampleRevision: null, counts: { running: 0, stopping: 0, completed: 0, killed: 0, failed: 0, unknown: 0 },
      handedOff: { running: 0, stopping: 0 }, outputBytes: null },
    subagents: { availability: 'unavailable', attribution: 'observed-session-lineage', assignmentAttribution: 'unknown', coverage: 'unavailable', sampled: 0, sampleRevision: null,
      truncated: false, counts: { running: 0, idle: 0, unknown: 0 } },
    executor: { availability: 'unavailable', provenance: 'process-local', retrying: false, turnRetryAttempts: 0, launchRetryAttempts: 0,
      settling: false, preparing: false, stopping: false, knownHandedOffJobs: 0 }, remoteEffects: emptyRemoteExecutionEvidence() }
}
