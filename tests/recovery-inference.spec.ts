import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ReasoningEffortId, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { inferenceConfigurationCheck, recoveryInferenceHost, type RecoveryInferenceHost } from '../src/recovery/inference.ts'
import { exportSession, type SessionArchive } from '../src/recovery/sessions.ts'
import { inferenceFixture } from './fixtures/inference.ts'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-inference-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Jsonl, { root: join(directory, 'sessions'), compression: 'none' })
  const inference = await inferenceFixture(ctx), store = new Store(join(directory, 'state.sqlite')); cleanup.push(() => store.close())
  const archives: SessionArchive[] = [], abort = new AbortController()
  const session = async (id: string, populate: (value: Session) => void = () => {}, extra: Partial<SessionHeader> = {}) => {
    const value = Session.create(SessionId(id)); value.append('turn/start', { turn: 1 }); value.append('step/start', { turn: 1, step: 1 }); populate(value)
    const writer = await ctx.sessionPersistence.create({ ...value.header, ...extra })
    await writer.append(value.snapshotEvents())
    const member = id + '.jsonl'
    try { archives.push(await exportSession(writer, join(directory, member), member, abort.signal)) } finally { await writer.close() }
  }
  const check = () => inferenceConfigurationCheck(inference.host, store.db, directory, archives, 'master', abort.signal)
  return { ...inference, ctx, directory, store, archives, abort, session, check }
}

