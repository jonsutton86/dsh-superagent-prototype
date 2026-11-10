import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { abliterationPatch, abliterationProvider, ABLITERATION_LIMITS, ABLITERATION_MODELS } from '../src/providers/abliteration-config.ts'
import { assertAbliterationRequest, installAbliterationGuard } from '../src/providers/abliteration-guard.ts'
import { inspectAbliterationModels } from '../src/providers/abliteration-smoke.ts'
import { InferenceAdapter } from './fixtures/inference.ts'
import { startRuntime } from './fixtures/host.ts'
import { Store } from '../src/app/store.ts'
import { Personas } from '../src/personas/service.ts'
import { UsageRuntime } from '../src/usage/runtime.ts'
import { HealthBoard } from '../src/infra/health.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const image = (extra = {}) => ({ type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 100, width: 1, height: 1 }, ...extra })
const request = (content: unknown[] = [], extra = {}) => ({ provider: 'abliteration', model: 'abliterated-model-large-flash', maxTokens: 8192,
  messages: [{ role: 'user', content }], ...extra }) as GenerateOptions

it('emits only an optional provider patch with bounded retries/output and no default-model or pricing changes', async () => {
  const patch = abliterationPatch(), provider = patch[0]!.config.providers.abliteration
  expect(patch.map(entry => entry.id)).toEqual(['llm-pi-ai'])
  expect(provider).toMatchObject({ apiKeyEnv: 'ABLIT_KEY', api: 'openai-completions', baseURL: 'https://api.abliteration.ai/v1', retryPolicy: { mode: 'normal', maxRetries: 0 } })
  expect(provider.models.map(model => model.id)).toEqual(ABLITERATION_MODELS)
  expect(provider.models.every(model => model.maxTokens === 8192 && model.input.includes('image'))).toBe(true)
  expect(JSON.stringify(patch)).not.toMatch(/agent-default-model|session-title|price|apiKey"/)
  provider.models[0]!.contextWindow = 1; expect(abliterationProvider().models[0]!.contextWindow).toBe(262144)
  const template = JSON.parse(await readFile(new URL('../examples/abliteration/cordis.patch.json', import.meta.url), 'utf8'))
  expect(template).toEqual(abliterationPatch())
})

it('counts every retained image occurrence across user and tool history, excluding only offloaded references', () => {
  const content = [image(), image(), image(), image()]
  expect(() => assertAbliterationRequest(request(content))).not.toThrow()
  const full = request(content, { messages: [{ role: 'user', content }, { role: 'tool', content: [image()], toolCallId: 'call' }] })
  expect(() => assertAbliterationRequest(full)).toThrow('four retained images')
  expect(() => assertAbliterationRequest(request([...content, image({ offloaded: true })]))).not.toThrow()
  // Reusing one attachment ID still emits multiple occurrences on the wire.
  expect(() => assertAbliterationRequest(request([...content, image()]))).toThrow('four retained images')
  expect(() => assertAbliterationRequest(request([...content, image()], { provider: 'unchanged-provider' }))).not.toThrow()
})

it.each([{ bytes: 12_000_001 }, { bytes: 0 }, { bytes: NaN }, { mediaType: 'image/svg+xml' }])('refuses unsupported image metadata without disclosing content or identifiers: %j', bad => {
  const block = image(); Object.assign(block.attachment, bad, { attachmentId: 'private-source-path' })
  expect(() => assertAbliterationRequest(request([block]))).toThrow('12 MB')
  try { assertAbliterationRequest(request([block])) } catch (error) { expect(String(error)).not.toContain('private-source-path') }
})

it('rejects oversized output overrides and unconfigured Abliteration models before dispatch', async () => {
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose()); await ctx.plugin(LlmRuntime)
  const adapter = new InferenceAdapter(); ctx.llm.registerAdapter(['abliteration', 'unchanged-provider'], adapter); installAbliterationGuard(ctx)
  const consume = async (options: GenerateOptions) => { for await (const _ of ctx.llm.stream(options)) { /* consume */ } }
  await expect(consume(request([image(), image(), image(), image(), image()]))).rejects.toThrow('four retained images')
  await expect(consume(request([], { maxTokens: ABLITERATION_LIMITS.outputTokens + 1 }))).rejects.toThrow('8192')
  await expect(consume(request([], { maxTokens: undefined }))).rejects.toThrow('8192')
  await expect(consume(request([], { model: 'unconfigured' }))).rejects.toThrow('configured Abliteration model')
  expect(adapter.calls).toHaveLength(0)
  await consume(request([image(), image(), image(), image(), image()], { provider: 'unchanged-provider' }))
  expect(adapter.calls).toHaveLength(1)
})

