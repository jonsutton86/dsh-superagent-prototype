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
export const StorageReservation = StorageIntent.extend({
  endpointId: z.string().uuid(), projectId: z.number().int().min(1).max(2 ** 32 - 1),
  phase: z.enum(['reserved', 'provisioning']),
  createdAt: z.string().datetime(),
}).strict()
export type StorageReservation = z.infer<typeof StorageReservation>
