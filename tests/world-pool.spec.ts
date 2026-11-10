import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Endpoints } from '../src/environments/endpoints.ts'
import { WorldPool } from '../src/environments/pool.ts'
import { RemoteWorld } from '../src/remote/world.ts'
import { runAsWorker } from '../src/infra/environment.ts'
import { definitionOf } from '../src/workspace/plan-model.ts'
import { remoteFixture } from './fixtures/remote.ts'
import { startRuntime } from './fixtures/host.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.restoreAllMocks() })
const rid = () => randomUUID()
async function endpoint(endpoints: Endpoints, workspace: string) {
  const h = await remoteFixture(cleanup)
  vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const record = await endpoints.register({ requestId: rid(), endpointId: h.endpoint.journal.id, url: h.url, credentialFile: h.connection.credentialFile, revision: 0, name: workspace })
  const command = await endpoints.submit(record.id, { revision: 1, request: { op: 'grant.create', requestId: rid(), owner: 'coordinator', workspace,
    operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300_000 } })
  return Object.assign(h, { record, command, activation: { requestId: rid(), endpointId: record.id, commandId: command.id, name: workspace } })
}
async function fixture() {
  const h = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true })
  const a = await endpoint(h.runtime.endpoints, 'world-a'), b = await endpoint(h.runtime.endpoints, 'world-b')
  cleanup.push(() => h.stop())
  const first = await h.runtime.worlds.activate(a.activation), second = await h.runtime.worlds.activate(b.activation)
  expect(first.ready, first.problem).toBe(true); expect(second.ready, second.problem).toBe(true)
  return { h, a, b, first, second, pool: h.runtime.worlds }
}
it('maintains two paired worlds without replacing host services and keeps activation and receipt ownership separate', async () => {
  const { h, a, first, second, pool } = await fixture()
  expect(await pool.activate(a.activation)).toEqual(first)
  await expect(pool.activate({ ...a.activation, name: 'Different' })).rejects.toThrow('another payload')
  expect(pool.list().items).toHaveLength(2)
  expect(h.ctx.subprocess).toBe(h.subprocess)
  await Promise.all([first, second].map(value => {
    const member = pool.require(value.id)
    return member.world.withOwner({ kind: 'host', purpose: 'qualification' }, () => member.workspace.assertPair(), async () => {
      const target = await member.filesystem.resolve(join(value.root, 'proof'))
      await member.filesystem.writeText(target, value.id, { kind: 'createIfAbsent' })
      expect(await runAsWorker(member.subprocess, ['cat', '--', join(value.root, 'proof')], value.root, new AbortController().signal)).toBe(value.id)
    })
  }))
  const one = pool.require(first.id), two = pool.require(second.id), target = await one.filesystem.resolve(join(first.root, 'proof'))
  expect(() => two.filesystem.readText(target)).toThrow('another execution world')
  expect(one.world.effects().items.every(item => item.world === first.id)).toBe(true)
  const config = await h.runtime.endpoints.world(a.record.id, a.command.id)
  const token = await readFile(config.config.credentialFile, 'utf8')
  expect(JSON.stringify(pool.list())).not.toContain(token)
  expect(JSON.stringify(pool.list())).not.toContain(config.credentialPin)
  expect(JSON.stringify(pool.list())).not.toContain(config.config.credentialFile)
  expect((await h.api('GET', `worlds/${first.id}/execution`)).status).toBe(200)
})

it('rejects repository activation without network authority before persisting a world', async () => {
  const h = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true })
  const remote = await endpoint(h.runtime.endpoints, 'repository-without-network'); cleanup.push(() => h.stop())
  await expect(h.runtime.worlds.activate({ ...remote.activation, repository: { url: 'https://example.invalid/source.git',
    commit: 'a'.repeat(40), username: 'x-access-token' } })).rejects.toThrow('network access')
  expect(h.runtime.worlds.list().items).toHaveLength(0)
})

