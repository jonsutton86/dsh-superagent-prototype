/** Independent Harness composition tests. Provider inference is simulated; tool registration and lifecycle use Cordis. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Config, HarnessWatchdog, type WatchdogConfig } from '../src/supervision/plugin.ts'

let directory: string
const active: HarnessWatchdog[] = []
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
  directory = mkdtempSync(join(tmpdir(), 'watchdog-harness-'))
  mkdirSync(join(directory, 'main'))
  writeFileSync(join(directory, 'main/watchdog.token'), 'secret'.repeat(10))
})
afterEach(async () => {
  for (const watchdog of active.splice(0)) await watchdog.stop()
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true })
})
type Tool = { name: string; execute(args: unknown): Promise<unknown> }
function harness(extra: Partial<WatchdogConfig> = {}) {
  const ctx = new Context(), agents = new Map<string, Agent>(), tools = new Map<string, Tool>()
  const restrictions: unknown[] = [], guards: ((execution: { name: string }) => string | undefined)[] = [], prompts: string[] = []
  const flush = vi.fn(async () => {}), delivered: UserMessage[] = []
  const routes = new Map<string, { handler: (req: unknown, res: unknown) => unknown }>()
  const controller = {
    resolveAgent: vi.fn(async (id: string) => agents.has(id) ? { agent: agents.get(id)! } : { error: { code: 'session/not-found' } }),
    rename: vi.fn(async () => {}),
    create: vi.fn(async ({ sessionId }: { sessionId: string; agentPreset: string }) => {
      const agentCtx = new Context(), inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
      agentCtx.reflect.provide('tools', {
        register: (tool: Tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
        restrict: (filter: unknown) => { restrictions.push(filter); return () => {} },
        guard: (guard: (execution: { name: string }) => string | undefined) => { guards.push(guard); return () => {} },
      })
      agentCtx.reflect.provide('systemPrompt', { section: (section: { text(): string }) => { prompts.push(section.text()); return () => {} } })
      const agent = { id: sessionId, ctx: agentCtx, session: {}, status: 'idle', inbox,
        followup: (message: UserMessage) => { delivered.push(message); inbox.nextTurn.push(message) },
        cancel: vi.fn((_reason, options: { keepInbox: boolean }) => { if (!options.keepInbox) inbox.nextTurn.splice(0) }),
        whenIdle: async () => {},
      } as unknown as Agent
      agents.set(sessionId, agent); ctx.emit('agent/created', { agent, source: 'user' } as never)
    }),
  }
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('sessionController', controller)
  ctx.reflect.provide('sessionPersistence', { flush, open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) })
  ctx.reflect.provide('workspaceRegistry', { create: async () => ({ id: 'watchdog-workspace' }) })
  ctx.reflect.provide('webServer', { host: '127.0.0.1', port: 3083, register: (route: { path: string; handler: (req: unknown, res: unknown) => unknown }) => {
    routes.set(route.path, route); return () => routes.delete(route.path)
  } })
  const config = Config({ stateDir: join(directory, 'watchdog'), tokenFile: join(directory, 'main/watchdog.token'), pollMs: 1000, ...extra })
  const watchdog = new HarnessWatchdog(ctx, config); active.push(watchdog)
  const run = async (name: string, args: unknown) => tools.get(name)!.execute(args) as Promise<Record<string, unknown>>
  async function status(headers = { host: '127.0.0.1:3083', 'x-orchestrator-request': '1' }) {
    let code = 200, result = ''
    await routes.get('/watchdog')!.handler({ method: 'GET', url: '/watchdog/api/status', headers }, {
      setHeader: () => {}, writeHead: (value: number) => { code = value }, end: (value: string) => { result = value },
    })
    return { code, body: JSON.parse(result) }
  }
  return { ctx, config, watchdog, tools, restrictions, guards, prompts, controller, agents, delivered, routes, run, status }
}
function remote() {
  const snapshot = { instance: 'main-1', version: 'v1', at: new Date().toISOString(), nextOffset: null, configured: true, paused: false,
    health: { worker: { state: 'ready' } }, tickets: [{ id: 't1', revision: 'r1', assignmentId: 'a1', title: 'Fix code', scope: 'Test it', stage: 'working',
      updatedAt: '2026-11-06T10:00:00Z', report: null, canNudge: true }] }
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/intervene')
    ? { accepted: true, reason: 'status_requested' } : snapshot)))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

it('runs its own restricted Session and persists a diagnosis before requesting a fenced status report', async () => {
  const fetcher = remote(), host = harness()
  await host.watchdog.start(); await vi.advanceTimersByTimeAsync(1)
  expect(host.controller.create).toHaveBeenCalledWith(expect.objectContaining({ agentPreset: 'dsh-superagent-watchdog' }))
  expect(host.restrictions).toEqual([{ allow: [] }])
  expect([...host.tools.keys()]).toEqual(['watchdog_observe', 'watchdog_assess', 'watchdog_request_status'])
  expect(host.guards[0]!({ name: 'bash' })).toContain('Only watchdog')
  expect(host.guards[0]!({ name: 'watchdog_assess' })).toBeUndefined()
  expect(host.delivered).toHaveLength(1)
  expect(JSON.stringify(host.delivered)).not.toContain('secret'.repeat(10))
  const observation = await host.run('watchdog_observe', {})
  const incident = (observation.incidents as { id: string; revision: string }[])[0]!
  const args = { incidentId: incident.id, incidentRevision: incident.revision }
  expect(await host.run('watchdog_request_status', args)).toMatchObject({ accepted: false })
  expect(await host.run('watchdog_assess', { ...args, finding: 'stalled', evidence: 'Repeated errors without further progress' })).toMatchObject({ accepted: true })
  expect(await host.run('watchdog_request_status', args)).toMatchObject({ accepted: true })
  const command = fetcher.mock.calls.find(([url]) => url.endsWith('/intervene'))
  expect(command).toBeDefined()
  expect((await host.status()).body.incidents[0].assessment.finding).toBe('stalled')
  expect((await host.status({ host: 'evil.example:3083', 'x-orchestrator-request': '1' })).code).toBe(403)
  await host.watchdog.stop()
  const calls = fetcher.mock.calls.length
  await vi.advanceTimersByTimeAsync(5000)
  expect(fetcher).toHaveBeenCalledTimes(calls)
  expect(host.routes.size).toBe(0); expect(host.tools.size).toBe(0)
})

it('keeps observing the main service when its model Session cannot be created', async () => {
  remote(); const host = harness()
  host.controller.resolveAgent.mockRejectedValue(new Error('model unavailable'))
  await host.watchdog.start(); await vi.advanceTimersByTimeAsync(1)
  const status = await host.status()
  expect(status.body.monitor).toMatchObject({ reachable: true, modelError: expect.stringContaining('model unavailable') })
  expect(status.body.incidents).toHaveLength(1)
})

it('refuses shared state and concurrent writers, releasing its lock on stop', async () => {
  remote(); const host = harness()
  expect(() => new HarnessWatchdog(host.ctx, { ...host.config, stateDir: join(directory, 'main') })).toThrow('own state')
  expect(() => new HarnessWatchdog(host.ctx, host.config)).toThrow('already being held')
  await host.watchdog.stop()
  const restored = new HarnessWatchdog(host.ctx, host.config); active.push(restored)
  await restored.start(); await vi.advanceTimersByTimeAsync(1)
  expect(host.delivered).toHaveLength(1)
})

it('does not start a polling loop after shutdown races Session restoration', async () => {
  const fetcher = remote(), host = harness(), restored = Promise.withResolvers<{ error: { code: string } }>()
  host.controller.resolveAgent.mockReturnValueOnce(restored.promise)
  const started = host.watchdog.start()
  const rejected = expect(started).rejects.toThrow()
  const stopped = host.watchdog.stop()
  restored.resolve({ error: { code: 'session/not-found' } })
  await rejected; await stopped; await vi.advanceTimersByTimeAsync(5000)
  expect(fetcher).not.toHaveBeenCalled()
  expect(host.routes.size).toBe(0)
  expect(host.controller.create).not.toHaveBeenCalled()
})

it('keeps observations and assessor deadlines running while a receiver is slow, then aborts and drains it on shutdown', async () => {
  const fetcher = remote(), credentialFile = join(directory, 'alert.token')
  writeFileSync(credentialFile, 'local-alert-test-credential', { mode: 0o600 })
  let sends = 0, aborted = false
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    if (String(input) !== 'https://receiver.invalid/alerts') return fetcher(String(input))
    sends++
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')) }, { once: true })
    })
  })
  const host = harness({ assessmentTimeoutMs: 1000, alertRoutes: [{ id: 'operations', name: 'Operations',
    url: 'https://receiver.invalid/alerts', tokenFile: credentialFile, cooldownMs: 1000 }] })
  await host.watchdog.start(); await vi.advanceTimersByTimeAsync(1)
  const incident = (await host.run('watchdog_observe', {})).incidents as { id: string; revision: string }[]
  await host.run('watchdog_assess', { incidentId: incident[0]!.id, incidentRevision: incident[0]!.revision,
    finding: 'stalled', evidence: 'Local test requires review' })
  await vi.advanceTimersByTimeAsync(1000); expect(sends).toBe(1)
  const observations = fetcher.mock.calls.length
  await vi.advanceTimersByTimeAsync(2000)
  expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(observations + 2)
  expect(host.agents.values().next().value!.cancel).toHaveBeenCalled()
  await host.watchdog.stop(); expect(aborted).toBe(true); expect(sends).toBe(1)
})
