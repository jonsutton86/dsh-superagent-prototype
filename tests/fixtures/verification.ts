import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { Store } from '../../src/app/store.ts'
import { Library } from '../../src/workspace/library.ts'
import { Workspace } from '../../src/workspace/service.ts'
import { Engine } from '../../src/core/index.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { settingsPolicy } from '../../src/policy.ts'
import { Verification } from '../../src/verification/service.ts'
import { VerificationReviews } from '../../src/verification/reviews.ts'
import { MissionReviews } from '../../src/verification/missions.ts'
import type { LibraryEntry } from '../../src/workspace/library-model.ts'
import type { CheckRun } from '../../src/verification/contracts.ts'
import { remoteFixture } from './remote.ts'
import { RemoteWorld } from '../../src/remote/world.ts'
import type { ExecutionLocation } from '../../src/core/model.ts'
import { HostProcessIsolation } from '../../src/verification/local.ts'

/** Real Store, Engine and Harness subprocesses; fixture files stand in for model-authored outputs. */
export async function verificationFixture(cleanup: (() => Promise<unknown>)[], native = false, remoteHost = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-evidence-review-')), ctx = new Context()
  let source = join(directory, 'source')
  await mkdir(source)
  const store = new Store(join(directory, 'store.sqlite')), library = new Library(store), lifetime = new AbortController(), subprocess = new LocalSubprocessRuntime(ctx)
  cleanup.push(async () => { store.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const remote = native || remoteHost ? await remoteFixture(cleanup, { native }) : undefined
  if (remote && !native) {
    remote.host.isolation = new HostProcessIsolation(); remote.host.snapshotHelper = resolve('src/verification/snapshot-worker.ts')
    // Permit protocol composition on non-Linux fixtures; actual check evidence must still say host-process.
    vi.spyOn(remote.endpoint, 'identity').mockReturnValue({ ...remote.endpoint.identity(), confinement: 'linux-bubblewrap' })
  }
  const world = remote && new RemoteWorld({ ...remote.client.connection, stateDir: join(directory, 'remote-world') })
  if (world) { cleanup.push(() => world.close()); await world.start(); source = world.grant.root }
  const environment = world && { environmentId: 'remote-fixture', epoch: world.grant.epoch, revision: world.grant.revision, world: world.status().binding }
  let offset = 0, engine: Engine
  const verifyHost = { store, library, stateDir: directory, subprocess, lifetime: lifetime.signal, authorize: () => {},
    allowed: () => true, localAllowed: () => !remote, remote: (location: ExecutionLocation) => location.environment?.world === environment?.world ? world : undefined }
  const verification = new Verification(verifyHost), reviewHost = { store, verification, lifetime: lifetime.signal, authorize: () => {}, now: () => Date.now() + offset }
  const reviews = new VerificationReviews(reviewHost), missionReviews = new MissionReviews(store, library, verification, reviews)
  cleanup.push(async () => { await reviews.stop(); await verification.stop() })
  const workspace = new Workspace(store, () => engine, () => true, id => library.evidenceRevision(id), undefined, undefined, undefined, undefined, missionReviews)
  const sources = new SourceRegistry(() => store.settings()); sources.register(workspace.source)
  engine = new Engine({ repo: store, scope: sources, policy: () => workspace.policy(settingsPolicy(store.settings(), sources)),
    executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }, assessor: { request: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    prepareTicket: ticket => ({ ...ticket, execution: { name: 'fixture', directory: source, mode: 'local', assignment: ticket.id, ...(environment ? { environment } : {}) } }) })
  let mission = workspace.create({ requestId: randomUUID(), title: 'Reviewed outputs', objective: 'Deliver actual checked outputs', acceptance: 'All selected artifacts have current host evidence' })
  mission = workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Produce artifacts', instructions: 'Prepare results', owner: 'agent' })
  mission = workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
  const ticket = store.tickets.get(mission.actions[0]!.ticket!.id)!, actor = { role: 'worker' as const, ticketId: ticket.id }
  engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  const artifact = async (filename = 'artifact.txt', content = 'evidence') => {
    await writeFile(join(source, filename), content)
    return library.publish({ requestId: randomUUID(), kind: 'artifact', title: filename, summary: 'Fixture result', filename, content }, actor)
  }
  const settled = async (id: string) => {
    let run!: CheckRun
    await vi.waitFor(async () => { run = await verification.refresh(id); expect(run.quiescent, run.problem).toBe(true) }, { timeout: 20000 })
    return run
  }
  const check = async (record: LibraryEntry, argv = ['/bin/sh', '-c', `test -s '${record.filename}'`]) => {
    const definition = verification.definitions.create({ requestId: randomUUID(), enabled: true, definition: { name: `Check ${record.filename}`, description: 'Verify captured fixture bytes',
      artifactPath: record.filename, argv, confinement: native ? 'linux-bubblewrap' : 'host-process' } })
    const run = await verification.request(record.id, { requestId: randomUUID(), check: { id: definition.id, version: 1 }, artifactRevision: record.revision, artifactHash: record.hash })
    const passed = await settled(run.id); expect(passed.status, passed.problem).toBe('passed')
    return { run: passed, selection: verification.approval(run.id).selection, definition }
  }
  return { directory, source, store, library, lifetime, verification, verifyHost, reviews, reviewHost, missionReviews, workspace, engine, mission, ticket, actor, artifact, check, settled, remote,
    advance: (milliseconds: number) => { offset += milliseconds }, ready: () => { engine.report(ticket.id, { state: 'ready', summary: 'Fixture outputs ready for review' }); return workspace.get(mission.id) } }
}