it('dispatches actions into selected worlds, verifies actual Session providers, and revokes only the bound work', async () => {
  const { h, first, second, pool } = await fixture(), workspace = h.runtime.workspace
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, directory: join(h.directory, 'custom-default') } })
  let m = workspace.create({ requestId: rid(), title: 'Two-machine mission', objective: 'Keep environments separate', acceptance: 'Independent results' })
  for (const value of [first, second]) m = workspace.add(m.id, { requestId: rid(), revision: m.revision, title: value.name, instructions: 'Inspect this environment', owner: 'agent', environment: value.id })
  for (const action of m.actions) m = workspace.act(m.id, action.id, { requestId: rid(), revision: m.revision, command: 'run' })
  await h.runtime.idle()
  const tickets = m.actions.map(action => h.runtime.store.tickets.get(action.runs[0]!)!)
  for (const [i, ticket] of tickets.entries()) {
    const value = [first, second][i]!, session = `worker-${ticket.id}`, agent = h.agents.get(session) as unknown as Agent
    expect(ticket.execution?.environment).toMatchObject({ environmentId: value.id, world: value.id, epoch: value.epoch })
    expect(ticket.execution!.directory.startsWith(`${value.root}/`)).toBe(true)
    expect(ticket.assignments.at(-1)?.state).toBe('running')
    expect(() => pool.assertMounted(agent, value.id)).not.toThrow()
    expect(() => pool.assertMounted(agent, [second, first][i]!.id)).toThrow('filesystem and process')
    expect((await h.api('GET', `tickets/${ticket.id}/execution`)).status).toBe(200)
  }
  expect(definitionOf(workspace.get(m.id)).actions.map(action => action.environment)).toEqual([first.id, second.id])
  const revoke = { requestId: rid(), revision: first.revision, reason: 'Stop the first machine only' }
  const stopped = await pool.revoke(first.id, revoke)
  expect(stopped).toMatchObject({ enabled: false, ready: false, status: { revocation: { acknowledged: true, quiescent: true } } })
  expect(h.runtime.store.tickets.get(tickets[0]!.id)?.ended).toBeTruthy()
  expect(h.runtime.store.tickets.get(tickets[1]!.id)?.ended).toBeUndefined()
  expect(h.runtime.environments.allows(tickets[0]!.execution!.environment)).toBe(false)
  expect(h.runtime.environments.allows(tickets[1]!.execution!.environment)).toBe(true)
  expect(pool.get(second.id).ready).toBe(true)
  expect(await pool.revoke(first.id, revoke)).toEqual(stopped)
  expect(() => pool.require(first.id)).toThrow('revoked')
}, 15_000)

it('does not adopt replaced credentials before first startup and preserves a failed activation for explicit recovery', async () => {
  const { h, a, first, pool } = await fixture(), connection = await h.runtime.endpoints.world(a.record.id, a.command.id)
  await pool.stop()
  const token = await readFile(connection.config.credentialFile, 'utf8')
  await writeFile(connection.config.credentialFile, `${token}changed`)
  const ctx = new Context(), store = new Store(join(h.directory, 'orchestrator.sqlite'))
  ctx.reflect.provide('agentPresets', h.ctx.get('agentPresets'))
  const restarted = new WorldPool(ctx, { store, endpoints: h.runtime.endpoints, lifetime: h.runtime.lifetime, report: () => {} })
  cleanup.push(async () => { await restarted.stop(); store.close(); await ctx.fiber.dispose() })
  await restarted.initialize()
  expect(restarted.get(first.id)).toMatchObject({ ready: false, enabled: true })
  expect(() => restarted.require(first.id)).toThrow('unavailable')
  await writeFile(connection.config.credentialFile, token)
  expect(await restarted.refresh(first.id)).toMatchObject({ id: first.id, ready: true })
  expect(restarted.list().items.every(item => item.ready)).toBe(true)
  expect(() => new RemoteWorld({ ...connection.config, stateDir: join(h.directory, 'wrong-world') }, {
    grant: { ...connection.grant, epoch: connection.grant.epoch + 1 }, credentialReader: () => token.trim() })).toThrow('Credential no longer matches')
})

