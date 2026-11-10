/** Typed failure facts and live request ownership; neither grants permission to retry a worker turn. */
export interface SafeWorkerFailure { code: string; retryable: boolean; summary: string }

const UNKNOWN: Readonly<SafeWorkerFailure> = Object.freeze({ code: 'UNKNOWN', retryable: false,
  summary: 'Worker failed in Harness. Review its provider and execution configuration.' })
const TRANSIENT = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
const KNOWN = new Set([...TRANSIENT, 'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL',
  'NO_ADAPTER', 'UNKNOWN_MODEL', 'INVALID_CONFIG', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED',
  'EMPTY_RESPONSE', 'STREAM_CLOSED', 'INVALID_REPLAY_STATE', 'UNSUPPORTED_CONTENT', 'HTTP_408'])
const INVALID = Symbol('not an own data property')
/** Accessors and coercions on SDK errors must not execute while deriving public failure facts. */
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor === undefined ? undefined : 'value' in descriptor ? descriptor.value : INVALID
}
const httpStatus = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
const transientStatus = (value: number) => value === 408 || value === 429 || value >= 500

/**
 * Read the cross-package LlmError contract: own code and failure.code agree. Never route on message text or causes.
 * `retryable` describes the class, not a second retry policy: Harness owns retries of a model request.
 */
export function safeWorkerFailure(error: unknown): SafeWorkerFailure {
  try {
    if (!(error instanceof Error)) return { ...UNKNOWN }
    const code = own(error, 'code'), failure = own(error, 'failure')
    if (typeof code !== 'string' || !KNOWN.has(code) || typeof failure !== 'object' || failure === null
      || own(failure, 'code') !== code) return { ...UNKNOWN }
    const status = own(failure, 'status'), delay = own(failure, 'providerRetryAfterMs')
    if (status !== undefined && !httpStatus(status)
      || delay !== undefined && (typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0)) return { ...UNKNOWN }
    const retryable = (TRANSIENT.has(code) && (status === undefined || transientStatus(status as number))) || code === 'HTTP_408' && status === 408
    return { code, retryable, summary: code === 'ABORTED' ? 'Harness cancelled the worker request.'
      : code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL' ? 'The worker provider rejected its credential configuration.'
        : code === 'QUOTA' || code === 'ACCOUNT_QUOTA' ? 'The worker provider reported an account quota limit.'
          : retryable ? 'The worker provider request failed; Harness ended this turn.' : 'The worker provider request failed. Review its model and execution configuration.' }
  } catch { return { ...UNKNOWN } }
}

// Node system codes and undici's concrete timeout/socket codes; no message or UND_ERR_* wildcard matching.
const LAUNCH_TRANSPORT = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])
/** Typed pre-inference launch failures, kept separate from terminal worker model failures. */
export function safeLaunchFailure(error: unknown): SafeWorkerFailure {
  const worker = safeWorkerFailure(error)
  if (worker.code !== 'UNKNOWN') return { ...worker, summary: worker.retryable
    ? 'A temporary provider or connection failure interrupted worker launch.' : worker.summary }
  try {
    if (typeof error !== 'object' || error === null) return { ...UNKNOWN }
    // A malformed or nonretryable typed model error cannot acquire permission from an unrelated status/code fallback.
    if (Object.getOwnPropertyDescriptor(error, 'failure') !== undefined) return { ...UNKNOWN }
    const status = own(error, 'status'), code = own(error, 'code')
    if (status !== undefined) return httpStatus(status) && transientStatus(status)
      ? { code: `HTTP_${status}`, retryable: true, summary: 'A temporary HTTP failure interrupted worker launch.' } : { ...UNKNOWN }
    if (typeof code === 'string' && LAUNCH_TRANSPORT.has(code)) return { code, retryable: true,
      summary: 'A temporary connection failure interrupted worker launch.' }
    return { ...UNKNOWN }
  } catch { return { ...UNKNOWN } }
}

export interface WorkerFailureIdentity<A extends object, S extends object> { agent: A; session: S; assignmentId: string }
interface Turn<S extends object> {
  session: S; assignmentId: string; turn: number; step: number; requestStep?: number; signal?: AbortSignal; open: boolean; consumed: boolean
}
const position = (value: number) => Number.isSafeInteger(value) && value > 0

