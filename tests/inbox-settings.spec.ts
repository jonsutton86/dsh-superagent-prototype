import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Inbox } from '../src/workspace/inbox.ts'
import { Workspace } from '../src/workspace/service.ts'
import { Library } from '../src/workspace/library.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { remoteFixture } from './fixtures/remote.ts'
let host: Host | undefined
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await host?.stop(); host = undefined; for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.restoreAllMocks() })
const rid = () => randomUUID()
async function fixture(managed = false) { host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed }); return host }
const definition = () => ({ name: 'Researcher', description: 'Read source material', instructions: 'Preserve evidence and cite sources.', model: null, capabilities: ['read' as const], skills: [] })
it('pins a persona version and reviewed default grant, then replays the original request after catalog edits, revocation and Store reopen', async () => {
  const h = await fixture(), persona = await h.runtime.personas.create({ requestId: rid(), definition: definition() })
  const setup = h.runtime.inbox.setup().defaultEnvironment; expect(setup.available).toBe(true); if (!setup.available) throw new Error('Fixture default unavailable')
  const body = { requestId: rid(), text: 'Research the sources', persona: { id: persona.id, version: 1 }, expectedDefault: setup.grant }
  const item = h.runtime.inbox.start(body), snapshot = item.execution!
  expect(snapshot).toMatchObject({ persona: { id: persona.id, version: 1, name: 'Researcher', capabilities: ['read'] }, environment: { grant: setup.grant, description: { name: setup.name } } })
  const updated = await h.runtime.personas.update(persona.id, { requestId: rid(), revision: 1, definition: { ...definition(), name: 'Changed', instructions: 'Future instructions' } })
  h.runtime.personas.archive(persona.id, { requestId: rid(), revision: updated.revision, archived: true, reason: 'Retire future selection' })
  await h.runtime.environments.update(setup.grant.environmentId, { requestId: rid(), revision: setup.grant.revision, enabled: false, reason: 'Revoke future work' })
  expect(h.runtime.inbox.start(body).id).toBe(item.id); expect(h.runtime.inbox.item(item.id).execution).toEqual(snapshot)
  expect(() => h.runtime.inbox.start({ ...body, persona: { id: persona.id, version: 2 } })).toThrow(/another operation/)
  const store = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const workspace = new Workspace(store, () => { throw new Error('Replay must not dispatch') }, () => false)
    const reopened = new Inbox(store, workspace, new Library(store), async () => [])
    expect(reopened.start(body)).toMatchObject({ id: item.id, execution: { persona: snapshot.persona, directory: snapshot.directory, environment: { grant: setup.grant } } })
  } finally { store.close() }
})
it('refuses changed defaults and unavailable personas before creating any mission, task or receipt', async () => {
  const h = await fixture(), setup = h.runtime.inbox.setup().defaultEnvironment; if (!setup.available) throw new Error('Fixture default unavailable')
  const first = h.runtime.environments.list().items.find(item => item.current)!
  await h.runtime.environments.update(first.id, { requestId: rid(), revision: first.revision, enabled: false, reason: 'Rotate authorization' })
  await h.runtime.environments.update(first.id, { requestId: rid(), revision: first.revision + 1, enabled: true, reason: 'Restore authorization' })
  const stale = { requestId: rid(), text: 'Use the reviewed environment', expectedDefault: setup.grant }
  expect(() => h.runtime.inbox.start(stale)).toThrow(/default execution environment changed/)
  expect(() => h.runtime.inbox.start({ requestId: rid(), text: 'Unknown persona', persona: { id: rid(), version: 1 } })).toThrow()
  expect(h.runtime.workspace.list().items).toHaveLength(0); expect(h.runtime.store.tickets.list()).toHaveLength(0)
  expect(h.runtime.store.db.prepare('SELECT count(*) AS n FROM workspace_inbox_command').get()!.n).toBe(0)
  const current = h.runtime.inbox.setup().defaultEnvironment; if (!current.available) throw new Error('Fixture default unavailable')
  expect(h.runtime.inbox.start({ ...stale, expectedDefault: current.grant }).execution?.environment?.grant).toEqual(current.grant)
})
it('rejects execution choices on replies and refuses conflicting selection modes', async () => {
  const h = await fixture(), item = h.runtime.inbox.start({ requestId: rid(), text: 'Original task' })
  const reply = await h.api('POST', `inbox/${item.id}/reply`, { requestId: rid(), revision: item.revision, text: 'Redirect work', environment: 'a'.repeat(64) })
  expect(reply.status).toBe(400)
  const current = h.runtime.inbox.setup().defaultEnvironment; if (!current.available) throw new Error('Fixture default unavailable')
  expect((await h.api('POST', 'inbox', { requestId: rid(), text: 'Conflicting choices', environment: 'a'.repeat(64), expectedDefault: current.grant })).status).toBe(400)
  expect((await h.api('GET', 'inbox/setup')).body).toEqual(h.runtime.inbox.setup())
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})
it('starts inbox tasks in the selected mounted world when the default is unavailable and refuses a revoked world without fallback', async () => {
  const h = await fixture(true), endpoint = await remoteFixture(cleanup)
  vi.spyOn(endpoint.endpoint, 'identity').mockReturnValue({ ...endpoint.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const registered = await h.runtime.endpoints.register({ requestId: rid(), endpointId: endpoint.endpoint.journal.id, url: endpoint.url,
    credentialFile: endpoint.connection.credentialFile, revision: 0, name: 'Remote test' })
  const command = await h.runtime.endpoints.submit(registered.id, { revision: registered.revision, request: { op: 'grant.create', requestId: rid(), owner: 'coordinator', workspace: 'inbox-world', operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 } })
  const world = await h.runtime.worlds.activate({ requestId: rid(), endpointId: registered.id, commandId: command.id, name: 'Selected remote workspace' })
  const settings = h.runtime.store.settings(); h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, directory: join(h.directory, 'not-enrolled') } })
  expect(h.runtime.inbox.setup().defaultEnvironment.available).toBe(false)
  const body = { requestId: rid(), text: 'Work in the selected environment', environment: world.id }, item = h.runtime.inbox.start(body)
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(item.id)!, agent = h.ctx.agents.get(`worker-${item.id}` as never)!
  expect(ticket.execution?.directory.startsWith(world.root + '/')).toBe(true)
  expect(item.execution?.environment).toMatchObject({ grant: { world: world.id }, description: { name: world.name, kind: 'remote' } })
  expect(() => h.runtime.worlds.assertMounted(agent, world.id)).not.toThrow()
  await h.runtime.worlds.revoke(world.id, { requestId: rid(), revision: world.revision, reason: 'End authorization' })
  expect(() => h.runtime.inbox.start({ ...body, requestId: rid() })).toThrow()
  expect(h.runtime.inbox.start(body).id).toBe(item.id); expect(h.runtime.store.tickets.list()).toHaveLength(1)
}, 15000)
