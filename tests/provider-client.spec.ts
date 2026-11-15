import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpProviderTransport } from '../src/security/provider-client.ts'
import type { RouteCandidate } from '../src/security/model-routing.ts'

const candidate: RouteCandidate = {
  provider: { id: 'openai-compatible', baseUrl: 'https://llm.example.test/v1', models: ['model-a'], credential: 'provider-key' },
  model: 'model-a',
  monthlyBudgetUsd: 5
}
const request = { task: 'coding' as const, input: { prompt: 'hello' } }
const signal = new AbortController().signal

afterEach(() => vi.restoreAllMocks())

describe('HttpProviderTransport', () => {
  it('encodes a chat-completions request, reads the credential and maps usage', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'world' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })
    }))
    const transport = new HttpProviderTransport({ fetch: mockFetch as unknown as typeof globalThis.fetch, credentials: { get: () => 'secret-value' } })
    const result = await transport.execute(candidate, request, signal)
    expect(result).toEqual({ output: 'world', reported: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } })
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://llm.example.test/v1/chat/completions')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer secret-value' })
    expect(JSON.parse(String(init.body))).toEqual({ model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: false })
  })

  it('uses explicit messages when supplied', async () => {
    const noCredential = { ...candidate, provider: { ...candidate.provider, credential: undefined } }
    const mockFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }))
    const transport = new HttpProviderTransport({ fetch: mockFetch as unknown as typeof globalThis.fetch })
    await transport.execute(noCredential, { task: 'coding', input: { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] } }, signal)
    const init = (mockFetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body)).messages).toHaveLength(2)
  })

  it('rejects missing credentials, HTTP failures, invalid JSON and empty content', async () => {
    await expect(new HttpProviderTransport({ fetch: vi.fn() as unknown as typeof globalThis.fetch }).execute(candidate, request, signal))
      .rejects.toThrow('credential is unavailable')
    const failed = new HttpProviderTransport({ fetch: vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof globalThis.fetch })
    await expect(failed.execute({ ...candidate, provider: { ...candidate.provider, credential: undefined } }, request, signal))
      .rejects.toThrow('HTTP 503')
    const invalid = new HttpProviderTransport({ fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad') } })) as unknown as typeof globalThis.fetch })
    await expect(invalid.execute({ ...candidate, provider: { ...candidate.provider, credential: undefined } }, request, signal))
      .rejects.toThrow('invalid JSON')
    const empty = new HttpProviderTransport({ fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })) as unknown as typeof globalThis.fetch })
    await expect(empty.execute({ ...candidate, provider: { ...candidate.provider, credential: undefined } }, request, signal))
      .rejects.toThrow('no text content')
  })

  it('refuses malformed input before contacting the provider and reports abort', async () => {
    const fetch = vi.fn()
    const transport = new HttpProviderTransport({ fetch: fetch as unknown as typeof globalThis.fetch, credentials: { get: () => 's' } })
    await expect(transport.execute(candidate, { task: 'coding', input: {} }, signal)).rejects.toThrow('requires prompt or messages')
    expect(fetch).not.toHaveBeenCalled()
    const aborted = new AbortController(); aborted.abort()
    const abortFetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new Error('aborted')
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }
    }) as unknown as typeof globalThis.fetch
    await expect(new HttpProviderTransport({ fetch: abortFetch, credentials: { get: () => 's' } })
      .execute(candidate, request, aborted.signal)).rejects.toThrow('aborted')
  })
})