/**
 * One bounded turn record per live Agent. The host supplies current registry identity, assignment and lifetime checks.
 * Capture at turn/start, then anchor each model request. Never infer ownership from a terminal error's Session ID alone.
 */
export class WorkerFailureFence<A extends object, S extends object> {
  private turns = new WeakMap<A, Turn<S>>()
  private retired = new WeakSet<A>()
  constructor(private readonly current: (agent: A) => WorkerFailureIdentity<A, S> | undefined) {}
  private matches(agent: A, session: S, assignmentId: string): boolean {
    if (this.retired.has(agent) || !assignmentId) return false
    try {
      const current = this.current(agent)
      return current?.agent === agent && current.session === session && current.assignmentId === assignmentId
    } catch { return false }
  }
  beginTurn(agent: A, session: S, assignmentId: string, turn: number): boolean {
    if (!position(turn) || !this.matches(agent, session, assignmentId)) return false
    const previous = this.turns.get(agent)
    if (previous && turn <= previous.turn) return false // duplicate/late turn-start cannot reset consumed identity
    this.turns.set(agent, { session, assignmentId, turn, step: 0, open: true, consumed: false })
    return true
  }
  /** A committed step/start anchors assembly failures before the request waterfall reaches our listener. */
  beginStep(agent: A, session: S, assignmentId: string, turn: number, step: number): boolean {
    const binding = this.binding(agent, session, assignmentId, turn)
    if (!binding || !position(step) || step <= binding.step) return false
    binding.step = step
    return true
  }
  request(agent: A, session: S, assignmentId: string, turn: number, step: number, signal: AbortSignal): boolean {
    const binding = this.binding(agent, session, assignmentId, turn)
    if (!binding || !position(step) || step < binding.step || signal.aborted
      || binding.signal !== undefined && binding.signal !== signal) return false
    binding.step = step; binding.requestStep = step; binding.signal = signal
    return true
  }
  /** Accept one failure only from the still-current, explicitly observed model request and assignment. */
  consumeRequest(agent: A, session: S, assignmentId: string, turn: number, step: number): boolean {
    const binding = this.binding(agent, session, assignmentId, turn)
    if (!binding || !position(step) || binding.step !== step || binding.requestStep !== step || !binding.signal || binding.signal.aborted) return false
    binding.consumed = true
    return true
  }
  /** Compatibility name for the stricter request-only consumer. */
  consume(agent: A, session: S, assignmentId: string, turn: number, step: number): boolean {
    return this.consumeRequest(agent, session, assignmentId, turn, step)
  }
  /**
   * Record a terminal failed hold, including pre-step failures at step zero. This grants no retry authority.
   * Positive steps must have a committed step/start or observed request; never guess a later assembly position.
   */
  consumeTerminal(agent: A, session: S, assignmentId: string, turn: number, step: number): boolean {
    const binding = this.binding(agent, session, assignmentId, turn)
    if (!binding || !Number.isSafeInteger(step) || step < 0 || binding.step !== step || binding.signal?.aborted) return false
    binding.consumed = true
    return true
  }
  /** Preserve the turn floor while refusing late errors after success, cancellation or another terminal outcome. */
  endTurn(agent: A, session: S, assignmentId: string, turn: number): boolean {
    const binding = this.turns.get(agent)
    if (!binding || !binding.open || binding.session !== session || binding.assignmentId !== assignmentId
      || binding.turn !== turn || !this.matches(agent, session, assignmentId)) return false
    binding.open = false
    return true
  }
  retire(agent: A): void { this.retired.add(agent); this.turns.delete(agent) }
  /** The host removes its listeners before clearing all live bindings during disposal. */
  clear(): void { this.turns = new WeakMap() }
  private binding(agent: A, session: S, assignmentId: string, turn: number): Turn<S> | undefined {
    const binding = this.turns.get(agent)
    return binding?.open && !binding.consumed && binding.turn === turn && binding.session === session
      && binding.assignmentId === assignmentId && this.matches(agent, session, assignmentId) ? binding : undefined
  }
}
