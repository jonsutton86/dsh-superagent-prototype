import { LlmError } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { safeLaunchFailure, safeWorkerFailure, WorkerFailureFence, type WorkerFailureIdentity } from '../src/executor/failure.ts'

const secret = 'private-provider-body https://private.example/token=secret'
const carried = (code: string, fields: Record<string, unknown> = {}) => Object.assign(new Error(secret), { code, failure: { code, message: secret, ...fields } })

it('reads both the installed-style carried shape and the pinned SDK LlmError without exposing private facts', () => {
  for (const error of [carried('SERVER', { status: 503, requestId: secret }), new LlmError(secret, 'SERVER', { status: 503 })]) {
    const result = safeWorkerFailure(error)
    expect(result).toMatchObject({ code: 'SERVER', retryable: true })
    expect(JSON.stringify(result)).not.toMatch(/private|token|secret|https/)
    expect(result.summary.length).toBeLessThan(120)
  }
})

it('keeps classification separate from recovery authority and excludes terminal configuration, quota and cancellation failures', () => {
  for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) expect(safeWorkerFailure(carried(code)).retryable).toBe(true)
  expect(safeWorkerFailure(carried('HTTP_408', { status: 408 })).retryable).toBe(true)
  expect(safeWorkerFailure(carried('HTTP_408')).retryable).toBe(false)
  expect(safeWorkerFailure(carried('SERVER', { status: 401 })).retryable).toBe(false)
  for (const code of ['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_CONFIG', 'ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'EMPTY_RESPONSE', 'STREAM_CLOSED']) {
    expect(safeWorkerFailure(carried(code, { status: 429 })).retryable).toBe(false)
  }
})

it('refuses untyped text, raw status, mismatched facts and malformed typed fields', () => {
  for (const error of [new Error('429 ECONNRESET rate limit'), { status: 503 }, { code: 'SERVER', failure: { code: 'SERVER' } },
    Object.assign(new Error(), { code: 'SERVER', failure: { code: 'AUTH' } }), carried(secret), carried('SERVER', { status: 600 }),
    carried('SERVER', { status: '503' }), carried('SERVER', { providerRetryAfterMs: -1 }), carried('SERVER', { providerRetryAfterMs: Infinity })]) {
    expect(safeWorkerFailure(error)).toMatchObject({ code: 'UNKNOWN', retryable: false })
  }
})

it('does not invoke private error accessors, coercions or hostile descriptor traps', () => {
  const trap = vi.fn(() => { throw new Error('must not read') })
  const error = carried('SERVER')
  Object.defineProperty(error, 'message', { get: trap }); Object.defineProperty(error, 'cause', { get: trap })
  Object.defineProperty(error.failure, 'requestId', { get: trap }); Object.defineProperty(error.failure, 'message', { get: trap })
  expect(safeWorkerFailure(error)).toMatchObject({ code: 'SERVER', retryable: true })
  const accessor = new Error(); Object.defineProperty(accessor, 'code', { get: trap })
  expect(safeWorkerFailure(accessor).code).toBe('UNKNOWN')
  const malicious = { toString: trap, valueOf: trap }
  expect(safeWorkerFailure(malicious).code).toBe('UNKNOWN'); expect(safeLaunchFailure(malicious).retryable).toBe(false)
  expect(safeWorkerFailure(new Proxy(new Error(), { getOwnPropertyDescriptor: trap })).code).toBe('UNKNOWN')
  expect(trap).toHaveBeenCalledTimes(1) // descriptor trap is contained; none of the accessors/coercions ran
})

it('permits only typed launch transport codes and bounded HTTP statuses, without upgrading malformed model errors', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']) {
    expect(safeLaunchFailure(Object.assign(new Error(secret), { code }))).toMatchObject({ code, retryable: true })
  }
  for (const status of [408, 429, 500, 503, 599]) expect(safeLaunchFailure({ status })).toMatchObject({ code: `HTTP_${status}`, retryable: true })
  for (const error of [{ status: 600 }, { status: 401 }, { status: '503' }, { code: 'UND_ERR_INVALID_ARG' }, new Error('HTTP 503 ECONNRESET'),
    { status: 401, code: 'ECONNRESET' }, { status: '503', code: 'ETIMEDOUT' },
    Object.assign(carried('AUTH'), { status: 503 }), Object.assign(carried('UNKNOWN'), { status: 503 }),
    Object.assign(carried('SERVER', { code: 'AUTH' }), { code: 'ECONNRESET' })]) expect(safeLaunchFailure(error).retryable).toBe(false)
})

