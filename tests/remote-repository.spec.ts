import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/app/store.ts'
import { WorldPool } from '../src/environments/pool.ts'
import { RepositorySource } from '../src/environments/repository-model.ts'
import { verifyRegistryState } from '../src/recovery/registries.ts'
import { runAsWorker } from '../src/infra/environment.ts'
import { repositoryFixture } from './fixtures/repository.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const close of cleanup.reverse()) await close(); cleanup.length = 0 })
const rid = () => randomUUID()
const fixture = () => repositoryFixture(cleanup)

it.each(['https://user:secret@example.com/source.git', 'https://example.com/source.git?token=secret', 'file:///tmp/source', 'ssh://example.com/source', 'https://example.com/source#branch'])('rejects unpinned or credential-bearing repository source %s', url => {
  expect(RepositorySource.safeParse({ url, commit: 'a'.repeat(40) }).success).toBe(false)
  expect(RepositorySource.safeParse({ url: 'https://example.com/source.git', commit: 'main' }).success).toBe(false)
})

it('prepares an authenticated pinned commit once, preserves task commits and resumes by receipt after coordinator replacement', async () => {
  const { h, remote, server, activation, world, member, prepare } = await fixture()
  const upstream = await server.advance(); expect(upstream).not.toBe(server.commit)
  await prepare('task-one')
  const directory = join(world.root, 'task-one'), file = await member.filesystem.resolve(join(directory, 'input.txt'))
  expect(await member.filesystem.readText(file)).toBe('original source\n')
  const git = (...args: string[]) => member.world.withOwner({ kind: 'host', purpose: 'repository-qualification' }, () => {},
    () => runAsWorker(member.subprocess, ['git', ...args], directory, h.runtime.lifetime))
  expect((await git('symbolic-ref', '--short', 'HEAD')).trim()).toBe('agentic/task-one')
  await member.world.withOwner({ kind: 'host', purpose: 'repository-qualification' }, () => {}, () => member.filesystem.writeText(file, 'task change\n'))
  await git('add', 'input.txt'); await git('-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.invalid', 'commit', '-m', 'Task work')
  const changed = (await git('rev-parse', 'HEAD')).trim(), calls = server.requests()
  await prepare('task-one')
  expect((await git('rev-parse', 'HEAD')).trim()).toBe(changed); expect(server.requests()).toBe(calls)
  expect(remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-'))).toHaveLength(1)
  expect(JSON.stringify(h.runtime.worlds.get(world.id)).includes(server.token)).toBe(false)
  expect(JSON.stringify(remote.endpoint.journal.jobs()).includes(server.token)).toBe(false)
  await expect(h.runtime.worlds.activate({ ...activation, requestId: rid(), repository: { ...activation.repository, commit: upstream } })).rejects.toThrow('different repository source')
  await h.runtime.worlds.stop()
  const ctx = new Context(), store = new Store(join(h.directory, 'orchestrator.sqlite'))
  ctx.reflect.provide('agentPresets', h.ctx.get('agentPresets'))
  const pool = new WorldPool(ctx, { store, endpoints: h.runtime.endpoints, lifetime: h.runtime.lifetime, report: () => {} })
  cleanup.push(async () => { await pool.stop(); store.close(); await ctx.fiber.dispose() })
  await pool.initialize()
  expect(pool.get(world.id).repository).toEqual(activation.repository)
  const recovered = pool.require(world.id)
  await recovered.world.withOwner({ kind: 'host', purpose: 'restart-observation' }, () => {}, () => recovered.workspace.prepareRepository(directory, 'task-one'))
  expect(await recovered.filesystem.readText(await recovered.filesystem.resolve(join(directory, 'input.txt')))).toBe('task change\n')
  expect(server.requests()).toBe(calls)
}, 30000)

it('launches two mission actions on separate repository branches through the existing executor', async () => {
  const { h, world, member, remote } = await fixture(), workspace = h.runtime.workspace
  let mission = workspace.create({ requestId: rid(), title: 'Repository mission', objective: 'Work on source', acceptance: 'Two independent tasks' })
  for (const title of ['First change', 'Second change']) mission = workspace.add(mission.id, { requestId: rid(), revision: mission.revision,
    title, instructions: 'Inspect the pinned source and make the requested change', owner: 'agent', environment: world.id })
  for (const action of mission.actions) {
    mission = workspace.get(mission.id)
    workspace.act(mission.id, action.id, { requestId: rid(), revision: mission.revision, command: 'run' })
  }
  await h.runtime.idle()
  const tickets = workspace.get(mission.id).actions.map(action => h.runtime.store.tickets.get(action.runs[0]!)!)
  for (const ticket of tickets) {
    expect(ticket.assignments.at(-1)?.state).toBe('running')
    const file = await member.filesystem.resolve(join(ticket.execution!.directory, 'input.txt'))
    expect(await member.filesystem.readText(file)).toBe('original source\n')
    const receipt = remote.endpoint.journal.jobs().find(job => job.id.startsWith('repository-') && job.request.owner?.kind === 'assignment' && job.request.owner.ticketId === ticket.id)!
    expect(receipt).toMatchObject({ quiescent: true, outcome: { exitCode: 0 }, request: { owner: { tool: 'workspace-prepare' } } })
  }
  expect(tickets[0]!.execution!.directory).not.toBe(tickets[1]!.execution!.directory)
}, 30000)

it('deduplicates a lost preparation response and never adopts or replaces an existing task directory', async () => {
  const { server, remote, world, prepare } = await fixture()
  const original = fetch; let lost = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init)
    const request = init?.body && JSON.parse(String(init.body))
    if (!lost && request?.op === 'job.spawn' && request.requestId.startsWith('repository-')) { lost = true; await response.arrayBuffer(); throw new TypeError('Lost acknowledgement') }
    return response
  })
  await prepare('response-loss')
  expect(lost).toBe(true); expect(remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-'))).toHaveLength(1)
  const before = server.requests(), directory = join(world.root, 'existing')
  await mkdir(directory); await writeFile(join(directory, 'keep.txt'), 'existing work')
  await expect(prepare('existing')).rejects.toThrow('preparation failed')
  expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('existing work'); expect(server.requests()).toBe(before)
  await expect(prepare('existing')).rejects.toThrow('preparation failed')
  expect(remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-'))).toHaveLength(2)
}, 30000)