it('restores revoked-world receipt access without adopting a new grant epoch or disabling another world', async () => {
  const { h, a, first, second, pool } = await fixture()
  const prior = pool.require(first.id).world.effects().items
  await pool.revoke(first.id, { requestId: rid(), revision: 1, reason: 'Restart after revocation' })
  await pool.stop()
  const dispatch = vi.spyOn(a.endpoint, 'rpc')
  const ctx = new Context(), store = new Store(join(h.directory, 'orchestrator.sqlite'))
  ctx.reflect.provide('agentPresets', h.ctx.get('agentPresets'))
  const recovered = new WorldPool(ctx, { store, endpoints: h.runtime.endpoints, lifetime: h.runtime.lifetime, report: () => {} })
  cleanup.push(async () => { await recovered.stop(); store.close(); await ctx.fiber.dispose() })
  await recovered.initialize()
  expect(recovered.get(first.id)).toMatchObject({ enabled: false, ready: false, status: { binding: first.id, epoch: first.epoch,
    revocation: { acknowledged: true, quiescent: true } } })
  expect(recovered.lookup(first.id)!.world.effects().items.map(item => item.id)).toEqual(prior.map(item => item.id))
  expect(() => recovered.require(first.id)).toThrow('revoked')
  expect(recovered.get(second.id).ready).toBe(true)
  await recovered.lookup(first.id)!.world.refresh()
  expect(dispatch.mock.calls.some(([, request]) => (request as { op: string }).op === 'grant.revoke')).toBe(false)
})

it('persists revocation while offline and retries the original request without disturbing another world', async () => {
  const { a, first, second, pool } = await fixture()
  const request = { requestId: rid(), revision: first.revision, reason: 'Revoke while disconnected' }
  a.offline(true)
  const pending = await pool.revoke(first.id, request)
  expect(pending).toMatchObject({ enabled: false, ready: false, status: { revocation: { requestId: request.requestId, acknowledged: false, quiescent: false } } })
  expect(pool.get(second.id).ready).toBe(true)
  expect(() => pool.require(first.id)).toThrow('revoked')
  a.offline(false)
  const recovered = await pool.revoke(first.id, request)
  expect(recovered).toMatchObject({ revision: first.revision + 1, enabled: false, status: { revocation: { requestId: request.requestId, acknowledged: true, quiescent: true } } })
  await expect(pool.revoke(first.id, { ...request, reason: 'Changed after reconnect' })).rejects.toThrow('another payload')
  expect(pool.get(second.id).ready).toBe(true)
})

it('treats environment changes and removal as reviewed definitions and fences stale source authorization', async () => {
  const { h, first, second } = await fixture(), workspace = h.runtime.workspace
  let m = workspace.create({ requestId: rid(), title: 'Reviewed placement', objective: 'Select the execution world', acceptance: 'Exact authority' })
  m = workspace.add(m.id, { requestId: rid(), revision: m.revision, title: 'Read', instructions: 'Read evidence', owner: 'agent', environment: first.id })
  const original = m, plan = definitionOf(m)
  plan.actions[0]!.environment = second.id
  m = workspace.applyPlan(m.id, m.revision, plan, rid())
  expect(m.actions[0]).toMatchObject({ definitionRevision: 2, environment: second.id })
  expect(workspace.plans.version(m.id, original.planVersion).plan.actions[0]!.environment).toBe(first.id)
  expect(workspace.source.scope!({ meta: { mission: m.id, action: m.actions[0]!.id, actionRevision: 2, environment: first.id } }, {})).toMatchObject({ listened: false })
  expect(workspace.source.scope!({ meta: { mission: m.id, action: m.actions[0]!.id, actionRevision: 2, environment: second.id } }, {})).toMatchObject({ listened: true })
  delete plan.actions[0]!.environment
  m = workspace.applyPlan(m.id, m.revision, plan, rid())
  expect(m.actions[0]!.environment).toBeUndefined()
  expect(m.actions[0]!.definitionRevision).toBe(3)
  expect(h.runtime.store.tickets.list()).toEqual([])
})
