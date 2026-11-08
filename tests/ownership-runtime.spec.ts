import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { remoteFixture } from './fixtures/remote.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { openRuntimeOwnership } from '../src/ownership/runtime.ts'
import { Runtime } from '../src/app/runtime.ts'
import { testMachine } from './fixtures/deployment.ts'
import type { RemoteJob } from '../src/remote/protocol.ts'
import type { OwnershipView } from '../src/ownership/protocol.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { Config as MainConfig } from '../src/deployment.ts'
import { Config as ProviderConfig } from '../src/remote/provider-plugin.ts'
import { Config as EndpointConfig } from '../src/remote/endpoint-plugin.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const rid = () => randomUUID()

it('loads legacy profiles without ownership and validates explicitly configured ownership', () => {
  const main = { stateDir: '/private/state' }, provider = { url: 'http://127.0.0.1:1234', endpointId: rid(), credentialFile: '/private/grant', stateDir: '/private/world' },
    endpoint = { stateDir: '/private/endpoint', workspaceRoot: '/workspaces' }
  expect(MainConfig(main).ownership).toBeUndefined()
  expect(ProviderConfig(provider).ownership).toBeUndefined()
  expect(EndpointConfig(endpoint).ownership).toBeUndefined()
  expect(() => MainConfig({ ...main, ownership: {} } as never)).toThrow()
  expect(() => ProviderConfig({ ...provider, ownership: {} } as never)).toThrow()
  expect(() => EndpointConfig({ ...endpoint, ownership: {} } as never)).toThrow()
  const ownership = { url: 'http://127.0.0.1:2345', authorityId: rid(), coordinatorId: 'coordinator', credentialFile: '/private/claimant' }
  expect(MainConfig({ ...main, ownership }).ownership).toMatchObject({ ...ownership, leaseMs: 30_000 })
  expect(ProviderConfig({ ...provider, ownership }).ownership).toMatchObject({ authorityId: ownership.authorityId, coordinatorId: 'coordinator' })
  expect(EndpointConfig({ ...endpoint, ownership: { ...ownership, resourceId: 'endpoint' } }).ownership).toMatchObject({ resourceId: 'endpoint' })
})

async function fixture() {
  const authority = await ownershipAuthority(cleanup)
  let host: Host
  const remote = await remoteFixture(cleanup, { native: process.env.DSH_REMOTE_ISOLATION === '1', ownership: authority.resource,
    access: { authorityId: authority.config.authorityId, coordinatorId: 'coordinator', proof: () => host.runtime.ownership!.proof() },
    beforeEnroll: async () => {
      host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true, ownership: authority.config })
      cleanup.push(() => host.stop())
    } })
  if (process.env.DSH_REMOTE_ISOLATION !== '1') vi.spyOn(remote.endpoint, 'identity').mockReturnValue({ ...remote.endpoint.identity(), confinement: 'linux-bubblewrap' })
  return { authority, remote, host: host! }
}

it('acquires ownership before initialization, routes managed work with the shared proof and stops on authority restart', async () => {
  const { authority, remote, host: h } = await fixture(), runtime = h.runtime
  expect(runtime.ownership!.status().phase).toBe('active')
  expect(runtime.environments.list().items).toEqual([])
  expect(runtime.environments.ready()).toBe(false)
  await expect(runtime.environments.enroll({})).rejects.toThrow('enrolled endpoint')
  expect(runtime.sources.instance('feishu')?.enabled).toBe(false)
  const registration = await runtime.endpoints.register({ requestId: rid(), endpointId: remote.endpoint.journal.id,
    url: remote.url, credentialFile: remote.connection.credentialFile, revision: 0, name: 'Owned endpoint' })
  expect(registration.identity.ownership?.authorityId).toBe(authority.config.authorityId)
  const command = await runtime.endpoints.submit(registration.id, { revision: registration.revision, request: {
    op: 'grant.create', requestId: rid(), owner: 'coordinator', workspace: 'managed-owned', operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300_000 } })
  expect(command.phase).toBe('done')
  const profile = await runtime.endpoints.profile(registration.id, command.id, { port: 62001 })
  expect(profile.patch.find((row: any) => row.id === 'dsh-superagent')).toMatchObject({ config: { ownership: { coordinatorId: 'coordinator' } } })
  const world = await runtime.worlds.activate({ requestId: rid(), endpointId: registration.id, commandId: command.id, name: 'Owned world' })
  expect(world.ready, world.problem).toBe(true)
  let mission = runtime.workspace.create({ requestId: rid(), title: 'Owned work', objective: 'Run through the owned resource', acceptance: 'Receipt survives loss' })
  mission = runtime.workspace.add(mission.id, { requestId: rid(), revision: mission.revision, title: 'Execute', instructions: 'Inspect workspace', owner: 'agent', environment: world.id })
  mission = runtime.workspace.act(mission.id, mission.actions[0]!.id, { requestId: rid(), revision: mission.revision, command: 'run' })
  await runtime.idle()
  const ticket = runtime.store.tickets.get(mission.actions[0]!.runs[0]!)!, member = runtime.worlds.require(world.id)
  expect(ticket.assignments.at(-1)?.state).toBe('running')
  const job = await h.withTool(workerSessionId(ticket.id), 'bash', () => member.world.executionClient().call<RemoteJob>({
    op: 'job.spawn', requestId: rid(), argv: ['/bin/sh', '-c', 'sleep 30; printf stale > stale-owned-result'], cwd: ticket.execution!.directory,
    revision: member.world.grant.revision, env: {}, graceMs: 100,
  }))
  await vi.waitFor(() => expect(remote.endpoint.journal.job(job.id).phase).toBe('started'))
  expect(job.ownership).toEqual(runtime.ownership!.status().owner)
  const session = h.agents.get(workerSessionId(ticket.id))!
  authority.restart()
  await vi.waitFor(() => expect(runtime.lifetime.aborted).toBe(true), { timeout: 5000 })
  await vi.waitFor(() => expect(remote.endpoint.journal.job(job.id).quiescent).toBe(true), { timeout: 5000 })
  expect(session.cancel).toHaveBeenCalled()
  expect(runtime.environments.ready()).toBe(false)
  expect(runtime.environments.allows(ticket.execution!.environment)).toBe(false)
  expect(() => runtime.ownership!.proof()).toThrow('unavailable')
  expect((await h.api('GET', 'state')).body).toMatchObject({ ownership: { phase: 'lost' }, health: { runtime: { state: 'error' } } })
  expect((await h.api('POST', 'missions', { requestId: rid(), title: 'Must refuse', objective: 'No ownership', acceptance: 'Denied' })).status).toBe(409)
  expect(await remote.admin.call({ op: 'job.get', id: job.id })).toMatchObject({ ownership: job.ownership, quiescent: true })
  const observed = await h.api('POST', `tickets/${ticket.id}/execution/refresh`)
  expect(observed.status).toBe(200)
  expect((observed.body.items as RemoteJob[]).find(item => item.id === job.id)).toMatchObject({ ownership: job.ownership, quiescent: true })
  expect((await h.api('POST', `tickets/${ticket.id}/execution/${job.id}/cancel`, { requestId: rid() })).status).toBe(409)
  expect((await h.api('GET', `endpoints/${registration.id}/catalog`)).status).toBe(200)
  await expect(h.withTool(workerSessionId(ticket.id), 'bash', async () => 'must not run')).rejects.toThrow('lost ownership')
}, 15_000)

