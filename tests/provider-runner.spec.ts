import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { runRouted } from '../src/app/provider-runner.ts'
import { Usage } from '../src/usage/service.ts'
import type { UsageOwner, ModelPrice } from '../src/usage/model.ts'
import type { RouteCandidate } from '../src/security/model-routing.ts'
import type { ExecutionTransport } from '../src/security/provider-execution.ts'

const owner: UsageOwner = { sessionId: 'master', root: 'master', role: 'orchestrator' }
const price: ModelPrice = { provider: 'fixture', model: 'current', input: 1_000_000, output: 3_000_000, cacheRead: 100_000, cacheWrite: 2_000_000, note: 'Synthetic test rates' }
const candidate: RouteCandidate = { provider: { id: 'openai-compatible', baseUrl: 'https://fixture.test/v1', models: ['current'] }, model: 'current', monthlyBudgetUsd: 10 }
const request = { task: 'coding' as const, input: { prompt: 'hi' } }

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.restoreAllMocks() })

function usageFixture(calls?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-runner-')), store = new Store(join(directory, 'state.sqlite'))
  const usage = new Usage(store)
  const config = usage.configuration()
  usage.configure({ requestId: 'config-0', revision: config.revision, prices: [price],
    budgets: calls === undefined ? [] : [{ id: 'limit', title: 'Limit', scope: { kind: 'workspace' }, period: 'month', enabled: true, calls }] })
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return usage
}

describe('runRouted', () => {
  it('reserves and reports one successful attempt in usage', async () => {
    const usage = usageFixture()
    const transport: ExecutionTransport = { execute: vi.fn(async () => ({ output: 'ok', reported: { inputTokens: 10, outputTokens: 5 } })) }
    const outcome = await runRouted([candidate], request, transport, { usage, owner, purpose: 'test' })
    expect(outcome).toMatchObject({ ok: true, candidate })
    const page = usage.page()
    expect(page.totals).toMatchObject({ calls: 1, tokens: 15, pending: 0 })
    expect(page.calls[0]).toMatchObject({ provider: 'openai-compatible', model: 'current', phase: 'reported', totalTokens: 15 })
  })

  it('settles a failed attempt and reports the fallback success', async () => {
    const usage = usageFixture()
    const second: RouteCandidate = { ...candidate, provider: { id: 'deepseek', baseUrl: 'https://fixture.test/v2', models: ['other'] }, model: 'other' }
    const transport: ExecutionTransport = { execute: vi.fn(async value => {
      if (value.provider.id === 'openai-compatible') throw new Error('down')
      return { output: 'second', reported: { inputTokens: 1, outputTokens: 1 } }
    }) }
    const outcome = await runRouted([candidate, second], request, transport, { usage, owner, purpose: 'test' })
    expect(outcome).toMatchObject({ ok: true, candidate: second })
    const calls = usage.page().calls
    expect(calls).toHaveLength(2)
    expect(calls.find(call => call.provider === 'openai-compatible')?.phase).toBe('unknown')
    expect(calls.find(call => call.provider === 'deepseek')?.phase).toBe('reported')
  })

  it('falls through when a later reservation is refused by a call budget', async () => {
    const usage = usageFixture(1)
    const second: RouteCandidate = { ...candidate, provider: { id: 'deepseek', baseUrl: 'https://fixture.test/v2', models: ['other'] }, model: 'other' }
    const transport: ExecutionTransport = { execute: vi.fn(async () => { throw new Error('down') }) }
    const outcome = await runRouted([candidate, second], request, transport, { usage, owner, purpose: 'test' })
    expect(outcome).toMatchObject({ ok: false, detail: 'exhausted' })
    if (!outcome.ok) expect(outcome.attempts.map(attempt => attempt.provider)).toEqual(['openai-compatible', 'deepseek'])
    expect(usage.page().totals.calls).toBe(1)
  })
})
