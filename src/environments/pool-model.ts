/** Durable managed execution worlds: authority activation is independent from mission assignment. */
import { z } from 'zod'
import type { RemoteWorldStatus } from '../remote/world.ts'

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
export const WorldRef = z.string().regex(/^[a-f0-9]{64}$/)
export const ActivateWorld = z.object({ requestId, endpointId: z.string().uuid(), commandId: requestId,
  name: z.string().trim().min(1).max(160) }).strict()
export const RevokeWorld = z.object({ requestId, revision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000) }).strict()
export interface WorldView {
  id: string; name: string; endpointId: string; grantId: string; epoch: number; root: string; revision: number
  enabled: boolean; createdAt: string; updatedAt: string; ready: boolean; problem?: string; status?: RemoteWorldStatus
}
export interface WorldList { items: WorldView[]; nextOffset: number | null }
export type ActivateWorldInput = z.input<typeof ActivateWorld>
export type RevokeWorldInput = z.input<typeof RevokeWorld>