it('retains the ownership binding and refuses a staged restore before acquiring a lease', async () => {
  const authority = await ownershipAuthority(cleanup), path = join(authority.directory, 'state'), store = new Store(join(path, 'orchestrator.sqlite'))
  expect(() => openRuntimeOwnership(store, authority.config, [authority.directory])).toThrow('outside every execution workspace')
  expect(store.get(KV.runtime.ownership)).toBeUndefined()
  const lease = openRuntimeOwnership(store, authority.config, [])!
  expect(() => openRuntimeOwnership(store, undefined, [])).toThrow('cannot be removed')
  expect(() => openRuntimeOwnership(store, { ...authority.config, coordinatorId: 'different' }, [])).toThrow('cannot be removed')
  store.set(KV.recovery.hold, { checkpoint: rid(), at: new Date().toISOString(), state: 'staged' }); store.close()
  await lease.close()
  const ctx = new Context()
  try {
    expect(() => new Runtime(ctx, testMachine({ stateDir: path, executionMode: 'local', ownership: authority.config }), () => {})).toThrow('staged checkpoint restore')
    expect(await authority.claimant.call<OwnershipView>({ op: 'lease.inspect' })).toMatchObject({ phase: 'vacant', epoch: 0 })
  } finally { await ctx.fiber.dispose() }
})

it('refuses to register an unfenced endpoint in an ownership-controlled coordinator', async () => {
  const { host } = await fixture(), unowned = await remoteFixture(cleanup)
  await expect(host.runtime.endpoints.register({ requestId: rid(), endpointId: unowned.endpoint.journal.id, url: unowned.url,
    credentialFile: unowned.connection.credentialFile, revision: 0, name: 'Unfenced' })).rejects.toThrow('coordinator ownership')
  expect(host.runtime.endpoints.list().items).toEqual([])
})

it('refuses a competing Runtime with independent local state and hands off only after the incumbent stops', async () => {
  const { host, authority } = await fixture(), incumbent = host.runtime.ownership!.status().owner!
  await expect(startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true,
    ownership: { ...authority.config, prepareTimeoutMs: 1000 } })).rejects.toThrow('Another coordinator instance')
  expect(host.runtime.ownership!.status()).toMatchObject({ phase: 'active', owner: incumbent })
  await host.runtime.stop()
  expect(() => host.runtime.ownership!.proof()).toThrow('unavailable')
  const successor = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true, ownership: authority.config })
  cleanup.push(() => successor.stop())
  expect(successor.runtime.ownership!.status()).toMatchObject({ phase: 'active', owner: { epoch: incumbent.epoch + 1 } })
  expect(successor.runtime.ownership!.status().instanceId).not.toBe(incumbent.instanceId)
  expect(successor.runtime.environments.ready()).toBe(false)
}, 15_000)

it('releases ownership if initialization fails after acquisition', async () => {
  const authority = await ownershipAuthority(cleanup)
  const original = CoordinatorOwnership.prototype.start
  vi.spyOn(CoordinatorOwnership.prototype, 'start').mockImplementationOnce(async function (this: CoordinatorOwnership) {
    await original.call(this)
    throw new Error('Startup failed after ownership acquisition')
  })
  await remoteFixture(cleanup, { ownership: authority.resource, beforeEnroll: async () => {
    await expect(startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true, ownership: authority.config }))
      .rejects.toThrow('Startup failed')
    expect(await authority.claimant.call<OwnershipView>({ op: 'lease.inspect' })).toMatchObject({ phase: 'vacant', epoch: 1 })
    throw new Error('Expected fixture enrollment stop')
  } }).catch(error => { expect(error.message).toBe('Expected fixture enrollment stop') })
})