it('performs only authenticated catalog GET and returns bounded metadata without leaking secrets or server text', async () => {
  const secret = 'synthetic-test-key', fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [
    { id: ABLITERATION_MODELS[0], access: { available: true }, is_ready: true, private: secret },
    { id: ABLITERATION_MODELS[1], access: { locked: true }, is_ready: false }, { id: secret },
  ] })))
  const result = await inspectAbliterationModels(secret, fetcher)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]).toMatchObject(['https://api.abliteration.ai/v1/models', { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${secret}` } }])
  expect(result).toEqual({ status: 'catalog_received', models: [
    { id: ABLITERATION_MODELS[0], listed: true, access: 'available', ready: true },
    { id: ABLITERATION_MODELS[1], listed: true, access: 'locked', ready: false },
  ] })
  expect(JSON.stringify(result)).not.toContain(secret)
})

it('makes no request without a valid explicit credential and sanitizes failed, malformed and oversized responses', async () => {
  const fetcher = vi.fn(async () => new Response('unused'))
  expect(await inspectAbliterationModels(undefined, fetcher)).toEqual({ status: 'not_configured' })
  expect(await inspectAbliterationModels('secret\nheader', fetcher)).toEqual({ status: 'invalid_credential' }); expect(fetcher).not.toHaveBeenCalled()
  expect(await inspectAbliterationModels('secret', async () => new Response('secret', { status: 401 }))).toEqual({ status: 'request_failed', httpStatus: 401 })
  expect(await inspectAbliterationModels('secret', async () => { throw new Error('secret') })).toEqual({ status: 'request_failed' })
  expect(await inspectAbliterationModels('secret', async () => new Response('{}'))).toEqual({ status: 'invalid_response' })
  expect(await inspectAbliterationModels('secret', async () => new Response('x'.repeat(1_048_577)))).toEqual({ status: 'invalid_response' })
})

it('pins an Abliteration persona per task through edits and database reopen without changing other role or Harness defaults', async () => {
  const h = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, captureSessions: new Map<string, Session>() }); cleanup.push(() => h.stop())
  const before = structuredClone(h.runtime.store.settings()), defaults = h.ctx.get('agentDefaultModel') as { currentSelection(): unknown }
  const originalDefault = defaults.currentSelection(), model = { provider: 'abliteration', model: 'abliterated-model-large-flash', reasoningEffort: 'low' }
  const persona = await h.runtime.personas.create({ requestId: randomUUID(), definition: { name: 'Vision reviewer', description: 'Reviewed task model',
    instructions: 'Review supplied evidence.', model, capabilities: ['read'], skills: [] } })
  let mission = h.runtime.workspace.create({ requestId: randomUUID(), title: 'Review', objective: 'Inspect evidence', acceptance: 'Reviewed result' })
  mission = h.runtime.workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Review images', instructions: 'Review input', owner: 'agent', persona: { id: persona.id, version: 1 } })
  mission = h.runtime.workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(mission.actions[0]!.ticket!.id)!, sessionId = `worker-${ticket.id}`
  const agent = h.agents.get(sessionId)! as unknown as Agent
  expect(ticket.execution!.persona!.definition.model).toEqual(model)
  expect(agent.session.snapshotEvents().find(event => event.type === 'model/selection')?.data).toEqual(model)
  await h.runtime.personas.update(persona.id, { requestId: randomUUID(), revision: 1, definition: { ...persona.definition, model: { provider: 'other', model: 'other' } } })
  await h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, 'Resume pinned model', 'worker')
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    expect(new Personas(reopened).version(persona.id, 1).definition.model).toEqual(model)
    expect(reopened.tickets.get(ticket.id)!.execution!.persona!.definition.model).toEqual(model)
  } finally { reopened.close() }
  expect(h.runtime.store.settings()).toEqual(before); expect(defaults.currentSelection()).toEqual(originalDefault)
  // Match production middleware order: preflight runs before UsageRuntime can reserve this task's budget.
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose()); await ctx.plugin(LlmRuntime)
  const adapter = new InferenceAdapter(); ctx.llm.registerAdapter(['abliteration'], adapter)
  const accounting = new UsageRuntime(ctx, h.runtime.store, h.runtime.usage, h.runtime.masterId, new AbortController().signal, new HealthBoard().claim('usage'))
  cleanup.push(() => accounting.dispose()); installAbliterationGuard(ctx)
  const consume = async (content: unknown[]) => {
    for await (const _ of ctx.llm.stream(request(content, { sessionId }))) { /* consume */ }
  }
  const previousCalls = h.runtime.usage.page().totals.calls
  await expect(consume([image(), image(), image(), image(), image()])).rejects.toThrow('four retained images')
  expect(h.runtime.usage.page().totals.calls).toBe(previousCalls); expect(adapter.calls).toHaveLength(0)
  await consume([{ type: 'text', text: 'Synthetic provider request' }])
  expect(h.runtime.usage.page().calls[0]).toMatchObject({ provider: 'abliteration', model: model.model, owner: { personaId: persona.id, ticketId: ticket.id } })
})
