/** Provider-observed pull request identity and commit binding; model text never supplies these facts. */
import { z } from 'zod'
import type { EvidenceBinding } from '../verification/review-model.ts'

export const RepositoryName = z.string().max(200).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/).refine(value => !['.', '..'].includes(value.split('/')[1]!))
export const GitObject = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), digest = z.string().regex(/^[a-f0-9]{64}$/)
const repository = z.object({ id: integer, name: RepositoryName }).strict(), branch = z.string().min(1).max(1024)
export const PullBinding = z.object({ id: integer, number: integer, author: z.string().max(100).regex(/^[A-Za-z0-9-]+(?:\[bot\])?$/),
  head: z.object({ repository, ref: branch, sha: GitObject, tree: GitObject }).strict(),
  base: z.object({ repository, ref: branch, sha: GitObject }).strict(),
  state: z.enum(['open', 'closed']), draft: z.boolean(), merged: z.boolean() }).strict()
export type PullBinding = z.infer<typeof PullBinding>
export const PullObservation = z.object({ destination: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), destinationHash: digest,
  binding: PullBinding, hash: digest, observedAt: z.string().datetime() }).strict()
export type PullObservation = z.infer<typeof PullObservation>
/** An empty Git status alone cannot establish this: captured bytes must reconstruct the provider's exact tree. */
export const matchesPullEvidence = (evidence: Pick<EvidenceBinding, 'repository'>, pull: PullBinding): boolean =>
  evidence.repository?.commit === pull.head.sha && evidence.repository?.tree === pull.head.tree
  && evidence.repository?.contentTree === pull.head.tree
  && evidence.repository?.statusHash === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
