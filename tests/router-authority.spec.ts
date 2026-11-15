import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RouterAuthority } from '../src/app/router-authority.ts'
import { KV } from '../src/kv.ts'
import { jobRegistry } from './fixtures/host.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function fixture(mode: 'native' | 'ptc' = 'native') {
  const root = new Context(); contexts.push(root)
  await root.plugin(SystemPrompt); await root.plugin(Tools, { mode })
  const agents = new Map<string, Agent>(), values = new Map<string, unknown>(), jobs = jobRegistry()
  root.reflect.provide('agents', agents); root.reflect.provide('jobs', jobs.service)
  let ctx!: Context
  await root.inject(['systemPrompt', 'tools', 'agents', 'jobs'], value => { ctx = value })
  const make = (id: string) => {
    const agent = { id: SessionId(id), session: Session.create(SessionId(id)), status: 'idle', cancel: vi.fn(), whenIdle: async () => {} } as unknown as Agent
    const scope = createScope(ctx, agent); Object.assign(agent, { ctx: scope.ctx }); agents.set(id, agent); return agent
  }
  const agent = make('coordinator'), worker = make('worker'), execute = vi.fn(async () => 'executed')
  const register = (name: string, scope = ctx, run = execute) => scope.tools.register(defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] }, execute: run }))
  for (const name of ['skill', 'bash', 'read', 'subagent']) register(name)
  register('orchestrator_read', agent.ctx)
  const authority = new RouterAuthority(ctx, agent, ['orchestrator_read'], { set: (key, value) => { values.set(key as string, value) } }, new AbortController().signal)
  const call = (name: string, owner = agent) => ctx.tools.execute({ callId: `call-${name}` as never, name, arguments: {}, agent: owner, signal: new AbortController().signal })
  return { ctx, agent, worker, agents, values, jobs, execute, register, authority, call, make }
}

it('blocks inherited and late agent-local execution through real Harness guards despite permissive pre-policy', async () => {
  const h = await fixture()
  expect(JSON.stringify(await h.call('orchestrator_read'))).toContain('preparing its routing-only authority')
  await h.authority.prepare()
  h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  for (const name of ['bash', 'read', 'subagent', 'arbitrary_plugin']) h.register(name, h.agent.ctx)
  for (const name of ['bash', 'read', 'subagent', 'arbitrary_plugin']) expect(JSON.stringify(await h.call(name))).toContain('routing authority only')
  expect(h.execute).not.toHaveBeenCalled()
  await h.call('orchestrator_read'); await h.call('skill'); await h.call('bash', h.worker)
  expect(h.execute).toHaveBeenCalledTimes(3)
})

it('advertises only coordinator-authorized tools after late local registration, without masking workers', async () => {
  const h = await fixture()
  await h.authority.prepare()
  for (const name of ['bash', 'read', 'subagent', 'spawn_teammate', 'plugin_manager']) h.register(name, h.agent.ctx)
  // A provider may contribute a schema outside the registry; it still cannot advertise router execution authority.
  h.agent.ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'arbitrary_plugin', description: 'not authorized', parameters: {} }] }))
  const assembled = await h.ctx.systemPrompt.assemble({ scope: h.agent })
  expect(assembled.tools.map(tool => tool.name).sort()).toEqual(['orchestrator_read', 'skill'])
  const worker = await h.ctx.systemPrompt.assemble({ scope: h.worker })
  expect(worker.tools.map(tool => tool.name)).toContain('bash')
  expect(worker.tools.map(tool => tool.name)).not.toContain('orchestrator_read')
  for (const name of ['spawn_teammate', 'plugin_manager', 'arbitrary_plugin'])
    expect(JSON.stringify(await h.call(name))).toContain('routing authority only')
  expect(h.execute).not.toHaveBeenCalled()
})

it('does not embed denied tool schemas in PTC presentation or change unrelated workers', async () => {
  const h = await fixture('ptc')
  await h.authority.prepare()
  h.register('spawn_teammate', h.agent.ctx)
  const router = await h.ctx.systemPrompt.assemble({ scope: h.agent })
  expect(router.tools.map(tool => tool.name).sort()).toEqual(['orchestrator_read', 'skill'])
  // This fixture deliberately has no PTC runtime: the unrelated worker still requires one,
  // proving that the coordinator's native override did not change its presentation mode.
  await expect(h.ctx.systemPrompt.assemble({ scope: h.worker })).rejects.toThrow('requires a PTC runtime')
  expect(JSON.stringify(await h.call('spawn_teammate'))).toContain('routing authority only')
})

it('uses the Harness creation barrier without waiting for its own serial initialization listener', async () => {
  const h = await fixture(), idle = vi.spyOn(h.agent, 'whenIdle').mockImplementation(async () => { throw new Error('Creation cannot wait for itself') })
  await h.authority.prepare(true)
  expect(idle).not.toHaveBeenCalled()
  await h.call('orchestrator_read'); expect(h.execute).toHaveBeenCalledOnce()
})

it('retires tracked legacy coordinator jobs and descendants without touching worker jobs', async () => {
  const h = await fixture(), child = h.make('old-router-child'), rootJob = h.jobs.run(h.agent.id), childJob = h.jobs.run(child.id), workerJob = h.jobs.run(h.worker.id)
  h.ctx.reflect.provide('subagents', { listChildren: async (id: string) => id === h.agent.id ? [{ id: child.id }] : [],
    drainChildren: async () => { h.agents.delete(child.id) } })
  await h.authority.prepare()
  expect(h.values.get(KV.sessions.routerOwner(child.id))).toBe(h.agent.id)
  expect(h.jobs.service.kill.mock.calls.map(call => call[0]).sort()).toEqual([rootJob, childJob].sort())
  expect(h.jobs.service.list(h.worker.id)).toMatchObject([{ id: workerJob, status: 'running' }])
  h.register('bash', child.ctx)
  expect(JSON.stringify(await h.call('bash', child))).toContain('Coordinator descendants cannot execute')
  expect((await h.ctx.systemPrompt.assemble({ scope: child })).tools).toEqual([])
})

it('holds routing when a kill acknowledgement leaves an original job running', async () => {
  const h = await fixture(), id = h.jobs.run(h.agent.id)
  h.jobs.service.kill.mockImplementation(() => 'requested')
  h.jobs.service.wait.mockResolvedValue({ id, owner: h.agent.id, status: 'running' })
  await expect(h.authority.prepare()).rejects.toThrow('has not quiesced')
  expect(JSON.stringify(await h.call('orchestrator_read'))).toContain('has not quiesced')
  expect(h.jobs.service.list(h.agent.id)).toMatchObject([{ id, status: 'running' }])
  expect(h.execute).not.toHaveBeenCalled()
})
