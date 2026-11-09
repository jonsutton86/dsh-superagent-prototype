/** Durable background-preparation reservations, review and publication authority. */
import { z } from 'zod'
import type { UsageTotals } from '../usage/model.ts'
import type { Ticket } from '../core/index.ts'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), amount = z.number().int().min(1).max(1e12)
export const SpeculationAllowance = z.object({ calls: amount.max(10000), tokens: amount, cost: amount.optional(), seconds: amount.max(86400) }).strict()
export const SpeculationQuota = SpeculationAllowance.extend({ concurrent: amount.max(100), runs: amount.max(10000) })
export const SpeculationPolicy = z.object({ enabled: z.boolean(), ttlMinutes: amount.max(10080), run: SpeculationAllowance,
  limits: z.object({ workspace: SpeculationQuota, owner: SpeculationQuota, provider: SpeculationQuota, environment: SpeculationQuota }).strict() }).strict()
export type SpeculationPolicy = z.infer<typeof SpeculationPolicy>
export type SpeculationAllowance = z.infer<typeof SpeculationAllowance>
export type SpeculationDimension = keyof SpeculationPolicy['limits']
export const defaultSpeculation: SpeculationPolicy = { enabled: true, ttlMinutes: 1440,
  run: { calls: 10, tokens: 2000000, seconds: 600 }, limits: Object.fromEntries(['workspace', 'owner', 'provider', 'environment'].map(dimension => [dimension,
    { concurrent: 1, runs: 20, calls: 200, tokens: 50000000, seconds: 7200 }])) as SpeculationPolicy['limits'] }
export const SaveSpeculation = z.object({ requestId: id, revision: z.number().int().nonnegative(), policy: SpeculationPolicy }).strict()
export const SpeculationCommand = z.object({ requestId: id, revision: z.number().int().positive(),
  command: z.enum(['promote', 'cancel', 'reconcile']), evidence: z.string().max(100).optional(), note: z.string().trim().min(1).max(2000) }).strict()
export const ApproveSpeculationMessage = z.object({ requestId: id, revision: z.number().int().positive(), receiptId: id,
  fingerprint: z.string().min(1).max(100), note: z.string().trim().min(1).max(2000) }).strict()
export interface SpeculationConfiguration { revision: number; at: string; policy: SpeculationPolicy }
export interface SpeculationRun {
  id: string; ticketId: string; assignmentId: string; revision: number; title: string; owner: string; environment: string
  createdAt: string; expiresAt: string; state: 'proposed' | 'admitted' | 'ready' | 'promoted' | 'expired' | 'cancelled'
  providers: string[]; policyRevision?: number; allowance?: SpeculationAllowance; admittedAt?: string; deadline?: string
  queuedPolicyRevision?: number
  execution?: Ticket['execution']
  releasedAt?: string; releaseEvidence?: string; recovered?: boolean; attestation?: { at: string; note: string }; problem?: string
  evidence?: string; report?: string; review?: { at: string; note: string }
}
export interface SpeculationView extends SpeculationRun {
  usage: UsageTotals; messages: { id: string; text: string; channel: unknown; fingerprint: string; approved: boolean; status: string }[]
}
export interface SpeculationState { configuration: SpeculationConfiguration; items: SpeculationRun[]; nextOffset: number | null }
export type SaveSpeculationInput = z.input<typeof SaveSpeculation>
export type SpeculationCommandInput = z.input<typeof SpeculationCommand>
export type ApproveSpeculationMessageInput = z.input<typeof ApproveSpeculationMessage>
