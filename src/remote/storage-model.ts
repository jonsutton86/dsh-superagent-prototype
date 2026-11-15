import { z } from 'zod'

/** XFS hard limits, not usage estimates. Byte limits use the qualified 4 KiB allocation unit. */
export const StorageBudget = z.object({
  bytes: z.number().int().min(4096).max(1024 ** 4).multipleOf(4096),
  inodes: z.number().int().min(1).max(2 ** 32 - 1),
}).strict()
export const EndpointStorage = z.object({
  kind: z.literal('linux-xfs-project'),
  filesystemUUID: z.string().uuid(),
  mountRoot: z.string().min(2).max(4096).refine(value => value.startsWith('/') && !/[\0\n\r]/.test(value)
    && !value.endsWith('/') && !value.split('/').slice(1).some(part => !part || part === '.' || part === '..')),
  // This range must be assigned exclusively by the host administrator; local uniqueness is not host-wide proof.
  projectIds: z.object({ first: z.number().int().min(1).max(2 ** 32 - 1), last: z.number().int().min(1).max(2 ** 32 - 1) }).strict(),
  pool: StorageBudget,
  workspace: StorageBudget,
}).strict().refine(value => value.projectIds.first <= value.projectIds.last, 'Project ID range is reversed')
  .refine(value => value.workspace.bytes <= value.pool.bytes && value.workspace.inodes <= value.pool.inodes,
    'Workspace allocation must fit the pool budget')
export type EndpointStorage = z.infer<typeof EndpointStorage>

export const StorageIntent = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  workspace: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
}).strict()
export type StorageIntent = z.infer<typeof StorageIntent>
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const StorageObservation = z.object({
  mountId: z.number().int().positive(), filesystemUUID: z.string().uuid(), mountRoot: z.string().min(2).max(4096),
  projectId: z.number().int().min(1).max(2 ** 32 - 1),
  directories: z.array(z.object({ path: z.string().min(2).max(4096), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
    projectId: z.number().int().positive(), inherits: z.literal(true), realtime: z.literal(false) }).strict()).min(1).max(16),
  quota: z.object({ accounting: z.literal(true), enforcement: z.literal(true), usedBytes: count, hardBytes: count,
    usedInodes: count, hardInodes: count }).strict(),
  observedAt: z.string().datetime(),
}).strict()
export type StorageObservation = z.infer<typeof StorageObservation>
export const StorageReservation = StorageIntent.extend({
  endpointId: z.string().uuid(), projectId: z.number().int().min(1).max(2 ** 32 - 1),
  phase: z.enum(['reserved', 'provisioning', 'provisioned']),
  observation: StorageObservation.optional(),
  createdAt: z.string().datetime(),
}).strict().refine(value => (value.phase === 'provisioned') === !!value.observation, 'Provisioned state requires its observation')
export type StorageReservation = z.infer<typeof StorageReservation>

const StatusSummary = z.object({ configured: z.literal(true), policy: EndpointStorage,
  reservationsObservedAt: z.string().datetime(), reservedAllocations: count, unreservedAllocations: count,
  workspace: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
const begun = z.enum(['provisioning', 'provisioned'])
export const StorageStatus = z.union([
  z.object({ configured: z.literal(false) }).strict(),
  StatusSummary.extend({ state: z.literal('unallocated') }).strict(),
  StatusSummary.extend({ state: z.literal('not-provisioned'), phase: z.literal('reserved') }).strict(),
  StatusSummary.extend({ state: z.literal('unavailable'), phase: begun }).strict(),
  StatusSummary.extend({ state: z.literal('observed'), phase: begun,
    quota: StorageObservation.shape.quota, observedAt: z.string().datetime() }).strict(),
]).superRefine((value, ctx) => {
  if (!value.configured) return
  const policy = value.policy, capacity = Math.min(Math.floor(policy.pool.bytes / policy.workspace.bytes),
    Math.floor(policy.pool.inodes / policy.workspace.inodes), policy.projectIds.last - policy.projectIds.first + 1)
  if (value.reservedAllocations + value.unreservedAllocations !== capacity
    || value.state !== 'unallocated' && value.reservedAllocations === 0)
    ctx.addIssue({ code: 'custom', message: 'Storage reservation counts do not match policy capacity' })
  if (value.state === 'observed' && (value.quota.hardBytes !== policy.workspace.bytes || value.quota.hardInodes !== policy.workspace.inodes))
    ctx.addIssue({ code: 'custom', message: 'Observed hard limits differ from the registered workspace policy' })
})
export type StorageStatus = z.infer<typeof StorageStatus>
