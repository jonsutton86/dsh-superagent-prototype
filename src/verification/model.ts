/** Host-collected snapshot/check contracts; none of these facts may be supplied by a model report. */
import { z } from 'zod'
const digest = z.string().regex(/^[a-f0-9]{64}$/), gitObject = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const relativePath = z.string().min(1).max(1024).refine(value => !value.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => !!part && part !== '.' && part !== '..'), 'Use a relative path without traversal or control characters')
export const SnapshotSpec = z.object({ exclude: z.array(relativePath).max(100).default([]), maxFiles: z.number().int().min(1).max(20000).default(10000),
  maxBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(256 * 1024 * 1024),
  timeoutSeconds: z.number().int().min(1).max(300).default(120), repository: z.enum(['none', 'if-present', 'required']).default('if-present') }).strict()
export const VerificationJob = z.object({ kind: z.enum(['capture', 'check']), snapshot: SnapshotSpec.default(() => SnapshotSpec.parse({})),
  artifact: z.object({ path: relativePath, hash: digest }).strict().optional(), expectedSnapshot: digest.optional(),
  expectedRepository: z.object({ commit: gitObject, tree: gitObject.optional() }).strict().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300) }).strict()
export type SnapshotSpec = z.infer<typeof SnapshotSpec>
export type VerificationJob = z.infer<typeof VerificationJob>
export interface SnapshotEntry { path: string; kind: 'directory' | 'file' | 'symlink'; hash?: string; bytes?: number; executable?: boolean; target?: string }
export interface SnapshotManifest {
  version: 1; hash: string; capturedAt: string; source: string; files: number; bytes: number; exclude: string[]; entries: SnapshotEntry[]
  repository?: { commit: string; tree: string; branch: string | null; statusHash: string; contentTree?: string }
}
export interface CheckEvidence {
  kind: VerificationJob['kind']; stage: 'capturing' | 'checking' | 'finished'; confinement: string
  startedAt: string; finishedAt?: string; checkedAt?: string
  snapshot?: SnapshotManifest; artifactHash?: string; snapshotUnchanged?: boolean; problem?: string; storageReleased?: boolean
  output?: Record<'stdout' | 'stderr', { hash: string; bytes: number }>
}
/** Disk admission includes conservative per-path allocation and bounded metadata, not only logical file bytes. */
export const snapshotReservation = (spec: SnapshotSpec) => spec.maxBytes + spec.maxFiles * 4096 + 4 * 1024 * 1024
export const SnapshotManifestSchema = z.object({ version: z.literal(1), hash: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: z.string().datetime(),
  source: z.string().startsWith('/').max(4096), files: z.number().int().min(0).max(20000), bytes: z.number().int().min(0).max(1024 * 1024 * 1024),
  exclude: z.array(relativePath).max(101), entries: z.array(z.discriminatedUnion('kind', [
    z.object({ path: relativePath, kind: z.literal('directory') }).strict(),
    z.object({ path: relativePath, kind: z.literal('file'), hash: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), executable: z.boolean() }).strict(),
    z.object({ path: relativePath, kind: z.literal('symlink'), target: z.union([z.literal('.'), relativePath]) }).strict(),
  ])).max(20000), repository: z.object({ commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    branch: z.string().min(1).max(1024).nullable(), statusHash: z.string().regex(/^[a-f0-9]{64}$/), contentTree: gitObject.optional() }).strict().optional() }).strict()
export const CheckEvidenceSchema = z.object({ kind: VerificationJob.shape.kind, stage: z.enum(['capturing', 'checking', 'finished']),
  confinement: z.string().min(1).max(100), startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(), checkedAt: z.string().datetime().optional(),
  snapshot: SnapshotManifestSchema.optional(), artifactHash: digest.optional(), snapshotUnchanged: z.boolean().optional(), problem: z.string().max(4000).optional(),
  storageReleased: z.boolean().optional(), output: z.object({ stdout: z.object({ hash: digest, bytes: z.number().int().nonnegative() }).strict(),
    stderr: z.object({ hash: digest, bytes: z.number().int().nonnegative() }).strict() }).strict().optional() }).strict()
