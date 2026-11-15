import { describe, expect, it } from 'vitest'
import { routeProvider, TaskKind } from '../src/security/model-routing.ts'
import type { ProviderConfig } from '../src/security/providers.ts'

const first: ProviderConfig = {
  id: 'openai',
  baseUrl: 'https://example.com/v1',
  models: ['first-model', 'preferred-model'],
  monthlyBudgetUsd: 20
}

const second: ProviderConfig = {
  id: 'deepseek',
  baseUrl: 'https://example.org/v1',
  models: ['second-model'],
  monthlyBudgetUsd: 10
}

const undeclared: ProviderConfig = {
  id: 'openai-compatible',
  baseUrl: 'https://example.net/v1',
  models: ['local-model']
}

describe('routeProvider', () => {
  it.each(['unknown', '', 42, null, undefined, {}])('refuses invalid task %s before provider selection', task => {
    expect(routeProvider([], task)).toEqual({
      ok: false,
      task: String(task),
      reason: 'invalid_task',
      detail: 'unknown task kind'
    })
  })

  it('refuses an empty provider list', () => {
    expect(routeProvider([], 'coding')).toEqual({
      ok: false,
      task: 'coding',
      reason: 'no_providers',
      detail: 'no model provider is configured'
    })
  })

  it('skips zero-budget providers and selects the next provider', () => {
    expect(routeProvider([{ ...first, monthlyBudgetUsd: 0 }, second], 'coding')).toEqual({
      ok: true,
      task: 'coding',
      provider: second,
      model: 'second-model',
      monthlyBudgetUsd: 10
    })
  })

  it('refuses when no provider satisfies the ceiling', () => {
    expect(routeProvider([first, second], 'fast', { monthlyBudgetUsd: 5 })).toEqual({
      ok: false,
      task: 'fast',
      reason: 'no_eligible_provider',
      detail: 'no configured provider satisfies the budget constraints'
    })
  })

  it('prefers the default model', () => {
    const provider: ProviderConfig = { ...first, defaultModel: 'preferred-model' }
    expect(routeProvider([provider], 'reasoning')).toEqual({
      ok: true,
      task: 'reasoning',
      provider,
      model: 'preferred-model',
      monthlyBudgetUsd: 20
    })
  })

  it('uses the first model and preserves first eligible provider order', () => {
    const providers: readonly ProviderConfig[] = [first, second]
    const result = routeProvider(providers, 'coding')
    expect(result).toEqual({
      ok: true,
      task: 'coding',
      provider: first,
      model: 'first-model',
      monthlyBudgetUsd: 20
    })
    if (result.ok) expect(result.provider).toBe(first)
    expect(providers).toEqual([first, second])
  })

  it('skips providers above the ceiling and includes its exact boundary', () => {
    expect(routeProvider([first, second], 'coding', { monthlyBudgetUsd: 10 })).toEqual({
      ok: true,
      task: 'coding',
      provider: second,
      model: 'second-model',
      monthlyBudgetUsd: 10
    })
  })

  it.each([0, 5])('allows an undeclared budget under ceiling %s with null', monthlyBudgetUsd => {
    expect(routeProvider([first, undeclared], 'summarize', { monthlyBudgetUsd })).toEqual({
      ok: true,
      task: 'summarize',
      provider: undeclared,
      model: 'local-model',
      monthlyBudgetUsd: null
    })
  })

  it.each([-1, NaN, Infinity, -Infinity])('ignores invalid ceiling %s', monthlyBudgetUsd => {
    expect(routeProvider([first, second], 'fast', { monthlyBudgetUsd })).toEqual(
      routeProvider([first, second], 'fast')
    )
  })

  it.each(['reasoning', 'coding', 'summarize', 'fast'] as const)('accepts task %s without changing selection', task => {
    expect(TaskKind.safeParse(task).success).toBe(true)
    expect(routeProvider([first, second], task)).toEqual({
      ok: true,
      task,
      provider: first,
      model: 'first-model',
      monthlyBudgetUsd: 20
    })
  })
})
