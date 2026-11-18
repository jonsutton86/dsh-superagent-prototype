/** Operator-authored immutable checks and artifact-bound requests. Model tools accept references, never commands. */
import { z } from 'zod'
import { LibraryScope } from '../workspace/library-model.ts'
import { SnapshotSpec, VerificationJob } from './model.ts'
import type { CheckEvidence } from './model.ts'
import type { LibraryRecord } from '../workspace/library-model.ts'
import type { RemoteJob, EffectOwner, RpcRequest } from '../remote/protocol.ts'

export const CheckId = z.string().uuid()
export const CheckCommandId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
export const CheckRef = z.object({ id: CheckId, version: z.number().int().positive() }).strict()
const environment = z.record(z.string().regex(/^(NO_COLOR|TERM|PAGER|GIT_PAGER|LANG|LC_ALL|CI|GIT_TERMINAL_PROMPT)$/), z.string().max(1000).nullable())
export const CheckDefinition = z.object({ name: z.string().trim().min(1).max(160), description: z.string().trim().min(1).max(2000),
  scope: LibraryScope.default('workspace'), argv: z.array(z.string().max(16000).refine(value => !value.includes('\0'))).min(1).max(64).refine(value => !!value[0], 'A check executable is required'),
  env: environment.default({}), stdin: z.string().max(32000).optional(), artifactPath: VerificationJob.shape.artifact.unwrap().shape.path,
  snapshot: SnapshotSpec.default(() => SnapshotSpec.parse({})), timeoutSeconds: VerificationJob.shape.timeoutSeconds,
  confinement: z.enum(['linux-bubblewrap', 'host-process']).default('linux-bubblewrap'),
  maxConcurrent: z.number().int().min(1).max(8).default(1), maxRunsPerDay: z.number().int().min(1).max(1000).default(20),
}).strict().refine(value => JSON.stringify(value).length <= 64000, 'Check definitions must fit within 64,000 characters')
export const CreateCheck = z.object({ requestId: CheckCommandId, definition: CheckDefinition, enabled: z.boolean().default(false), workers: z.boolean().default(false) }).strict()
export const SaveCheck = z.object({ requestId: CheckCommandId, revision: z.number().int().positive(), definition: CheckDefinition }).strict()
export const ConfigureCheck = z.object({ requestId: CheckCommandId, revision: z.number().int().positive(), enabled: z.boolean(), workers: z.boolean(),
  reason: z.string().trim().min(1).max(2000) }).strict()
export const RequestCheck = z.object({ requestId: CheckCommandId, check: CheckRef, artifactRevision: z.number().int().positive(),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/), expectedSnapshot: VerificationJob.shape.expectedSnapshot,
  expectedRepository: VerificationJob.shape.expectedRepository }).strict()
export const CancelCheck = z.object({ requestId: CheckCommandId, reason: z.string().trim().min(1).max(2000) }).strict()
export const ReconcileCheck = CancelCheck.extend({ quiescent: z.literal(true) }).strict()
export type CheckDefinition = z.infer<typeof CheckDefinition>
export type CreateCheckInput = z.input<typeof CreateCheck>
export type SaveCheckInput = z.input<typeof SaveCheck>
export type ConfigureCheckInput = z.input<typeof ConfigureCheck>
export type RequestCheckInput = z.input<typeof RequestCheck>
export interface CheckVersion { id: string; version: number; definition: CheckDefinition; hash: string; createdAt: string }
export interface CheckRecord extends CheckVersion { revision: number; enabled: boolean; workers: boolean; updatedAt: string }
export type CheckStatus = 'pending' | 'running' | 'passed' | 'captured' | 'failed' | 'unknown'
export interface CheckRun {
  id: string; artifact: { id: string; revision: number; hash: string; scope: string; ticketId: string; assignmentId: string; sessionId: string }
  check: CheckVersion; execution: NonNullable<LibraryRecord['execution']>; owner: EffectOwner
  purpose: 'check' | 'freshness'; sourceCheckId?: string
  actor: 'operator' | 'worker'; createdAt: string; updatedAt: string; status: CheckStatus; quiescent: boolean | null
  cancel?: { requestId: string; reason: string; at: string }; reconciliation?: { requestId: string; reason: string; at: string }
  problem?: string; outcome?: RemoteJob['outcome']; evidence?: CheckEvidence
  backend: { kind: 'remote' | 'local'; binding: string; source: string; endpointId?: string; grantId: string; epoch: number; revision: number; confinement: string }
}
export interface StoredCheckRun extends CheckRun {
  fingerprint: string; request: Extract<RpcRequest, { op: 'job.spawn' }>; requestHash: string
  receipt?: RemoteJob
}
export interface CheckRunSummary extends Omit<CheckRun, 'check' | 'evidence' | 'execution'> {
  check: Pick<CheckVersion, 'id' | 'version' | 'hash'> & { name: string }
  evidence?: Omit<CheckEvidence, 'snapshot'> & { snapshot?: Omit<NonNullable<CheckEvidence['snapshot']>, 'entries'> }
}
