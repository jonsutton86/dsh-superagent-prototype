import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/supervision/evaluation-probe.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture(maxRequests = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'supervision-probe-')), trace = join(dir, 'trace')
  writeFileSync(trace, '', { mode: 0o600 }); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const hooks = new Map<string, (...args: any[]) => any>()
  const ctx = { on: (name: string, handler: (...args: any[]) => any) => hooks.set(name, handler),
    provide: () => {},
    effect: (run: () => () => void) => cleanup.push(run()) } as unknown as Context
  apply(ctx, { trace, sessionId: 'watchdog-test', maxRequests, expectedContract: '1'.repeat(64) })
  hooks.get('superagent/watchdog-contract')!({ sessionId: 'watchdog-test', version: 1, digest: '1'.repeat(64) })
  const events = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const consume = async (next: () => AsyncIterable<any>, sessionId = 'watchdog-test') => {
    const result = []; for await (const chunk of hooks.get('llm/stream')!({ sessionId }, next)) result.push(chunk); return result
  }
  return { events, consume, hooks, trace }
}
it('caps actual stream admission before the adapter and keeps only final usage metadata', async () => {
  const f = fixture(), content = 'private response text', chunks = [{ type: 'text_delta', text: content }, { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 4 } }, { type: 'finish', reason: { kind: 'stop' } }]
  let dispatched = 0
  const next = async function* () { dispatched++; yield* chunks }
  expect(await f.consume(next)).toEqual(chunks)
  await expect(f.consume(next)).rejects.toThrow('evaluation_request_limit')
  expect(dispatched).toBe(1)
  expect(f.events()).toEqual([expect.objectContaining({ type: 'contract_verified' }), expect.objectContaining({ type: 'request', ordinal: 1 }),
    expect.objectContaining({ type: 'settled', ordinal: 1, terminal: true, usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 4 } }), expect.objectContaining({ type: 'request_limit' })])
  expect(readFileSync(f.trace, 'utf8')).not.toContain(content)
})
it('preserves interrupted usage as partial and never persists provider errors or arbitrary tool names', async () => {
  const f = fixture()
  await expect(f.consume(async function* () { yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; throw new Error('private key/body') })).rejects.toThrow('private key/body')
  f.hooks.get('session/event')!({ id: 'watchdog-test' }, { type: 'tool/call', data: { name: 'secret-command', arguments: 'private arguments' } })
  f.hooks.get('session/event')!({ id: 'other' }, { type: 'tool/call', data: { name: 'watchdog_assess' } })
  f.hooks.get('agent/error')!({ agent: { id: 'watchdog-test' }, error: new Error('private key/body') })
  expect(f.events()).toContainEqual(expect.objectContaining({ type: 'settled', terminal: false, usage: { inputTokens: 2, outputTokens: 1 } }))
  expect(f.events()).toContainEqual(expect.objectContaining({ type: 'tool', name: 'other' }))
  expect(readFileSync(f.trace, 'utf8')).not.toMatch(/private|secret-command/)
})
it('refuses ambient inference outside the exact evaluation Session before provider dispatch', async () => {
  const f = fixture(); let invoked = false
  await expect(f.consume(async function* () { invoked = true; yield {} }, 'unrelated')).rejects.toThrow('evaluation_session_refused')
  expect(invoked).toBe(false); expect(f.events()).toContainEqual(expect.objectContaining({ type: 'scope_refused' }))
})
it('refuses model attempts when the actual compiled watchdog contract differs', async () => {
  const f = fixture(); let invoked = false
  f.hooks.get('superagent/watchdog-contract')!({ sessionId: 'watchdog-test', version: 1, digest: '2'.repeat(64) })
  await expect(f.consume(async function* () { invoked = true; yield {} })).rejects.toThrow('evaluation_contract_unverified')
  expect(invoked).toBe(false)
  expect(f.events().filter(event => event.type === 'request')).toEqual([])
})
it('records missing/malformed usage as unknown rather than inventing zero counters', async () => {
  const f = fixture()
  await f.consume(async function* () { yield { type: 'usage', usage: { inputTokens: -1, outputTokens: 3 } }; yield { type: 'finish', reason: { kind: 'stop' } } })
  expect(f.events().at(-1)).toMatchObject({ type: 'settled', terminal: true, usage: null })
})
it.each(['error', 'aborted'])('refuses synthetic zero usage on a %s finish', async kind => {
  const f = fixture()
  await f.consume(async function* () {
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind, failure: { message: 'private provider text' } } }
  })
  expect(f.events().at(-1)).toMatchObject({ type: 'settled', terminal: false, usage: null })
  expect(readFileSync(f.trace, 'utf8')).not.toContain('private')
})
it('retains positive partial usage before a synthetic zero failure snapshot', async () => {
  const f = fixture()
  await f.consume(async function* () {
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'error' } }
  })
  expect(f.events().at(-1)).toMatchObject({ type: 'settled', terminal: false, usage: { inputTokens: 5, outputTokens: 2 } })
})
it('bounds forwarded model content and refuses further attempts after a capacity failure', async () => {
  const f = fixture(4); let dispatched = 0
  const huge = async function* () { dispatched++; yield { type: 'text_delta', text: 'x'.repeat(1024 * 1024) } }
  await expect(f.consume(huge)).rejects.toThrow('evaluation_stream_limit')
  await expect(f.consume(huge)).rejects.toThrow('evaluation_stream_limit')
  expect(dispatched).toBe(1)
  expect(f.events()).toContainEqual(expect.objectContaining({ type: 'stream_limit' }))
  expect(f.events()).toContainEqual(expect.objectContaining({ type: 'settled', terminal: false, usage: null }))
  expect(readFileSync(f.trace, 'utf8').length).toBeLessThan(1000)
})
it('records whitelisted turn termination reasons without error messages', () => {
  const f = fixture()
  f.hooks.get('session/event')!({ id: 'watchdog-test' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens', message: 'private provider text' } } })
  expect(f.events().at(-1)).toMatchObject({ type: 'turn/end', turn: 1, reason: 'max-tokens' })
  expect(readFileSync(f.trace, 'utf8')).not.toContain('private')
})
