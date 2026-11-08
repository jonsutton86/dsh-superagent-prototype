/** Coordinator ownership is separate from workspace authorization and never comes from model-supplied tool arguments. */
import { z } from 'zod'

export const OWNERSHIP_PATH = '/ownership/v1'
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const requestId = id, leaseMs = z.number().int().min(1000).max(60_000)
export const OwnershipStamp = z.object({ coordinatorId: id, epoch, nonce: z.string().uuid(), instanceId: z.string().uuid() }).strict()
export type OwnershipStamp = z.infer<typeof OwnershipStamp>
export const OwnershipRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('identity') }).strict(),
  z.object({ op: z.literal('coordinator.create'), requestId, id, resources: z.array(id).min(1).max(256) }).strict(),
  z.object({ op: z.literal('resources.add'), requestId, id, epoch: z.number().int().nonnegative(), resources: z.array(id).min(1).max(256) }).strict(),
  z.object({ op: z.literal('lease.acquire'), requestId, instanceId: z.string().uuid(), leaseMs }).strict(),
  z.object({ op: z.literal('lease.renew'), requestId, leaseMs }).strict(),
  z.object({ op: z.literal('lease.activate'), requestId }).strict(),
  z.object({ op: z.literal('lease.release'), requestId }).strict(),
  z.object({ op: z.literal('lease.inspect') }).strict(),
  z.object({ op: z.literal('lease.verify'), proof: z.string().min(32).max(1024) }).strict(),
  z.object({ op: z.literal('resource.acknowledge'), requestId, stamp: OwnershipStamp }).strict(),
])
export type OwnershipRequest = z.infer<typeof OwnershipRequest>
export const OwnershipView = z.object({ coordinatorId: id, epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(['vacant', 'preparing', 'active']), remainingMs: z.number().int().nonnegative().max(60_000),
  owner: OwnershipStamp.optional(), resources: z.array(id).min(1).max(256), acknowledged: z.array(id).max(256) }).strict()
  .refine(value => value.phase === 'vacant' ? value.remainingMs === 0 && !value.owner : value.remainingMs > 0
    && value.owner?.coordinatorId === value.coordinatorId && value.owner.epoch === value.epoch, 'Invalid live ownership state')
export type OwnershipView = z.infer<typeof OwnershipView>
/** Recovery observations and explicit operator reconciliation do not issue new workspace authority or execute agent work. */
const recoveryOperations = new Set(['identity', 'grant.get', 'grant.list', 'grant.status',
  'credential.list', 'job.catalog', 'operation.list', 'job.list', 'job.get', 'job.output', 'operation.get', 'job.reconcile', 'operation.reconcile'])
export const requiresOwnership = (op: string): boolean => !recoveryOperations.has(op)
export interface OwnershipBinding { authorityId: string; coordinatorId: string }
export interface OwnershipAccess extends OwnershipBinding { proof(): string }
export interface OwnershipClaim { lease: OwnershipView; credential: string }
export interface OwnershipEnrollment { coordinatorId: string; credential: string; resources: { id: string; credential: string }[] }
export type OwnershipPrincipal = { role: 'admin' } | { role: 'claimant'; coordinatorId: string }
  | { role: 'resource'; coordinatorId: string; resourceId: string } | ({ role: 'lease' } & OwnershipStamp)
/** Typed, non-secret refusal. Transport ambiguity never supplies permission to acquire a replacement lease. */
export class OwnershipError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
