import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { symlink } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { verifyRegistryState, type RegistryStateContext } from '../src/recovery/registries.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import type { PersonaDefinition } from '../src/personas/model.ts'
import type { Store } from '../src/app/store.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { remoteFixture } from './fixtures/remote.ts'
import { scheduleDefinition } from './fixtures/workspace-state.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
const rid = () => randomUUID()
const definition = (): PersonaDefinition => ({ name: 'Researcher', description: 'Recorded evidence', instructions: 'Keep the original evidence.',
  model: { provider: 'test', model: 'test' }, capabilities: ['read', 'skills'], skills: [{ name: 'evidence', description: 'Evidence procedure', content: 'Keep original sources.' }] })
const context = (h: Host) => ({ masterId: h.runtime.masterId, worlds: [] as RegistryStateContext['worlds'],
  sessions: [...h.agents.values()].map(value => { const agent = value as unknown as Agent; return { id: agent.id, header: structuredClone(agent.session.header) } }) })
const verify = (h: Host, input = context(h)) => verifyRegistryState(h.runtime.store.db, input, new AbortController().signal)
function change(store: Store, table: string, identity: string, update: (value: any) => void) {
  const value = JSON.parse(String(store.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(identity)!.value)); update(value)
  store.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), identity)
}
async function fixture() {
  const h = await startRuntime(undefined, { executionMode: 'local', noAccounts: true }); cleanup.push(() => h.stop())
  const persona = await h.runtime.personas.create({ requestId: rid(), definition: definition() }), workspace = h.runtime.workspace
  let mission = workspace.create({ requestId: rid(), title: 'Recorded task', objective: 'Inspect the original evidence', acceptance: 'Operator review' })
  mission = workspace.add(mission.id, { requestId: rid(), revision: mission.revision, title: 'Research', instructions: 'Review the evidence', owner: 'agent', persona: { id: persona.id, version: 1 } })
  mission = workspace.act(mission.id, mission.actions[0]!.id, { requestId: rid(), revision: mission.revision, command: 'run' })
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(mission.actions[0]!.runs[0]!)!
  return { h, persona, ticket, store: h.runtime.store, workspace, mission, environment: h.runtime.environments.list().items[0]! }
}

it('verifies immutable persona history and original worker identity after updates and repeated archive commands', async () => {
  const { h, persona, store } = await fixture(), personas = h.runtime.personas
  await personas.update(persona.id, { requestId: rid(), revision: 1, definition: { ...definition(), instructions: 'New work uses a different procedure.' } })
  personas.archive(persona.id, { requestId: rid(), revision: 2, archived: true, reason: 'Retire this persona for new work' })
  personas.archive(persona.id, { requestId: rid(), revision: 3, archived: true, reason: 'Keep it archived' })
  const before = recoveryStateDigest(store.db), result = await verify(h)
  expect(result).toMatchObject({ personas: 1, personaVersions: 2, personaCommands: 4, personaExecutions: 1, environments: 1, legacyGrants: 0 })
  expect(await verify(h)).toEqual(result); expect(recoveryStateDigest(store.db)).toBe(before)
  expect(() => personas.snapshot({ id: persona.id, version: 1 })).toThrow('archived')
})

it('rejects substituted definitions, version history, command receipts, execution snapshots and Session pins without mutation', async () => {
  const { h, persona, store, ticket, environment } = await fixture(), worker = `worker-${ticket.id}`
  const mutations = [
    () => change(store, 'persona', persona.id, value => { value.definition.instructions = 'private-substituted-instructions' }),
    () => change(store, 'persona_version', persona.id, value => { value.digest = '0'.repeat(64) }),
    () => change(store, 'persona_version', persona.id, value => { value.definition.capabilities.push('commands') }),
    () => change(store, 'persona_version', persona.id, value => { delete value.definition.model }),
    () => store.db.exec('DELETE FROM persona_event'),
    () => store.db.exec('DELETE FROM persona_command'),
    () => store.db.exec("UPDATE persona_command SET fingerprint='bad'"),
    () => change(store, 'ticket', ticket.id, value => { value.execution.persona.definition.skills[0].content = 'A different skill' }),
    () => change(store, 'ticket', ticket.id, value => { delete value.execution.persona }),
    () => change(store, 'ticket', ticket.id, value => { value.execution.environment.epoch++ }),
    () => change(store, 'ticket', ticket.id, value => { value.execution.name = 'substituted-task-name' }),
    () => change(store, 'ticket', ticket.id, value => { value.execution.directory = join(h.directory, 'unapproved-root', 'task') }),
    () => change(store, 'execution_environment', environment.id, value => { value.enabled = false }),
    () => store.db.exec('DELETE FROM execution_environment_event'),
    () => store.db.exec('DELETE FROM execution_environment_command'),
    () => store.set(KV.sessions.persona(worker), '0'.repeat(64)),
    () => store.set(KV.sessions.personaOwner(worker), 'unrelated-ticket'),
    () => store.set(KV.sessions.world(worker), '0'.repeat(64)),
    () => store.db.prepare('DELETE FROM kv WHERE key=?').run(KV.sessions.persona(worker)),
  ]
  for (const mutate of mutations) {
    store.db.exec('SAVEPOINT corrupt_registry')
    try {
      mutate(); const before = recoveryStateDigest(store.db)
      await expect(verify(h)).rejects.toThrow('recovery_registries_'); expect(recoveryStateDigest(store.db)).toBe(before)
    } finally { store.db.exec('ROLLBACK TO corrupt_registry; RELEASE corrupt_registry') }
  }
  expect(await verify(h)).toMatchObject({ personas: 1, personaExecutions: 1 })
})

