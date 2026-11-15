/** Binds ordered fallback execution to model accounting: every attempted candidate reserves and settles a usage call. */
import type { ExecutionOutcome, ExecutionRequest, ExecutionReservation, ExecutionTransport } from '../security/provider-execution.ts'
import { executeRoute } from '../security/provider-execution.ts'
import type { RouteCandidate } from '../security/model-routing.ts'
import type { Usage } from '../usage/service.ts'
import type { UsageOwner } from '../usage/model.ts'

/** One usage reservation for a candidate; `Usage.begin` refuses when its budgets are already exhausted. */
export function usageReservation(usage: Usage, owner: UsageOwner, purpose: string, candidate: RouteCandidate,
  ceiling?: number): ExecutionReservation {
  const call = usage.begin(owner, candidate.provider.id, candidate.model, purpose, ceiling)
  return { settle: (outcome, reported) => usage.settle(call.id, outcome, reported) }
}

/** Run the ordered candidates with a usage reservation per attempt. A refused reservation falls through to the next candidate. */
export async function runRouted(candidates: readonly RouteCandidate[], request: ExecutionRequest, transport: ExecutionTransport,
  options: { usage: Usage; owner: UsageOwner; purpose: string; ceiling?: number; signal?: AbortSignal }): Promise<ExecutionOutcome> {
  return executeRoute(candidates, request, transport, {
    signal: options.signal,
    reserve: candidate => usageReservation(options.usage, options.owner, options.purpose, candidate, options.ceiling)
  })
}