function fixture() {
  const agent = {}, session = {}, signal = new AbortController()
  let current: WorkerFailureIdentity<object, object> | undefined = { agent, session, assignmentId: 'assignment-a' }
  const fence = new WorkerFailureFence(() => current)
  return { agent, session, signal, fence, set: (value: typeof current) => { current = value } }
}

it('binds the request to its original turn and consumes a terminal failure once despite duplicate events', () => {
  const { agent, session, signal, fence } = fixture()
  expect(fence.request(agent, session, 'assignment-a', 1, 1, signal.signal)).toBe(false)
  expect(fence.beginTurn(agent, session, 'assignment-a', 1)).toBe(true)
  expect(fence.request(agent, session, 'assignment-a', 1, 1, signal.signal)).toBe(true)
  expect(fence.request(agent, session, 'assignment-a', 1, 2, new AbortController().signal)).toBe(false)
  expect(fence.request(agent, session, 'assignment-a', 1, 1, signal.signal)).toBe(true) // Harness inner retry, same turn/step
  expect(fence.consume(agent, session, 'assignment-a', 1, 1)).toBe(true)
  expect(fence.beginTurn(agent, session, 'assignment-a', 1)).toBe(false)
  expect(fence.request(agent, session, 'assignment-a', 1, 2, signal.signal)).toBe(false)
  expect(fence.consume(agent, session, 'assignment-a', 1, 1)).toBe(false)
})

it('refuses stale or unrelated registered Agent, Session, assignment and step identities', () => {
  const { agent, session, signal, fence, set } = fixture()
  fence.beginTurn(agent, session, 'assignment-a', 7); fence.request(agent, session, 'assignment-a', 7, 2, signal.signal)
  expect(fence.consume(agent, session, 'assignment-a', 7, 1)).toBe(false)
  set({ agent: {}, session, assignmentId: 'assignment-a' })
  expect(fence.consume(agent, session, 'assignment-a', 7, 2)).toBe(false)
  set({ agent, session: {}, assignmentId: 'assignment-a' })
  expect(fence.consume(agent, session, 'assignment-a', 7, 2)).toBe(false)
  set({ agent, session, assignmentId: 'assignment-b' })
  expect(fence.request(agent, session, 'assignment-b', 7, 2, signal.signal)).toBe(false)
  expect(fence.beginTurn(agent, session, 'assignment-b', 7)).toBe(false)
  expect(fence.consume(agent, session, 'assignment-b', 7, 2)).toBe(false)
  expect(fence.consume(agent, session, 'assignment-a', 7, 2)).toBe(false)
  expect(fence.beginTurn(agent, session, 'assignment-b', 8)).toBe(true)
  expect(fence.request(agent, session, 'assignment-b', 8, 1, new AbortController().signal)).toBe(true)
  expect(fence.consume(agent, session, 'assignment-b', 8, 1)).toBe(true)
})

it('refuses cancelled, closed, retired or disposed turn callbacks and permits the next live turn', () => {
  const { agent, session, signal, fence, set } = fixture()
  fence.beginTurn(agent, session, 'assignment-a', 1); fence.request(agent, session, 'assignment-a', 1, 1, signal.signal)
  signal.abort(); expect(fence.consume(agent, session, 'assignment-a', 1, 1)).toBe(false)
  expect(fence.request(agent, session, 'assignment-a', 1, 1, new AbortController().signal)).toBe(false)
  expect(fence.endTurn(agent, session, 'assignment-a', 1)).toBe(true)
  expect(fence.beginTurn(agent, session, 'assignment-a', 2)).toBe(true)
  fence.request(agent, session, 'assignment-a', 2, 1, new AbortController().signal)
  fence.endTurn(agent, session, 'assignment-a', 2)
  expect(fence.consume(agent, session, 'assignment-a', 2, 1)).toBe(false)
  expect(fence.beginTurn(agent, session, 'assignment-a', 2)).toBe(false)
  fence.retire(agent); expect(fence.beginTurn(agent, session, 'assignment-a', 3)).toBe(false)
  fence.clear(); expect(fence.consume(agent, session, 'assignment-a', 2, 1)).toBe(false)
  expect(fence.beginTurn(agent, session, 'assignment-a', 3)).toBe(false)
  set(undefined); expect(fence.beginTurn(agent, session, 'assignment-a', 3)).toBe(false)
})

