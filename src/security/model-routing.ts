import { z } from 'zod'
import type { ProviderConfig } from './providers.ts'

/** Task labels accepted by deterministic routing. */
export const TaskKind = z.enum(['reasoning', 'coding', 'summarize', 'fast'])

/** An accepted task label. */
export type TaskKind = z.infer<typeof TaskKind>

/** Reasons local routing can refuse a selection. */
export type RoutingRefusalReason = 'invalid_task' | 'no_providers' | 'no_eligible_provider'

/** A configured provider and model selected without capability verification. */
export interface RouteSelection {
  ok: true
  task: TaskKind
  provider: ProviderConfig
  model: string
  monthlyBudgetUsd: number | null
}

/** A routing refusal with a deterministic explanation. */
export interface RouteRefusal {
  ok: false
  task: string
  reason: RoutingRefusalReason
  detail: string
}

/** The outcome of local provider selection. */
export type RoutingResult = RouteSelection | RouteRefusal

/** Select the first configured provider satisfying local budget constraints. */
export function routeProvider(
  providers: readonly ProviderConfig[],
  task: unknown,
  options: { monthlyBudgetUsd?: number } = {}
): RoutingResult {
  const parsed = TaskKind.safeParse(task)
  if (!parsed.success) {
    return { ok: false, task: String(task), reason: 'invalid_task', detail: 'unknown task kind' }
  }

  if (providers.length === 0) {
    return {
      ok: false,
      task: parsed.data,
      reason: 'no_providers',
      detail: 'no model provider is configured'
    }
  }

  const ceiling = options.monthlyBudgetUsd
  const hasCeiling = typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling >= 0

  for (const provider of providers) {
    if (provider.models.length === 0 || provider.monthlyBudgetUsd === 0) continue
    if (hasCeiling && provider.monthlyBudgetUsd !== undefined && provider.monthlyBudgetUsd > ceiling) continue

    return {
      ok: true,
      task: parsed.data,
      provider,
      model: provider.defaultModel ?? provider.models[0]!,
      monthlyBudgetUsd: provider.monthlyBudgetUsd ?? null
    }
  }

  return {
    ok: false,
    task: parsed.data,
    reason: 'no_eligible_provider',
    detail: 'no configured provider satisfies the budget constraints'
  }
}
