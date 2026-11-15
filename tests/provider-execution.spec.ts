import { describe, expect, it, vi } from 'vitest'
import { executeRoute, type ExecutionReservation, type ExecutionTransport } from '../src/security/provider-execution.ts'
import type { RouteCandidate } from '../src/security/model-routing.ts'
import type { ProviderConfig } from '../src/security/providers.ts'

const provider = (id: ProviderConfig['id'], model: string): RouteCandidate => ({
  provider: { id, baseUrl: 'https://example.test/v1', models: [model] },
  model,
  monthlyBudgetUsd: 10
})

const first = provider('openai', 'first-model')
const second = provider('deepseek', 'second-model')
const request = { task: 'coding' as const, input: { prompt: 'hello' } }

function reservation() {
  return { settle: vi.fn() }
}

describe('executeRoute', () => {
  it('returns the first successful candidate without trying later ones', async () => {
    const transport: ExecutionTransport = { execute: vi.fn(async () => ({ output: 'ok', reported: { inputTokens: 3 } })) }
    const reserve = vi.fn(() => reservation())
    const outcome = await executeRoute([first, second], request, transport, { reserve })
    expect(outcome).toMatchObject({ ok: true, candidate: first, result: { output: 'ok' }, attempts: [{ provider: 'openai', ok: true }] })
    expect(transport.execute).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledTimes(1)
  })

  it('falls back in order after a failed attempt and settles both reservations', async () => {
    const failed = reservation(), succeeded = reservation()
    const calls: string[] = []
    const transport: ExecutionTransport = { execute: vi.fn(async candidate => {
      calls.push(candidate.provider.id)
      if (candidate.provider.id === 'openai') throw new Error('provider unavailable')
      return { output: 'second', reported: { outputTokens: 2 } }
    }) }
    const reserve = vi.fn((candidate: RouteCandidate) => candidate.provider.id === 'openai' ? failed : succeeded)
    const outcome = await executeRoute([first, second], request, transport, { reserve })
    expect(outcome).toMatchObject({
      ok: true,
      candidate: second,
      attempts: [
        { provider: 'openai', model: 'first-model', ok: false, error: 'provider unavailable' },
        { provider: 'deepseek', model: 'second-model', ok: true }
      ]
    })
    expect(calls).toEqual(['openai', 'deepseek'])
    expect(failed.settle).toHaveBeenCalledWith('failed')
    expect(succeeded.settle).toHaveBeenCalledWith('completed', { outputTokens: 2 })
  })

  it('returns exhausted with every attempt when all candidates fail', async () => {
    const transport: ExecutionTransport = { execute: vi.fn(async () => { throw new Error('down') }) }
    const outcome = await executeRoute([first, second], request, transport)
    expect(outcome).toMatchObject({
      ok: false,
      detail: 'exhausted',
      attempts: [
        { provider: 'openai', ok: false, error: 'down' },
        { provider: 'deepseek', ok: false, error: 'down' }
      ]
    })
  })

  it('returns no_candidates without calling the transport', async () => {
    const transport: ExecutionTransport = { execute: vi.fn() }
    const outcome = await executeRoute([], request, transport)
    expect(outcome).toEqual({ ok: false, detail: 'no_candidates', attempts: [] })
    expect(transport.execute).not.toHaveBeenCalled()
  })

  it('stops before the first attempt when already aborted', async () => {
    const controller = new AbortController(); controller.abort()
    const transport: ExecutionTransport = { execute: vi.fn() }
    const outcome = await executeRoute([first], request, transport, { signal: controller.signal })
    expect(outcome).toEqual({ ok: false, detail: 'aborted', attempts: [] })
    expect(transport.execute).not.toHaveBeenCalled()
  })

  it('reports aborted when the signal fires during an attempt and settles the reservation', async () => {
    const controller = new AbortController()
    const held = reservation()
    const transport: ExecutionTransport = { execute: vi.fn(async () => {
      controller.abort()
      throw new Error('aborted by caller')
    }) }
    const outcome = await executeRoute([first], request, transport, { signal: controller.signal, reserve: () => held })
    expect(outcome).toEqual({ ok: false, detail: 'aborted', attempts: [{ provider: 'openai', model: 'first-model', ok: false, error: 'aborted by caller' }] })
    expect(held.settle).toHaveBeenCalledWith('failed')
  })

  it('reports each attempt through onAttempt in order', async () => {
    const seen: string[] = []
    const transport: ExecutionTransport = { execute: vi.fn(async candidate => {
      if (candidate.provider.id === 'openai') throw new Error('no')
      return { output: 'ok' }
    }) }
    await executeRoute([first, second], request, transport, { onAttempt: attempt => seen.push(`${attempt.provider}:${attempt.ok}`) })
    expect(seen).toEqual(['openai:false', 'deepseek:true'])
  })
})