it('rejects invalid positions and unavailable current identity without mutating a valid binding', () => {
  const { agent, session, signal, fence } = fixture()
  for (const turn of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(fence.beginTurn(agent, session, 'assignment-a', turn)).toBe(false)
  fence.beginTurn(agent, session, 'assignment-a', 1)
  for (const step of [0, -1, 0.5, Infinity]) expect(fence.request(agent, session, 'assignment-a', 1, step, signal.signal)).toBe(false)
  expect(fence.request(agent, session, 'assignment-a', 1, 1, signal.signal)).toBe(true)
  expect(fence.consume(agent, session, 'assignment-a', 1, 1)).toBe(true)
  const unavailable = new WorkerFailureFence(() => { throw new Error(secret) })
  expect(unavailable.beginTurn(agent, session, 'assignment-a', 1)).toBe(false)
})

it('records a pre-request terminal hold at step zero only for its exact live original turn', () => {
  const { agent, session, fence, set } = fixture()
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 0)).toBe(false)
  fence.beginTurn(agent, session, 'assignment-a', 1)
  expect(fence.consumeRequest(agent, session, 'assignment-a', 1, 0)).toBe(false)
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 1)).toBe(false)
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 0)).toBe(true)
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 0)).toBe(false)
  fence.beginTurn(agent, session, 'assignment-a', 2)
  set({ agent, session, assignmentId: 'assignment-b' })
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 2, 0)).toBe(false)
  expect(fence.consumeTerminal(agent, session, 'assignment-b', 2, 0)).toBe(false)
})

it('anchors later assembly failures to step/start without fabricating an unobserved model request', () => {
  const { agent, session, signal, fence } = fixture()
  expect(fence.beginStep(agent, session, 'assignment-a', 1, 1)).toBe(false)
  fence.beginTurn(agent, session, 'assignment-a', 1)
  fence.beginStep(agent, session, 'assignment-a', 1, 1)
  fence.request(agent, session, 'assignment-a', 1, 1, signal.signal)
  expect(fence.beginStep(agent, session, 'assignment-a', 1, 2)).toBe(true)
  expect(fence.beginStep(agent, session, 'assignment-a', 1, 2)).toBe(false)
  expect(fence.consumeRequest(agent, session, 'assignment-a', 1, 2)).toBe(false)
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 1)).toBe(false)
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 3)).toBe(false)
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 2)).toBe(true)
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 2)).toBe(false)
})

it('uses the prior phase step for later preStep failure and rejects cancelled or closed terminal callbacks', () => {
  const { agent, session, fence } = fixture()
  fence.beginTurn(agent, session, 'assignment-a', 1)
  fence.request(agent, session, 'assignment-a', 1, 1, new AbortController().signal)
  // Harness increments phase.step only after preStep succeeds, so a later preStep error still reports step one.
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 1, 1)).toBe(true)
  fence.beginTurn(agent, session, 'assignment-a', 2)
  const cancelled = new AbortController()
  fence.request(agent, session, 'assignment-a', 2, 1, cancelled.signal)
  fence.beginStep(agent, session, 'assignment-a', 2, 2); cancelled.abort()
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 2, 2)).toBe(false)
  fence.beginTurn(agent, session, 'assignment-a', 3)
  fence.endTurn(agent, session, 'assignment-a', 3)
  expect(fence.consumeTerminal(agent, session, 'assignment-a', 3, 0)).toBe(false)
})