it('preserves old environment grants across no-op updates, revocation, reauthorization and replacement', async () => {
  const { h, environment, ticket, store } = await fixture(), env = h.runtime.environments
  await env.update(environment.id, { requestId: rid(), revision: 1, enabled: true, reason: 'Keep the same authority' })
  await env.update(environment.id, { requestId: rid(), revision: 1, enabled: false, reason: 'Stop old authority' })
  await env.update(environment.id, { requestId: rid(), revision: 2, enabled: false, reason: 'Keep revoked' })
  await env.update(environment.id, { requestId: rid(), revision: 2, enabled: true, reason: 'New generation' })
  await env.enroll({ requestId: rid(), name: 'Same enrollment', root: env.list().currentRoot, mode: 'local' })
  await env.enroll({ requestId: rid(), name: 'Replacement enrollment', root: env.list().currentRoot, mode: 'local', replaceId: environment.id, revision: 3 })
  await h.runtime.idle()
  const before = recoveryStateDigest(store.db), result = await verify(h)
  expect(result).toMatchObject({ environments: 2, environmentEvents: 7, opaqueCommandReceipts: 7 })
  expect(result.historicalGrants).toBeGreaterThan(0); expect(recoveryStateDigest(store.db)).toBe(before)
  expect(env.allows(ticket.mandate.environment)).toBe(false)
})

it('checks descendant ancestry beyond eight levels and refuses a swapped owner or a cycle', async () => {
  const { h, ticket, store } = await fixture(); let parent = `worker-${ticket.id}`
  for (let i = 0; i < 12; i++) {
    const id = `deep-child-${i}`; await h.controller.create({ sessionId: id })
    const agent = h.agents.get(id)! as unknown as Agent
    Object.assign(agent.session.header, { parentSession: parent })
    await h.ctx.parallel('agent/created', { agent } as never); parent = id
  }
  expect(await verify(h)).toMatchObject({ personaExecutions: 1, pendingPins: 0 })
  await h.controller.create({ sessionId: 'undecorated-child' })
  Object.assign((h.agents.get('undecorated-child')! as unknown as Agent).session.header, { parentSession: parent })
  expect((await verify(h)).legacySessionPins).toBeGreaterThan(0)
  const other = h.runtime.inbox.start({ requestId: rid(), title: 'Different task', text: 'A separate owner' }); await h.runtime.idle()
  const original = store.get(KV.sessions.personaOwner(parent))!
  store.set(KV.sessions.personaOwner(parent), other.id)
  await expect(verify(h)).rejects.toThrow('session_persona_owner'); store.set(KV.sessions.personaOwner(parent), original)
  const input = context(h); Object.assign(input.sessions.find(item => item.id === 'deep-child-0')!.header, { parentSession: parent })
  await expect(verify(h, input)).rejects.toThrow('session_lineage')
  const orphan = context(h); orphan.sessions.splice(orphan.sessions.findIndex(item => item.id === 'deep-child-5'), 1)
  await expect(verify(h, orphan)).rejects.toThrow('session_parent')
  const missingRoot = context(h); missingRoot.sessions.splice(missingRoot.sessions.findIndex(item => item.id === `worker-${ticket.id}`), 1)
  await expect(verify(h, missingRoot)).rejects.toThrow('session_parent')
})

it('keeps interrupted root Session pins and explicitly unbound legacy grants without inventing authority', async () => {
  const { h, ticket, store } = await fixture(), input = context(h)
  input.sessions.splice(input.sessions.findIndex(item => item.id === `worker-${ticket.id}`), 1)
  expect(await verify(h, input)).toMatchObject({ pendingPins: 1 })
  change(store, 'ticket', ticket.id, value => { delete value.mandate.environment; delete value.execution.environment; for (const assignment of value.assignments) if (assignment.execution) delete assignment.execution.environment })
  const before = recoveryStateDigest(store.db)
  expect(await verify(h)).toMatchObject({ legacyGrants: 1 }); expect(recoveryStateDigest(store.db)).toBe(before)
})