it('deduplicates effective routes, uses real Harness dispatch, and sends no history, tools or Session identity', async () => {
  const f = await fixture(); await f.session('master', session => session.append('request/header', {
    header: { config: { provider: 'fixture', model: 'current' } }, reason: 'initial' }))
  const check = await f.check(), first = await check.verify()
  expect(first).toMatchObject({ routes: 1, sessions: 1, selections: expect.stringMatching(/^[a-f0-9]{64}$/), resolved: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(await check.verify()).toEqual(first)
  expect(f.adapter.calls).toHaveLength(2)
  for (const call of f.adapter.calls) {
    expect(call.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }])
    expect(call.maxTokens).toBe(64); expect(call.tools).toBeUndefined(); expect(call.sessionId).toBeUndefined()
    expect(call.signal?.aborted).toBe(true)
  }
})
it('resolves optional inference services from a maintenance fiber without requiring them for offline work', async () => {
  const f = await fixture(); await f.session('master')
  f.ctx.reflect.provide('sessionProjections', f.host.projections)
  f.ctx.reflect.provide('agentDefaultModel', { currentSelection: f.host.currentSelection })
  let host: RecoveryInferenceHost | undefined
  await f.ctx.plugin({ name: 'inference-maintenance', inject: ['sessionPersistence'], apply(ctx: Context) {
    expect(() => ctx.llm).toThrow('without inject')
    host = recoveryInferenceHost(ctx)
  } })
  const check = await inferenceConfigurationCheck(host!, f.store.db, f.directory, f.archives, 'master', f.abort.signal)
  expect((await check.verify()).routes).toBe(1)
})
it('uses a pending selection after a different request header and never probes retired historical routes', async () => {
  const f = await fixture(); await f.session('master', session => {
    session.append('request/header', { header: { config: { provider: 'retired', model: 'old' } }, reason: 'initial' })
    session.append('model/selection', { provider: 'fixture', model: 'next' })
    session.append('request/header', { header: { config: { provider: 'retired', model: 'old' } }, reason: 'resume' })
  })
  expect((await (await f.check()).verify()).routes).toBe(2)
  expect(f.adapter.calls.map(call => call.model).sort()).toEqual(['current', 'next'])
})
it('folds across archive pages and drops an adapter-default effort after a consumed selection', async () => {
  const f = await fixture(); await f.session('master', session => {
    for (let index = 0; index < 130; index++) session.append('model/selection', { provider: 'fixture', model: 'current', reasoningEffort: ReasoningEffortId('retired-effort') })
    session.append('request/header', { header: { config: { provider: 'fixture', model: 'current', reasoningEffort: ReasoningEffortId('retired-effort') },
      adapterDefaults: { reasoningEffort: true } }, reason: 'initial' })
  })
  expect((await (await f.check()).verify()).routes).toBe(1)
  expect(f.adapter.calls[0]!.reasoningEffort).toBeUndefined()
})
it('checks queued persona and role models, current worker overrides and descendants; skips ended inactive workers', async () => {
  const f = await fixture(); f.store.saveSettings({ executor: { model: { provider: 'fixture', model: 'worker-role' } } })
  const save = (id: string, extra: object = {}) => f.store.db.prepare('INSERT INTO ticket(id,value) VALUES (?,?)').run(id, JSON.stringify({ id, undelivered: [], ...extra }))
  save('queued', { execution: { persona: { definition: { model: { provider: 'fixture', model: 'persona' } } } } })
  save('running'); save('ended', { ended: { by: 'human' } })
  await f.session('master')
  await f.session('worker-running', session => session.append('model/selection', { provider: 'fixture', model: 'override' }))
  await f.session('child', session => session.append('model/selection', { provider: 'fixture', model: 'child' }), { parentSession: SessionId('worker-running') })
  await f.session('worker-ended', session => session.append('model/selection', { provider: 'retired', model: 'unused' }))
  expect((await (await f.check()).verify()).sessions).toBe(3)
  expect(f.adapter.calls.map(call => call.model).sort()).toEqual(['child', 'current', 'override', 'persona', 'worker-role'])
})
it('refuses archive mutation before making any inference request', async () => {
  const f = await fixture(); await f.session('master'); await appendFile(join(f.directory, 'master.jsonl'), '\n')
  await expect(f.check()).rejects.toMatchObject({ code: 'configuration_unavailable' }); expect(f.adapter.calls).toEqual([])
})
it.each(['projection', 'master', 'settings'] as const)('refuses missing authoritative %s input', async kind => {
  const f = await fixture(); if (kind !== 'master') await f.session('master')
  if (kind === 'projection') f.host.projections.restore = () => ({ snapshot: { asOfSeq: -1, values: {} }, checkpoint: {} })
  if (kind === 'settings') f.store.set(KV.settings.revision, 999)
  await expect(f.check()).rejects.toMatchObject({ code: 'configuration_missing' }); expect(f.adapter.calls).toEqual([])
})
it('refuses unavailable routes even when a model catalog is empty and suppresses provider diagnostics', async () => {
  const f = await fixture(); await f.session('master'); const check = await f.check(); f.unregister()
  await expect(check.verify()).rejects.toMatchObject({ code: 'configuration_unavailable', message: 'configuration_unavailable' })
})
it('sanitizes errors from default resolution and inference middleware', async () => {
  const f = await fixture(); await f.session('master')
  const check = await f.check(); f.adapter.before = async () => { throw new Error('synthetic-secret') }
  await expect(check.verify()).rejects.toMatchObject({ message: 'configuration_unavailable' })
  f.host.currentSelection = () => { throw new Error('synthetic-secret') }
  await expect(f.check()).rejects.toMatchObject({ message: 'configuration_unavailable: inference/role-selection' })
})
it('refuses default changes during a probe and between verification passes', async () => {
  const f = await fixture(); await f.session('master'); const check = await f.check()
  await check.verify(); f.select({ provider: 'fixture', model: 'changed' })
  await expect(check.verify()).rejects.toMatchObject({ code: 'configuration_mismatch' })
  const next = await f.check(); f.adapter.before = async () => { f.select({ provider: 'fixture', model: 'changed-again' }) }
  await expect(next.verify()).rejects.toMatchObject({ code: 'configuration_mismatch' })
})
it.each([
  [], [{ type: 'finish', reason: { kind: 'stop' } }],
  [{ type: 'text-delta', index: 0, text: 'OK' }],
  [{ type: 'tool-call-delta', index: 0, id: ToolCallId('tool'), name: 'bash', argumentsDelta: '{}' }],
  [{ type: 'text-delta', index: 0, text: 'OK' }, { type: 'finish', reason: { kind: 'stop' } }, { type: 'text-delta', index: 0, text: 'late' }],
].map(chunks => ({ chunks: chunks as StreamChunk[] })))('rejects incomplete, empty or tool-producing streams (%#)', async ({ chunks }) => {
  const f = await fixture(); await f.session('master'); f.adapter.chunks = chunks
  await expect((await f.check()).verify()).rejects.toMatchObject({ code: 'configuration_unavailable' })
})
it('accepts bounded reasoning progress without demanding an exact model answer', async () => {
  const f = await fixture(); await f.session('master')
  f.adapter.chunks = [{ type: 'reasoning-delta', index: 0, text: 'Ready' }, { type: 'finish', reason: { kind: 'max-tokens' } }]
  expect((await (await f.check()).verify()).routes).toBe(1)
})
it.each(['text', 'reasoning'] as const)('accepts completed %s blocks without requiring delta events', async type => {
  const f = await fixture(); await f.session('master')
  f.adapter.chunks = [{ type: 'block-end', index: 0, block: { type, text: 'OK' } }, { type: 'finish', reason: { kind: 'stop' } }]
  expect((await (await f.check()).verify()).routes).toBe(1)
})
it('bounds a noncooperative provider on caller cancellation', async () => {
  const f = await fixture(); await f.session('master'); const check = await f.check()
  f.adapter.before = async () => { f.abort.abort(); await new Promise(() => {}) }
  await expect(check.verify()).rejects.toMatchObject({ code: 'configuration_unavailable' })
  expect(f.adapter.calls[0]!.signal?.aborted).toBe(true)
})

it('refuses adapter configuration drift between successful probes', async () => {
  const f = await fixture(); await f.session('master'); const check = await f.check(); await check.verify()
  const prepare = f.ctx.llm.prepareCall.bind(f.ctx.llm)
  vi.spyOn(f.ctx.llm, 'prepareCall').mockImplementation(async (...args) => ({ ...await prepare(...args), adapterDefaults: { maxTokens: true } }))
  await expect(check.verify()).rejects.toMatchObject({ code: 'configuration_mismatch' })
})
it('refuses an excessive provider stream even if it eventually finishes successfully', async () => {
  const f = await fixture(); await f.session('master')
  f.adapter.chunks = [{ type: 'text-delta', index: 0, text: 'x'.repeat(262145) }, { type: 'finish', reason: { kind: 'stop' } }]
  await expect((await f.check()).verify()).rejects.toMatchObject({ code: 'configuration_unavailable' })
})
