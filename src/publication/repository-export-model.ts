/** Immutable, host-reviewed Git bundles staged for independent repository publication. No provider credentials. */
import { z } from 'zod'
import { CheckSelections, EvidenceSeal } from '../verification/review-model.ts'
import { RepositorySource } from '../environments/repository-model.ts'

export const REPOSITORY_EXPORT_LIMITS = { bytes: 256 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, count: 128, history: 10000, chunk: 65536 } as const
const id = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/), commit = z.string().regex(/^[a-f0-9]{40}$/)
export const PrepareRepositoryExport = z.object({ requestId: id, revision: z.number().int().positive(), hash: digest,
  checks: CheckSelections.refine(items => items.length > 0, 'Select successful checks of the committed repository') }).strict()
export type PrepareRepositoryExport = z.infer<typeof PrepareRepositoryExport>
export const RepositoryBundle = z.object({ version: z.literal(1), base: commit, head: commit, tree: commit,
  bytes: z.number().int().positive().max(REPOSITORY_EXPORT_LIMITS.bytes), sha256: digest }).strict()
export type RepositoryBundle = z.infer<typeof RepositoryBundle>
export const RepositoryExportRecord = z.object({ id, artifactId: id, request: PrepareRepositoryExport, fingerprint: digest,
  world: digest, ticketId: z.string().min(1).max(100), assignmentId: z.string().min(1).max(100),
  directory: z.string().startsWith('/').max(4096), source: RepositorySource,
  head: commit, tree: commit, commandId: z.string().min(1).max(100),
  phase: z.enum(['preparing', 'held', 'ready', 'cancelled']), received: z.number().int().min(0).max(REPOSITORY_EXPORT_LIMITS.bytes),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), problem: z.string().max(1000).optional(),
  bundle: RepositoryBundle.optional(), evidence: z.array(EvidenceSeal).min(1).max(32).optional() }).strict()
export type RepositoryExportRecord = z.infer<typeof RepositoryExportRecord>
export type RepositoryExportView = Omit<RepositoryExportRecord, 'request' | 'fingerprint' | 'directory' | 'commandId'>