it('retains the lexical enrollment root when local execution was authorized through a symlink', async () => {
  const { h, environment } = await fixture(), alias = join(h.directory, 'workspace-alias'), settings = h.runtime.store.settings()
  await symlink(environment.root, alias)
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, directory: alias } })
  await h.runtime.environments.enroll({ requestId: rid(), name: 'Alias enrollment', root: alias, mode: 'local' })
  h.runtime.inbox.start({ requestId: rid(), title: 'Alias task', text: 'Use the reviewed alias' }); await h.runtime.idle()
  expect(await verify(h)).toMatchObject({ environments: 2, executions: 2 })
})

it('retains unresolved future schedule selections without treating the template as admitted execution authority', async () => {
  const { h } = await fixture(), definition = scheduleDefinition()
  Object.assign(definition.plan.actions[0]!, { persona: { id: rid(), version: 1 }, environment: 'e'.repeat(64) })
  h.runtime.schedules.create({ requestId: rid(), enabled: false, definition })
  expect(await verify(h)).toMatchObject({ unresolvedTemplateReferences: 4, executions: 1 })
})

it('validates actual managed-world journals and remote Session bindings before and after revocation', async () => {
  const h = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true })
  const remote = await remoteFixture(cleanup, { native: process.env.DSH_REMOTE_ISOLATION === '1' }); cleanup.push(() => h.stop())
  if (process.env.DSH_REMOTE_ISOLATION !== '1') vi.spyOn(remote.endpoint, 'identity').mockReturnValue({ ...remote.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const endpoint = await h.runtime.endpoints.register({ requestId: rid(), endpointId: remote.endpoint.journal.id, url: remote.url,
    credentialFile: remote.connection.credentialFile, revision: 0, name: 'Original endpoint' })
  const command = await h.runtime.endpoints.submit(endpoint.id, { revision: 1, request: { op: 'grant.create', requestId: rid(), owner: 'coordinator', workspace: 'recovery-registry',
    operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 } })
  const world = await h.runtime.worlds.activate({ requestId: rid(), endpointId: endpoint.id, commandId: command.id, name: 'Original world' })
  expect(world.ready, world.problem).toBe(true)
  const workspace = h.runtime.workspace
  let m = workspace.create({ requestId: rid(), title: 'Remote evidence', objective: 'Use the original world', acceptance: 'Review evidence' })
  m = workspace.add(m.id, { requestId: rid(), revision: m.revision, title: 'Inspect', instructions: 'Read existing evidence', owner: 'agent', environment: world.id })
  m = workspace.act(m.id, m.actions[0]!.id, { requestId: rid(), revision: m.revision, command: 'run' }); await h.runtime.idle()
  function input() {
    const record = JSON.parse(String(h.runtime.store.db.prepare('SELECT value FROM managed_world WHERE id=?').get(world.id)!.value))
    const journal = new DatabaseSync(join(record.config.stateDir, 'world.sqlite'), { readOnly: true })
    try { return { ...context(h), worlds: [JSON.parse(String(journal.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value))] } }
    finally { journal.close() }
  }
  expect(await verify(h, input())).toMatchObject({ managedWorlds: 1, historicalGrants: 0 })
  const changed = input(), worker = changed.sessions.find(item => item.id === `worker-${m.actions[0]!.runs[0]}`)!
  Object.assign(worker.header, { agentPreset: 'dsh-superagent-worker' })
  await expect(verify(h, changed)).rejects.toThrow('session_world_preset')
  await h.runtime.worlds.revoke(world.id, { requestId: rid(), revision: 1, reason: 'Retire original authority' }); await h.runtime.idle()
  const result = await verify(h, input()); expect(result.managedWorlds).toBe(1); expect(result.historicalGrants).toBeGreaterThan(0)
  change(h.runtime.store, 'managed_world', world.id, value => { value.epoch++ })
  await expect(verify(h, input())).rejects.toThrow('managed_world_binding')
}, 20000)

it('honors cancellation and bounds oversized state without exposing saved definitions', async () => {
  const { h, store } = await fixture(), abort = new AbortController(); abort.abort(new Error('Cancelled registry inspection'))
  await expect(verifyRegistryState(store.db, context(h), abort.signal)).rejects.toThrow('Cancelled registry inspection')
  store.db.prepare('INSERT INTO kv VALUES (?,?)').run('session-persona:oversized', JSON.stringify('private-data-'.repeat(750000)))
  await expect(verify(h)).rejects.toThrow('recovery_registries_limit: kv')
})
