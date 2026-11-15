/** Ordered fallback execution over an injected provider transport. No transport, network or credentials live here. */
import type { RouteCandidate } from './model-routing.ts'
import type { TaskKind } from './model-routing.ts'

/** A single attempt's request; the transport decides how to build a real provider request. */
export interface ExecutionRequest {
  task: TaskKind
  input: unknown
}

/** What a transport returns for a successful attempt. `reported` is settled into usage accounting by the caller. */
export interface ExecutionResult {
  output: unknown
  reported?: unknown
}

/** Injected provider transport. Implementations are responsible for endpoints, credentials and provider protocols. */
export interface ExecutionTransport {
  execute(candidate: RouteCandidate, request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>
}

/** A caller-supplied reservation (for example `Usage.begin`) that must be settled for every attempted candidate. */
export interface ExecutionReservation {
  settle(outcome: string, reported?: unknown): void
}

/** One attempt, whether it succeeded or failed. */
export interface ExecutionAttempt {
  provider: string
  model: string
  ok: boolean
  error?: string
}

/** Successful fallback outcome: the first candidate that completed. */
export interface ExecutionSuccess {
  ok: true
  candidate: RouteCandidate
  result: ExecutionResult
  attempts: ExecutionAttempt[]
}

/** Exhausted/aborted fallback outcome; every attempted candidate is listed in order. */
export interface ExecutionFailure {
  ok: false
  detail: 'no_candidates' | 'aborted' | 'exhausted'
  attempts: ExecutionAttempt[]
}

/** The outcome of an ordered fallback run. */
export type ExecutionOutcome = ExecutionSuccess | ExecutionFailure

/** Options for one ordered fallback run. */
export interface ExecutionOptions {
  signal?: AbortSignal
  /** Called immediately before each attempt so the caller can reserve budget; settle it in the transport wrapper. */
  reserve?: (candidate: RouteCandidate, request: ExecutionRequest) => ExecutionReservation | undefined
  onAttempt?: (attempt: ExecutionAttempt) => void
}

/**
 * Attempt each candidate in order until one succeeds. Failures and aborts are returned rather than thrown;
 * reservations are settled exactly once per attempted candidate, and no candidate is retried.
 */
export async function executeRoute(
  candidates: readonly RouteCandidate[],
  request: ExecutionRequest,
  transport: ExecutionTransport,
  options: ExecutionOptions = {}
): Promise<ExecutionOutcome> {
  if (candidates.length === 0) return { ok: false, detail: 'no_candidates', attempts: [] }
  const attempts: ExecutionAttempt[] = []
  const signal = options.signal ?? new AbortController().signal

  for (const candidate of candidates) {
    if (signal.aborted) return { ok: false, detail: 'aborted', attempts }
    let reservation: ExecutionReservation | undefined
    try {
      reservation = options.reserve?.(candidate, request)
    } catch (error) {
      const attempt: ExecutionAttempt = { provider: candidate.provider.id, model: candidate.model, ok: false,
        error: error instanceof Error ? error.message : String(error) }
      attempts.push(attempt)
      options.onAttempt?.(attempt)
      continue
    }
    try {
      const result = await transport.execute(candidate, request, signal)
      reservation?.settle('completed', result.reported)
      const attempt: ExecutionAttempt = { provider: candidate.provider.id, model: candidate.model, ok: true }
      attempts.push(attempt)
      options.onAttempt?.(attempt)
      return { ok: true, candidate, result, attempts }
    } catch (error) {
      reservation?.settle('failed')
      const attempt: ExecutionAttempt = {
        provider: candidate.provider.id,
        model: candidate.model,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
      attempts.push(attempt)
      options.onAttempt?.(attempt)
      if (signal.aborted) return { ok: false, detail: 'aborted', attempts }
    }
  }

  return { ok: false, detail: 'exhausted', attempts }
}
