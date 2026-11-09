/** Operator-approved PR targets and provider observations attached to mission results. */
import { z } from 'zod'
import { PullObservation, type PullBinding } from '../publication/pull-model.ts'

export const PullTargetRef = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const ConfigureMissionPull = z.discriminatedUnion('enabled', [
  z.object({ requestId: PullTargetRef, revision: z.number().int().positive(), enabled: z.literal(true),
    destination: PullTargetRef, destinationHash: digest, pullHash: digest }).strict(),
  z.object({ requestId: PullTargetRef, revision: z.number().int().positive(), enabled: z.literal(false) }).strict(),
])
export type ConfigureMissionPull = z.infer<typeof ConfigureMissionPull>
export const PullTarget = z.object({ id: PullTargetRef, name: z.string().min(1).max(160), destination: PullTargetRef,
  destinationHash: digest, identity: digest, createdAt: z.string().datetime(), initial: PullObservation }).strict()
export type PullTarget = z.infer<typeof PullTarget>
export interface MissionPullAcceptance { target: string; observation: PullObservation }
export interface MissionPullState { target: PullTarget; observation?: PullObservation; attemptedAt: string; observationRevision: number; problem?: string }
/** Changing commits is expected during work; changing the PR, repositories, author or branch identities requires rebinding. */
export const pullIdentity = (pull: PullBinding) => ({ id: pull.id, number: pull.number, author: pull.author,
  head: { repository: pull.head.repository, ref: pull.head.ref }, base: { repository: pull.base.repository, ref: pull.base.ref } })
