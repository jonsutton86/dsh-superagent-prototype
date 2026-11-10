/** Private publisher contracts for immutable bundle ingestion and separately fenced Git/PR effects. */
import { z } from 'zod'
import { OwnershipStamp } from '../ownership/protocol.ts'
import { CheckSelections, EvidenceSeal } from '../verification/review-model.ts'
import { RepositoryBundle, REPOSITORY_EXPORT_LIMITS } from './repository-export-model.ts'
import { RepositoryName } from './pull-model.ts'
import { RepositorySource } from '../environments/repository-model.ts'

const id = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/)
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), at = z.string().datetime()
const destinationId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
export const RepositoryRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(value => !value.includes('..') && !value.includes('//') && !value.endsWith('.') && !value.endsWith('/')
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')), 'Use a valid branch name')
export const RepositoryDestination = z.object({ id: destinationId, name: z.string().trim().min(1).max(160),
  repository: RepositoryName, repositoryId: integer, baseRef: RepositoryRef, login: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()
export type RepositoryDestination = z.infer<typeof RepositoryDestination>
export const RepositoryDestinationConfig = RepositoryDestination.extend({ credentialFile: z.string().startsWith('/') }).strict()
export type RepositoryDestinationConfig = z.infer<typeof RepositoryDestinationConfig>
export const RepositoryDestinationView = RepositoryDestination.extend({ hash: digest }).strict()
export const RepositoryArtifact = z.object({ id, revision: integer, hash: digest }).strict()
export const RepositoryTransfer = z.object({ id, artifact: RepositoryArtifact,
  source: RepositorySource.shape.url, bundle: RepositoryBundle }).strict()
export type RepositoryTransfer = z.infer<typeof RepositoryTransfer>
export const RepositoryTransferReceipt = RepositoryTransfer.extend({ hash: digest, ownership: OwnershipStamp,
  owners: z.array(OwnershipStamp).min(1).max(100),
  phase: z.enum(['receiving', 'ready', 'cancelled']), received: z.number().int().nonnegative().max(REPOSITORY_EXPORT_LIMITS.bytes), createdAt: at, updatedAt: at }).strict()
export type RepositoryTransferReceipt = z.infer<typeof RepositoryTransferReceipt>
export const RepositoryPublication = z.object({ id, destination: destinationId, destinationHash: digest, transferId: id, transferHash: digest,
  title: z.string().trim().min(1).max(240), body: z.string().max(30000), draft: z.boolean(),
  checks: CheckSelections.refine(items => items.length > 0, 'Repository publication requires reviewed checks') }).strict()
export type RepositoryPublication = z.infer<typeof RepositoryPublication>
export const RepositoryBranch = z.object({ repository: RepositoryName, repositoryId: integer, ref: RepositoryRef, sha }).strict()
export const RepositoryPull = z.object({ id: integer, number: integer, url: z.string().url(), repositoryId: integer, head: RepositoryBranch,
  base: RepositoryBranch, bodyHash: digest, title: z.string().max(240), draft: z.boolean(), state: z.enum(['open', 'closed']), merged: z.boolean() }).strict()
export type RepositoryPull = z.infer<typeof RepositoryPull>
export const RepositoryReceipt = z.object({ id, requestHash: digest, destination: destinationId, destinationHash: digest,
  transferId: id, transferHash: digest, artifact: RepositoryArtifact, bundle: RepositoryBundle, branch: RepositoryRef,
  ownership: OwnershipStamp, phase: z.enum(['held', 'preparing', 'branch_started', 'branch_ready', 'pull_started', 'published', 'unknown', 'cancelled', 'reconciled']),
  step: z.enum(['branch', 'pull']), createdAt: at, updatedAt: at, branchResult: RepositoryBranch.optional(), pullResult: RepositoryPull.optional(),
  attempts: z.array(z.object({ step: z.enum(['branch', 'pull']), at, ownership: OwnershipStamp,
    evidence: z.array(EvidenceSeal).min(1).max(32) }).strict()).max(40), problem: z.string().max(1000).optional(),
  reconciliation: z.object({ at, note: z.string().trim().min(10).max(1000), evidence: z.string().trim().min(10).max(2000) }).strict().optional() }).strict()
export type RepositoryReceipt = z.infer<typeof RepositoryReceipt>
export const RepositoryRpc = [
  z.object({ op: z.literal('repository.destinations') }).strict(),
  z.object({ op: z.literal('repository.transfer.begin'), transfer: RepositoryTransfer }).strict(),
  z.object({ op: z.literal('repository.transfer.get'), id }).strict(),
  z.object({ op: z.literal('repository.transfer.chunk'), id, offset: z.number().int().nonnegative().max(REPOSITORY_EXPORT_LIMITS.bytes),
    data: z.string().min(4).max(Math.ceil(REPOSITORY_EXPORT_LIMITS.chunk / 3) * 4), hash: digest }).strict(),
  z.object({ op: z.literal('repository.transfer.finish'), id }).strict(),
  z.object({ op: z.literal('repository.transfer.cancel'), id }).strict(),
  z.object({ op: z.literal('repository.prepare'), publication: RepositoryPublication }).strict(),
  z.object({ op: z.literal('repository.publish'), publication: RepositoryPublication, evidence: z.array(EvidenceSeal).min(1).max(32) }).strict(),
  z.object({ op: z.literal('repository.receipt.get'), id }).strict(),
  z.object({ op: z.literal('repository.receipt.cancel'), id }).strict(),
  z.object({ op: z.literal('repository.receipt.observe'), id, pullNumber: integer.optional() }).strict(),
  z.object({ op: z.literal('repository.receipt.resolve'), id, note: z.string().trim().min(10).max(1000), evidence: z.string().trim().min(10).max(2000) }).strict(),
] as const
