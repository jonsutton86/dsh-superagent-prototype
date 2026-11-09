import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Library } from '../src/workspace/library.ts'
import { Verification } from '../src/verification/service.ts'
import { CheckDefinitions } from '../src/verification/definitions.ts'
import { CheckDefinition, RequestCheck, type CheckRecord, type CheckRun } from '../src/verification/contracts.ts'
import { inputTicket } from './fixtures/recovery-inputs.ts'
import { startRuntime } from './fixtures/host.ts'
import { remoteFixture } from './fixtures/remote.ts'
import { RemoteWorld } from '../src/remote/world.ts'
import type { RemoteJob } from '../src/remote/protocol.ts'

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
const rid = () => randomUUID(), hash = (value: string) => createHash('sha256').update(value).digest('hex')
const definition = (extra: Record<string, unknown> = {}) => CheckDefinition.parse({ name: 'Artifact contents', description: 'Check the exact captured artifact',
  argv: ['/bin/sh', '-c', 'test "$(cat artifact.txt)" = evidence && printf checked'], artifactPath: 'artifact.txt', confinement: 'host-process', ...extra })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-verification-service-')), root = join(directory, 'source'), ctx = new Context()
  await mkdir(root); await writeFile(join(root, 'artifact.txt'), 'evidence')
  const store = new Store(join(directory, 'state.sqlite')), library = new Library(store), subprocess = new LocalSubprocessRuntime(ctx), lifetime = new AbortController()
  cleanup.push(async () => { store.close(); await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const ticket = inputTicket(); ticket.execution = { name: 'fixture', directory: root, mode: 'local', assignment: 'assignment' }
  ticket.assignments[0]!.execution = { directory: root, mode: 'local' }; store.tickets.save(ticket)
  const actor = { role: 'worker' as const, ticketId: ticket.id }
  const artifact = library.publish({ requestId: rid(), kind: 'artifact', title: 'Artifact', summary: 'Checked result', filename: 'artifact.txt', content: 'evidence' }, actor)
  const host: ConstructorParameters<typeof Verification>[0] = { store, library, stateDir: directory, subprocess, lifetime: lifetime.signal, authorize: () => {},
    allowed: () => true, localAllowed: () => true, remote: () => undefined, paused: () => false }
  const service = new Verification(host); cleanup.push(() => service.stop())
  const check = service.definitions.create({ requestId: rid(), definition: definition(), enabled: true, workers: true })
  const request = (c: CheckRecord = check) => ({ requestId: rid(), check: { id: c.id, version: c.version }, artifactRevision: artifact.revision, artifactHash: artifact.hash })
  const settled = async (id: string) => { let run!: CheckRun; await vi.waitFor(() => { run = service.get(id); expect(run.quiescent, run.problem).toBe(true) }, { timeout: 10000 }); return run }
  return { directory, root, store, library, host, service, check, actor, artifact, request, settled, ticket }
}

it('pins immutable check versions and replays lost registry responses without rewriting authority or versions', async () => {
  const h = await fixture(), defs = h.service.definitions, original = defs.version(h.check.id, 1)
  const input = { requestId: rid(), revision: 1, definition: definition({ argv: ['/bin/false'] }) }, updated = defs.update(h.check.id, input)
  const disabled = defs.configure(h.check.id, { requestId: rid(), revision: 2, enabled: false, workers: false, reason: 'Retire command' })
  expect(disabled).toMatchObject({ version: 2, revision: 3, enabled: false })
  const next = new CheckDefinitions(h.store)
  expect(next.update(h.check.id, input)).toEqual(updated); expect(next.version(h.check.id, 1)).toEqual(original)
  expect(() => next.update(h.check.id, { ...input, definition: definition() })).toThrow('different operation')
  expect(() => next.update(h.check.id, { ...input, requestId: rid() })).toThrow('changed')
  expect(() => RequestCheck.parse({ ...h.request(), argv: ['/bin/true'], status: 'passed' })).toThrow()
  expect(() => definition({ env: { API_KEY: 'forbidden' } })).toThrow()
  expect(() => definition({ artifactPath: '../outside' })).toThrow()
})

it('executes once over host-captured bytes, retains full output hashes and preserves the exact receipt across restart', async () => {
  const h = await fixture(), input = h.request()
  const results = await Promise.all([h.service.request(h.artifact.id, input, h.actor), h.service.request(h.artifact.id, input, h.actor)])
  expect(results.map(run => run.id)).toEqual([input.requestId, input.requestId])
  const run = await h.settled(input.requestId)
  expect(run, run.problem).toMatchObject({ status: 'passed', quiescent: true, outcome: { exitCode: 0, signal: null },
    execution: { directory: h.root, assignmentId: 'assignment', sessionId: 'worker-ticket' }, evidence: {
      confinement: 'host-process', snapshotUnchanged: true, storageReleased: true, artifactHash: h.artifact.hash,
      output: { stdout: { hash: hash('checked'), bytes: 7 }, stderr: { bytes: 0 } } } })
  const output = await h.service.output(run.id, { stream: 'stdout' }, h.actor)
  expect(Buffer.from(output.data, 'base64').toString()).toBe('checked')
  expect(h.service.list(h.artifact.id).items[0]!.evidence!.snapshot).not.toHaveProperty('entries')
  await h.service.stop(); const restored = new Verification(h.host); cleanup.push(() => restored.stop())
  await writeFile(join(h.root, 'artifact.txt'), 'changed')
  expect(await restored.request(h.artifact.id, input, h.actor)).toEqual(run)
  await expect(restored.request(h.artifact.id, { ...input, artifactHash: hash('different') }, h.actor)).rejects.toThrow('different check')
  expect(h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n).toBe(1)
})

it('captures freshness without rerunning the command and detects other source changes even when the artifact is unchanged', async () => {
  const h = await fixture(), marker = join(h.directory, 'executions')
  const check = h.service.definitions.create({ requestId: rid(), enabled: true, definition: definition({ argv: [process.execPath, '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`] }) })
  const first = await h.service.request(h.artifact.id, h.request(check)), passed = await h.settled(first.id)
  expect(passed.status, passed.problem).toBe('passed')
  const capture = await h.service.freshness(first.id, rid()), fresh = await h.settled(capture.id)
  expect(fresh).toMatchObject({ purpose: 'freshness', sourceCheckId: first.id, status: 'captured', evidence: { kind: 'capture' } })
  expect(fresh.outcome).toBeUndefined(); expect(fresh.evidence?.checkedAt).toBeUndefined()
  await writeFile(join(h.root, 'dependency.txt'), 'new source')
  const changed = await h.service.freshness(first.id, rid()), stale = await h.settled(changed.id)
  expect(stale).toMatchObject({ status: 'failed', problem: expect.stringContaining('reviewed snapshot') })
  expect(await readFile(marker, 'utf8')).toBe('x'); expect(h.service.get(first.id).status).toBe('passed')
})

it('checks a historical artifact in its original environment after a task retry and refuses the old worker assignment', async () => {
  const h = await fixture(), another = join(h.directory, 'retry'); await mkdir(another)
  const ticket = h.store.tickets.get(h.ticket.id)!
  ticket.assignments[0]!.state = 'ended'
  ticket.assignments.push({ id: 'retry', state: 'running', createdAt: new Date().toISOString(), execution: { directory: another, mode: 'local' } })
  ticket.execution = { name: 'retry', directory: another, mode: 'local', assignment: 'retry' }; h.store.tickets.save(ticket)
  await expect(h.service.request(h.artifact.id, h.request(), h.actor)).rejects.toThrow('no longer authorizes')
  const operator = await h.service.request(h.artifact.id, h.request()), result = await h.settled(operator.id)
  expect(result.status, result.problem).toBe('passed'); expect(result.execution.directory).toBe(h.root)
  expect(h.library.read(h.artifact.id).execution?.assignmentId).toBe('assignment')
  const newArtifact = h.library.publish({ requestId: rid(), kind: 'artifact', title: 'Retry', summary: 'New result', content: 'new' }, h.actor)
  expect(newArtifact.execution).toMatchObject({ directory: another, assignmentId: 'retry' })
})

it('refuses revoked, unbound or unavailable remote execution and never selects a local replacement', async () => {
  const h = await fixture()
  h.host.allowed = () => false
  await expect(h.service.request(h.artifact.id, h.request())).rejects.toThrow('revoked')
  h.host.allowed = () => true; h.host.localAllowed = () => false
  await expect(h.service.request(h.artifact.id, h.request())).rejects.toThrow('cannot fall back')
  h.host.localAllowed = () => true
  const unbound = h.library.publish({ requestId: rid(), kind: 'artifact', title: 'Legacy', summary: 'No binding', content: 'evidence' })
  await expect(h.service.request(unbound.id, { ...h.request(), artifactHash: unbound.hash })).rejects.toThrow('no host-recorded')
  h.service.definitions.configure(h.check.id, { requestId: rid(), revision: 1, enabled: false, workers: true, reason: 'Revoke' })
  await expect(h.service.request(h.artifact.id, h.request())).rejects.toThrow('disabled')
  expect(h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n).toBe(0)
})

it('enforces worker scope, atomically reserves concurrency and stops cancellation without inventing a pass', async () => {
  const h = await fixture(), check = h.service.definitions.create({ requestId: rid(), enabled: true, workers: true,
    definition: definition({ argv: ['/bin/sh', '-c', 'printf started; sleep 30'] }) })
  const started = await h.service.request(h.artifact.id, h.request(check), h.actor)
  await expect(h.service.request(h.artifact.id, h.request(check), h.actor)).rejects.toThrow('allowance')
  await vi.waitFor(() => expect(h.service.get(started.id).evidence?.stage).toBe('checking'), { timeout: 10000 })
  const other = inputTicket('other'); h.store.tickets.save(other)
  expect(() => h.service.get(started.id, { role: 'worker', ticketId: other.id })).toThrow()
  const cancellation = { requestId: rid(), reason: 'Operator stopped this check' }
  await h.service.cancel(started.id, cancellation)
  const stopped = await h.settled(started.id)
  expect(stopped.status).toBe('failed'); expect(stopped.cancel).toMatchObject(cancellation)
  expect(await h.service.cancel(started.id, cancellation)).toEqual(stopped)
  await expect(h.service.freshness(started.id, rid())).rejects.toThrow('passed host check')
  await expect(h.service.cancel(started.id, { ...cancellation, reason: 'Changed' })).rejects.toThrow('another operation')
})

it('keeps crash-boundary runs unknown and requires explicit quiescence reconciliation without redispatch', async () => {
  const h = await fixture(), input = h.request(), run = await h.service.request(h.artifact.id, input); await h.settled(run.id); await h.service.stop()
  const row = h.store.db.prepare('SELECT value FROM verification_run WHERE id=?').get(run.id)!, stored = JSON.parse(String(row.value))
  stored.status = 'running'; stored.quiescent = false; delete stored.outcome; stored.evidence.stage = 'checking'; delete stored.evidence.finishedAt
  h.store.db.prepare('UPDATE verification_run SET value=? WHERE id=?').run(JSON.stringify(stored), run.id)
  const next = new Verification(h.host); cleanup.push(() => next.stop())
  expect(await next.request(h.artifact.id, input)).toMatchObject({ status: 'unknown', quiescent: false })
  const reconciled = await next.reconcile(run.id, { requestId: rid(), reason: 'Original local host confirmed stopped', quiescent: true })
  expect(reconciled).toMatchObject({ status: 'unknown', quiescent: true }); expect(reconciled.outcome).toBeUndefined()
  await expect(next.freshness(run.id, rid())).rejects.toThrow('passed host check')
})

it('exposes operator-only immutable definitions through the management API and refuses command injection in requests', async () => {
  const host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true }); cleanup.push(() => host.stop())
  const create = { requestId: rid(), definition: definition() }, response = await host.api('POST', 'checks', create)
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ enabled: false, workers: false, version: 1 })
  const id = response.body.id
  expect((await host.api('GET', 'checks')).body.items).toHaveLength(1)
  expect((await host.api('GET', `checks/${id}/versions/1`)).body.definition).toEqual(create.definition)
  expect((await host.api('POST', `checks/${id}/authority`, { requestId: rid(), revision: 1, enabled: true, workers: true, reason: 'Reviewed command' })).status).toBe(200)
  expect((await host.api('POST', `library/${rid()}/verification`, { requestId: rid(), check: { id, version: 1 }, artifactRevision: 1, artifactHash: hash('x'), argv: ['sh'] })).status).toBe(400)
})

it('rejects a changed artifact file and keeps a timed-out zero-exit command from passing', async () => {
  const h = await fixture(); await writeFile(join(h.root, 'artifact.txt'), 'different')
  const mismatch = await h.service.request(h.artifact.id, h.request()), refused = await h.settled(mismatch.id)
  expect(refused).toMatchObject({ status: 'failed', problem: expect.stringContaining('artifact') }); expect(refused.outcome).toBeUndefined()
  await writeFile(join(h.root, 'artifact.txt'), 'evidence')
  const timeout = h.service.definitions.create({ requestId: rid(), enabled: true, definition: definition({ timeoutSeconds: 1, argv: ['/bin/sh', '-c', "trap 'exit 0' TERM; sleep 30 & wait"] }) })
  const requested = await h.service.request(h.artifact.id, h.request(timeout)), result = await h.settled(requested.id)
  expect(result.status).toBe('failed'); expect(result.evidence?.problem).toBeTruthy()
})

it('retains complete output hashes while exposing bounded logs and explicit retention gaps', async () => {
  const h = await fixture(), check = h.service.definitions.create({ requestId: rid(), enabled: true,
    definition: definition({ argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(1100000))"] }) })
  const run = await h.service.request(h.artifact.id, h.request(check)), result = await h.settled(run.id)
  expect(result.status, result.problem).toBe('passed'); expect(result.evidence?.output?.stdout).toEqual({ bytes: 1100000, hash: hash('x'.repeat(1100000)) })
  expect(await h.service.output(run.id, { stream: 'stdout', offset: 1048576 })).toMatchObject({ data: '', gap: true, retainedBytes: 1048576, totalBytes: 1100000, nextOffset: 1100000 })
  await expect(h.service.output(run.id, { stream: 'stdout', offset: 1100001 })).rejects.toThrow('ahead')
})

it('withdraws active check authority, reclaims local storage and never promotes the cancelled result', async () => {
  const h = await fixture(), check = h.service.definitions.create({ requestId: rid(), enabled: true, workers: true,
    definition: definition({ argv: ['/bin/sh', '-c', 'sleep 30'] }) })
  h.service.start(); const run = await h.service.request(h.artifact.id, h.request(check), h.actor)
  await vi.waitFor(() => expect(h.service.get(run.id).evidence?.stage).toBe('checking'), { timeout: 10000 })
  h.service.definitions.configure(check.id, { requestId: rid(), revision: 1, enabled: false, workers: false, reason: 'Authority withdrawn' })
  const result = await h.settled(run.id)
  expect(result.status).toBe('failed'); expect(result.cancel?.reason).toContain('disabled'); expect(result.evidence?.storageReleased).toBe(true)
})

it('holds requests before dispatch when paused, refuses excess UTC-day runs and prevents assignment-location substitution', async () => {
  const h = await fixture(); h.host.paused = () => true
  await expect(h.service.request(h.artifact.id, h.request())).rejects.toThrow('paused')
  h.host.paused = () => false
  const check = h.service.definitions.create({ requestId: rid(), enabled: true, definition: definition({ maxRunsPerDay: 1 }) })
  const run = await h.service.request(h.artifact.id, h.request(check)); await h.settled(run.id)
  await expect(h.service.request(h.artifact.id, h.request(check))).rejects.toThrow('allowance')
  const ticket = h.store.tickets.get(h.ticket.id)!; ticket.execution!.directory = join(h.directory, 'elsewhere'); h.store.tickets.save(ticket)
  expect(() => h.library.publish({ requestId: rid(), kind: 'artifact', title: 'Forged location', summary: 'Wrong assignment', content: 'evidence' }, h.actor)).toThrow('original assignment')
})

it.runIf(process.platform !== 'linux')('refuses Linux-required checks on a host that cannot supply that confinement', async () => {
  const h = await fixture(), check = h.service.definitions.create({ requestId: rid(), enabled: true, definition: definition({ confinement: 'linux-bubblewrap' }) })
  await expect(h.service.request(h.artifact.id, h.request(check))).rejects.toThrow()
  expect(h.store.db.prepare('SELECT count(*) AS n FROM verification_run').get()!.n).toBe(0)
})

it.runIf(process.env.DSH_REMOTE_ISOLATION === '1')('binds real Linux endpoint evidence to original assignment receipts and observes the same job across restart', async () => {
  const h = await fixture(), remoteStops: (() => Promise<unknown>)[] = []
  cleanup.push(async () => { for (const stop of remoteStops.reverse()) await stop() })
  const remote = await remoteFixture(remoteStops, { native: true }), world = new RemoteWorld({ ...remote.client.connection, stateDir: join(h.directory, 'remote-world') })
  cleanup.push(() => world.close()); cleanup.push(() => h.service.stop()); await world.start()
  const environment = { environmentId: 'remote-fixture', epoch: world.grant.epoch, revision: world.grant.revision, world: world.status().binding }
  const ticket = h.store.tickets.get(h.ticket.id)!
  ticket.execution = { name: 'remote', directory: world.grant.root, mode: 'local', assignment: 'assignment', environment }
  ticket.assignments[0]!.execution = { directory: world.grant.root, mode: 'local', environment }; h.store.tickets.save(ticket)
  await writeFile(join(world.grant.root, 'artifact.txt'), 'evidence')
  const artifact = h.library.publish({ requestId: rid(), kind: 'artifact', title: 'Remote artifact', summary: 'Actual endpoint result', content: 'evidence' }, h.actor)
  h.host.remote = location => location.environment?.world === environment.world ? world : undefined; h.host.localAllowed = () => false
  const check = h.service.definitions.create({ requestId: rid(), enabled: true, workers: true, definition: definition({ confinement: 'linux-bubblewrap' }) })
  const input = { ...h.request(check), artifactRevision: artifact.revision, artifactHash: artifact.hash }, client = world.executionClient(), send = client.intent.bind(client)
  vi.spyOn(client, 'intent').mockImplementationOnce(async (...args) => {
    remote.lose(); const accepted = await send(...args) as RemoteJob
    await remote.settled(accepted.id); await h.service.refresh(accepted.id)
    throw new Error('Older spawn acknowledgement failed after successful original-job observation')
  })
  const initial = await h.service.request(artifact.id, input, h.actor)
  await vi.waitFor(async () => expect((await h.service.refresh(initial.id)).status).toBe('passed'), { timeout: 20000 })
  const passed = h.service.get(initial.id)
  expect(passed.evidence).toMatchObject({ confinement: 'linux-bubblewrap', artifactHash: artifact.hash, snapshotUnchanged: true })
  expect(world.executionReceipt(initial.id)?.owner).toMatchObject({ kind: 'assignment', assignmentId: 'assignment', tool: 'artifact_verification' })
  expect(remote.endpoint.journal.jobs()).toHaveLength(1)
  await h.service.stop(); await remote.restart()
  const next = new Verification(h.host); cleanup.push(() => next.stop())
  expect(await next.request(artifact.id, input, h.actor)).toEqual(passed)
  expect(await next.refresh(initial.id)).toMatchObject({ status: 'passed', evidence: passed.evidence })
  const raw = await remote.client.call<RemoteJob>({ op: 'job.get', id: initial.id }); expect(raw.credentials).toBeUndefined()
  expect(Buffer.from((await next.output(initial.id, { stream: 'stdout' })).data, 'base64').toString()).toBe('checked')
  expect(remote.endpoint.journal.jobs()).toHaveLength(1)
})