it('stops an in-flight repository fetch before creating the worker and retains the cancelled preparation', async () => {
  const { h, remote, server, prepare } = await fixture(), workspace = h.runtime.workspace
  server.block()
  let mission = workspace.create({ requestId: rid(), title: 'Cancelled checkout', objective: 'Stop during fetch', acceptance: 'No worker starts' })
  mission = workspace.add(mission.id, { requestId: rid(), revision: mission.revision, title: 'Prepare source', instructions: 'Inspect source',
    owner: 'agent', environment: h.runtime.worlds.list().items[0]!.id })
  mission = workspace.act(mission.id, mission.actions[0]!.id, { requestId: rid(), revision: mission.revision, command: 'run' })
  const idle = h.runtime.idle(), ticketId = mission.actions[0]!.runs[0]!
  await vi.waitFor(() => expect(server.requests()).toBeGreaterThan(0), { timeout: 10000 })
  const original = remote.endpoint.journal.jobs().find(job => job.id.startsWith('repository-'))!
  expect(original.phase).toBe('started')
  mission = workspace.get(mission.id)
  workspace.act(mission.id, mission.actions[0]!.id, { requestId: rid(), revision: mission.revision, command: 'stop' })
  await idle
  await vi.waitFor(() => expect(remote.endpoint.journal.job(original.id)).toMatchObject({ cancelRequested: true, quiescent: true }), { timeout: 10000 })
  expect(remote.endpoint.journal.job(original.id).outcome?.exitCode).not.toBe(0)
  expect(h.agents.has('worker-' + ticketId)).toBe(false)
  const before = server.requests()
  await expect(prepare(ticketId, h.runtime.store.tickets.get(ticketId)!.execution!.directory)).rejects.toThrow('preparation failed')
  expect(remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-'))).toHaveLength(1); expect(server.requests()).toBe(before)
  server.release()
}, 30000)

it('refuses an explicitly simulated unknown receipt without fetching or inventing a replacement command', async () => {
  const { remote, server, prepare } = await fixture()
  await prepare('unknown-preparation')
  const original = remote.endpoint.journal.jobs().find(job => job.id.startsWith('repository-'))!, before = server.requests()
  original.phase = 'unknown'; original.quiescent = null; delete original.outcome
  remote.endpoint.journal.saveJob(original)
  await expect(prepare('unknown-preparation')).rejects.toThrow('interrupted')
  expect(remote.endpoint.journal.jobs().filter(job => job.id.startsWith('repository-'))).toHaveLength(1); expect(server.requests()).toBe(before)
}, 30000)

it('does not replace an empty task directory created while the fetch is in flight', async () => {
  const { world, server, prepare } = await fixture(), directory = join(world.root, 'concurrent-directory')
  server.block()
  const preparation = prepare('concurrent-directory')
  const failure = expect(preparation).rejects.toThrow('durable publication')
  await vi.waitFor(() => expect(server.requests()).toBeGreaterThan(0), { timeout: 10000 })
  await mkdir(directory); const identity = (await stat(directory)).ino
  server.release(); await failure
  expect((await stat(directory)).ino).toBe(identity)
  await expect(stat(join(directory, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 30000)

it('preserves repository configuration during registry recovery and rejects an unbound credential', async () => {
  const { h, world, activation } = await fixture()
  const db = h.runtime.store.db, record = JSON.parse(String(db.prepare('SELECT value FROM managed_world WHERE id=?').get(world.id)!.value))
  const journal = new DatabaseSync(join(record.config.stateDir, 'world.sqlite'), { readOnly: true })
  let worlds
  try { worlds = [JSON.parse(String(journal.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value))] }
  finally { journal.close() }
  const context = { masterId: h.runtime.masterId, worlds, sessions: [] }, signal = new AbortController().signal
  expect(await verifyRegistryState(db, context, signal)).toMatchObject({ managedWorlds: 1 })
  expect(h.runtime.worlds.get(world.id).repository).toEqual(activation.repository)
  record.repository.credentialId = 'unbound-token'
  db.prepare('UPDATE managed_world SET value=? WHERE id=?').run(JSON.stringify(record), world.id)
  await expect(verifyRegistryState(db, context, signal)).rejects.toThrow('managed_repository_grant')
  await expect(h.runtime.worlds.activate({ ...activation, requestId: rid(), repository: record.repository })).rejects.toThrow('explicitly bound')
})
