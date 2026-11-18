/** Persisted usage facts, versioned estimated pricing, and managed-work budget contracts. */
import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const UsageTokens = z.object({ inputTokens: count, outputTokens: count, totalTokens: count.optional(),
  cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), reasoningTokens: count.optional() }).strict()
export type UsageTokens = z.infer<typeof UsageTokens>
export const UsageScope = z.discriminatedUnion('kind', [z.object({ kind: z.literal('workspace') }).strict(),
  ...(['mission', 'schedule', 'persona'] as const).map(kind => z.object({ kind: z.literal(kind), id }).strict())])
export type UsageScope = z.infer<typeof UsageScope>
export const ModelPrice = z.object({ provider: z.string().min(1).max(120), model: z.string().min(1).max(200),
  input: count.max(1e12), output: count.max(1e12), cacheRead: count.max(1e12), cacheWrite: count.max(1e12),
  note: z.string().trim().min(1).max(1000) }).strict()
export type ModelPrice = z.infer<typeof ModelPrice>
export const UsageBudget = z.object({ id, title: z.string().trim().min(1).max(160), scope: UsageScope,
  period: z.enum(['day', 'month', 'lifetime']), enabled: z.boolean(), calls: count.min(1).max(1e9).optional(),
  tokens: count.min(1).max(1e12).optional(), cost: count.min(1).max(1e12).optional() }).strict()
  .refine(value => value.calls !== undefined || value.tokens !== undefined || value.cost !== undefined, 'Choose at least one limit')
export type UsageBudget = z.infer<typeof UsageBudget>
export const SaveUsage = z.object({ requestId: id, revision: count, prices: z.array(ModelPrice).max(200), budgets: z.array(UsageBudget).max(100) }).strict()
  .superRefine((value, context) => {
    if (new Set(value.budgets.map(item => item.id)).size !== value.budgets.length) context.addIssue({ code: 'custom', message: 'Budget IDs must be unique' })
    if (new Set(value.prices.map(item => JSON.stringify([item.provider, item.model]))).size !== value.prices.length)
      context.addIssue({ code: 'custom', message: 'Model prices must be unique' })
  })
export type SaveUsageInput = z.input<typeof SaveUsage>
export const ReconcileUsage = z.object({ requestId: id, tokens: UsageTokens, cost: count.max(1e12).optional(),
  note: z.string().trim().min(1).max(2000) }).strict()
export type ReconcileUsageInput = z.input<typeof ReconcileUsage>
export interface UsageOwner { sessionId: string; root: string; role: 'orchestrator' | 'worker'; ticketId?: string; assignmentId?: string; speculationId?: string; missionId?: string; scheduleId?: string; personaId?: string }
export interface UsageCall {
  id: string; owner: UsageOwner; provider: string; model: string; purpose: string; startedAt: string; settledAt?: string
  phase: 'pending' | 'reported' | 'unknown' | 'reconciled'; outcome?: string; configRevision: number
  reservedTokens?: number; reservedCost?: number; price?: ModelPrice; tokens?: UsageTokens; totalTokens?: number; cost?: number
  reconciliation?: { at: string; note: string; tokens: UsageTokens; cost?: number }
}
export interface UsageConfiguration { revision: number; at: string; prices: ModelPrice[]; budgets: UsageBudget[]; trackingSince: string }
export interface UsageTotals { calls: number; tokens: number; cost: number; reservedTokens: number; reservedCost: number; unknownTokens: number; unknownCost: number; pending: number }
export interface BudgetView extends UsageBudget { from: string; totals: UsageTotals; exhausted: boolean }
export interface UsagePage {
  configuration: UsageConfiguration; from: string; scope: UsageScope; totals: UsageTotals; budgets: BudgetView[]
  calls: UsageCall[]; nextOffset: number | null
}
/** A bounded operator-facing accounting conflict or refusal, without provider credentials or message content. */
export class UsageError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}
