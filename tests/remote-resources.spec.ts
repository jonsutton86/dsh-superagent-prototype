import { pathToFileURL } from 'node:url'
import { WorkspaceCaptures } from '../src/remote/workspace-capture.ts'
import { captureWorkspaceRecovery } from '../src/recovery/workspace-archive.ts'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CgroupResources } from '../src/remote/resources.ts'
import { EndpointResources, budgetFiles } from '../src/remote/resource-model.ts'
import { FakeCgroup } from './fixtures/cgroup.ts'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, realpath, rm, rmdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { RemoteEndpoint } from '../src/remote/endpoint.ts'
import { BubblewrapIsolation } from '../src/remote/isolation.ts'
import { confinedFilesystem } from '../src/remote/filesystem-runner.ts'
import type { GrantReceipt, RemoteJob, RemoteOperation } from '../src/remote/protocol.ts'

const policy: EndpointResources = { cgroupRoot: '/delegated', pool: { cpuPercent: 200, memoryBytes: 1024 ** 3, processes: 128 },
  command: { cpuPercent: 100, memoryBytes: 256 * 1024 ** 2, processes: 32 } }
const cleanup: CgroupResources[] = []
afterEach(() => { for (const resources of cleanup.splice(0)) resources.close(); vi.restoreAllMocks() })
function fixture(io = new FakeCgroup(), configured = policy) {
  const resources = new CgroupResources(configured, io), id = randomUUID(); cleanup.push(resources); resources.start(id)
  const pool = join(io.root, 'dsh-' + id), done = Promise.withResolvers<SubprocessOutcome>()
  const handle: SubprocessHandle = { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {},
    done: done.promise, terminate: vi.fn(), waitForExit: vi.fn(async () => true) }
  const base = { spawn: vi.fn(() => handle), resolveExecutable: vi.fn(async (name: string) => '/usr/bin/' + name) } as unknown as SubprocessRuntime
  const runtime = resources.decorate(base, resolve('lib/remote-resource-worker.js'))
  const spec: SubprocessSpawnSpec = { argv: ['/usr/bin/bwrap', '--', '/bin/sh', '-c', 'printf proof'], cwd: '/work', graceMs: 10,
    stdio: { stdin: { data: 'input' }, stdout: 'pipe', stderr: 'pipe' } }
  return { io, resources, pool, base, runtime, handle, done, spec }
}

it('rejects unsupported platforms, ordinary filesystems, populated delegation roots and missing controllers', () => {
  const io = new FakeCgroup(); io.platform = 'darwin'
  expect(() => new CgroupResources(policy, io)).toThrow('no unbounded fallback')
  io.platform = 'linux'; io.type = 123
  expect(() => new CgroupResources(policy, io).start(randomUUID())).toThrow('cgroup v2')
  io.type = 0x63677270; io.files.set('/delegated/cgroup.procs', '42')
  expect(() => new CgroupResources(policy, io).start(randomUUID())).toThrow('no processes')
  io.files.set('/delegated/cgroup.procs', ''); io.files.set('/delegated/cgroup.controllers', 'memory pids')
  expect(() => new CgroupResources(policy, io).start(randomUUID())).toThrow('Delegate')
  expect(EndpointResources.safeParse({ ...policy, command: { ...policy.command, memoryBytes: 2 * 1024 ** 3 } }).success).toBe(false)
})

it('applies shared and per-command limits before spawning, carries stdin unchanged and retains original outcome/stream semantics', async () => {
  const h = fixture()
  expect(h.resources.status()).toMatchObject({ ready: true, memoryBytes: 0, processes: 0 })
  const wrapped = h.resources.run('job:one', () => h.runtime.spawn(h.spec))
  const call = vi.mocked(h.base.spawn).mock.calls[0]![0], scope = call.argv[3]!
  expect(call.argv.slice(5)).toEqual(h.spec.argv)
  expect(call.stdio).toBe(h.spec.stdio)
  expect(call.env).toMatchObject({ NODE_OPTIONS: undefined, NODE_PATH: undefined })
  for (const [key, value] of Object.entries(budgetFiles(policy.command))) expect(h.io.read(join(scope, key))).toBe(value)
  for (const [key, value] of Object.entries(budgetFiles(policy.pool, false))) expect(h.io.read(join(h.pool, key))).toBe(value)
  h.io.population(scope, true)
  expect(h.resources.hasLive('job:one')).toBe(true)
  expect(h.resources.hasLive('job:other')).toBe(false)
  h.done.resolve({ exitCode: 0, signal: null })
  expect(await wrapped.done).toEqual({ exitCode: 0, signal: null })
  expect(await wrapped.waitForExit(AbortSignal.timeout(5))).toBe(false)
  h.io.population(scope, false)
  h.io.files.set(join(scope, 'cpu.stat'), 'usage_usec 12000\nnr_throttled 2')
  h.io.files.set(join(scope, 'memory.events'), 'oom_kill 1')
  h.io.files.set(join(scope, 'pids.events'), 'max 3')
  expect(await wrapped.waitForExit()).toBe(true)
  expect(h.io.directories.has(scope)).toBe(false)
  expect(h.resources.takeUsage('job:one')).toEqual({ scopes: 1, complete: true, cpuMicroseconds: 12000, throttledPeriods: 2, oomKills: 1, processLimitEvents: 3 })
})

it('refuses widened kernel limits before dispatch and reports unavailable enforcement without claiming zero usage', () => {
  const h = fixture(); h.io.files.set(join(h.pool, 'memory.max'), 'max')
  expect(() => h.runtime.spawn(h.spec)).toThrow('pinned endpoint policy')
  expect(h.base.spawn).not.toHaveBeenCalled()
  expect(h.resources.status()).toMatchObject({ ready: false, memoryBytes: null, processes: null, activeScopes: null })
})

it('preserves the managed-range exit requirement even when the resource group is empty', async () => {
  const h = fixture(); vi.mocked(h.handle.waitForExit).mockResolvedValue(false)
  const wrapped = h.runtime.spawn(h.spec), scope = vi.mocked(h.base.spawn).mock.calls[0]![0].argv[3]!
  expect(await wrapped.waitForExit(AbortSignal.timeout(5))).toBe(false)
  expect(h.io.directories.has(scope)).toBe(true)
  vi.mocked(h.handle.waitForExit).mockResolvedValue(true)
  expect(await wrapped.waitForExit()).toBe(true)
})

it('uses whole-cgroup cancellation after the configured grace without changing the outcome into success', async () => {
  const h = fixture(), abort = new AbortController()
  const wrapped = h.runtime.spawn({ ...h.spec, signal: abort.signal }), scope = vi.mocked(h.base.spawn).mock.calls[0]![0].argv[3]!
  h.io.population(scope, true); abort.abort()
  await vi.waitFor(() => expect(h.io.writes).toContainEqual([join(scope, 'cgroup.kill'), '1']))
  expect(h.handle.terminate).toHaveBeenCalled()
  h.done.resolve({ exitCode: null, signal: 'SIGKILL' })
  expect(await wrapped.done).toEqual({ exitCode: null, signal: 'SIGKILL' })
  expect(await wrapped.waitForExit()).toBe(true)
})

it('retains populated groups through restart and refuses an existing pool with changed limits', () => {
  const h = fixture(), call = h.resources.run('job:old', () => h.runtime.spawn(h.spec))
  void call
  const scope = vi.mocked(h.base.spawn).mock.calls[0]![0].argv[3]!; h.io.population(scope, true)
  h.resources.close()
  const restored = new CgroupResources(policy, h.io); cleanup.push(restored); restored.start(h.pool.slice(h.pool.lastIndexOf('dsh-') + 4))
  expect(restored.hasLive('job:old')).toBe(true)
  restored.close(); h.io.files.set(join(h.pool, 'pids.max'), 'max')
  const changed = new CgroupResources(policy, h.io)
  expect(() => changed.start(h.pool.slice(h.pool.lastIndexOf('dsh-') + 4))).toThrow('pinned endpoint policy')
  expect(h.io.read(join(h.pool, 'pids.max'))).toBe('max')
  expect(h.io.directories.has(scope)).toBe(true)
})

it('removes only empty unclaimed groups and does not dispatch after resource disposal or a pre-aborted request', () => {
  const h = fixture(); const signal = AbortSignal.abort()
  expect(() => h.runtime.spawn({ ...h.spec, signal })).toThrow()
  expect(h.base.spawn).not.toHaveBeenCalled()
  const empty = join(h.pool, `s-${'a'.repeat(32)}-${'b'.repeat(32)}`); h.io.mkdir(empty)
  const unrelated = join(h.pool, 'operator-data'); h.io.mkdir(unrelated)
  h.resources.close()
  expect(() => h.runtime.spawn(h.spec)).toThrow('not running')
  const restored = new CgroupResources(policy, h.io); cleanup.push(restored); restored.start(h.pool.slice(h.pool.lastIndexOf('dsh-') + 4))
  expect(h.io.directories.has(empty)).toBe(false)
  expect(h.io.directories.has(unrelated)).toBe(true)
})

it('pins the endpoint policy across restart and rejects reconciliation while a known job or mutation group is populated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resource policy ')), ctx = new Context(), io = new FakeCgroup()
  const filesystem = new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }), subprocess = new LocalSubprocessRuntime(ctx)
  const resources = new CgroupResources(policy, io)
  // This test qualifies endpoint journal/control behavior, not native process enforcement.
  const host = { filesystem, subprocess, stateDir: join(directory, 'state'), root: join(directory, 'work'), resources,
    isolation: { name: 'test-only-unconfined', wrap: async (argv: readonly string[]) => argv } }
  const endpoint = new RemoteEndpoint(host)
  try {
    await endpoint.start()
    expect(endpoint.identity().resources).toMatchObject({ policy, ready: true })
    const at = new Date().toISOString(), id = 'unknown-job'
    endpoint.journal.saveJob({ id, grantId: 'grant', epoch: 1, revision: 1, fingerprint: 'original', phase: 'unknown', createdAt: at, updatedAt: at,
      request: { op: 'job.spawn', requestId: id, revision: 1, argv: ['/bin/true'], cwd: host.root, graceMs: 10, env: {} }, cancelRequested: false, quiescent: null })
    const operation: RemoteOperation = { id: 'unknown-write', grantId: 'grant', epoch: 1, fingerprint: 'original', kind: 'fs.write', phase: 'unknown', at }
    endpoint.journal.saveOperation(operation)
    const mocked = { spawn: vi.fn(() => ({ collected: {}, done: new Promise(() => {}), terminate() {}, waitForExit: async () => false })) } as unknown as SubprocessRuntime
    const bounded = resources.decorate(mocked, '/trusted/helper.js')
    for (const owner of ['job:' + id, 'operation:' + operation.id]) {
      resources.run(owner, () => bounded.spawn({ argv: ['/bin/true'], cwd: host.root, graceMs: 10, stdio: { stdin: 'ignore', stdout: { maxBytes: 0 }, stderr: { maxBytes: 0 } } }))
      io.population(vi.mocked(mocked.spawn).mock.calls.at(-1)![0].argv[3]!, true)
    }
    await expect(endpoint.rpc({ role: 'admin' }, { op: 'job.reconcile', id, requestId: 'review-job', note: 'reviewed', quiescent: true })).rejects.toThrow('populated kernel resource group')
    await expect(endpoint.rpc({ role: 'admin' }, { op: 'operation.reconcile', id: operation.id, requestId: 'review-write', note: 'reviewed' })).rejects.toThrow('populated kernel resource group')
    expect(endpoint.journal.job(id).quiescent).toBe(null)
    await endpoint.stop()
    expect(() => new RemoteEndpoint({ ...host, resources: undefined })).toThrow('cannot be removed')
    const changed = new CgroupResources({ ...policy, command: { ...policy.command, cpuPercent: 99 } }, io)
    expect(() => new RemoteEndpoint({ ...host, resources: changed })).toThrow('cannot be removed or replaced')
    const credentialFile = join(await realpath(directory), 'ownership.token')
    await writeFile(credentialFile, 'resource.coordinator.endpoint.synthetic-scope-test', { mode: 0o600 })
    expect(() => new RemoteEndpoint({ ...host, resources: undefined, ownership: { url: 'http://127.0.0.1:1', authorityId: randomUUID(),
      coordinatorId: 'coordinator', resourceId: 'endpoint', credentialFile, timeoutMs: 1000 } })).toThrow('cannot be removed')
    const unchanged = new RemoteEndpoint({ ...host, resources: new CgroupResources(policy, io) })
    expect(unchanged.journal.db.prepare('SELECT value FROM endpoint_meta WHERE key=?').get('ownership-binding')).toBeUndefined()
    await unchanged.stop()
  } finally { await endpoint.stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it('rejects a trusted resource helper inside a granted workspace before executing startup proofs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resource helper ')), ctx = new Context()
  const filesystem = new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }), subprocess = new LocalSubprocessRuntime(ctx)
  const host = { filesystem, subprocess, stateDir: join(directory, 'state'), root: join(directory, 'work'),
    resourceHelper: join(directory, 'work', 'helper.js'), isolation: { name: 'test-only-unconfined', wrap: async (argv: readonly string[]) => argv } }
  const endpoint = new RemoteEndpoint(host), spawn = vi.spyOn(subprocess, 'spawn')
  try {
    await writeFile(host.resourceHelper, 'throw new Error("untrusted")')
    await expect(endpoint.start()).rejects.toThrow('outside endpoint workspaces')
    expect(spawn).not.toHaveBeenCalled()
  } finally { await endpoint.stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it.runIf(!!process.env.DSH_RESOURCE_QUALIFICATION_ROOT)('qualifies actual cgroup limits, confined execution, OOM containment and durable replay on Linux', async () => {
  if (process.platform !== 'linux') throw new Error('Native resource qualification requires Linux')
  const directory = await mkdtemp(join(tmpdir(), 'resource native ')), ctx = new Context()
  const filesystem = new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }), local = new LocalSubprocessRuntime(ctx)
  const configured = { ...policy, command: { ...policy.command, cpuPercent: 25 }, workspace: { cpuPercent: 25, memoryBytes: 512 * 1024 ** 2, processes: 64 }, cgroupRoot: process.env.DSH_RESOURCE_QUALIFICATION_ROOT! }
  let endpoint: RemoteEndpoint, resources: CgroupResources
  const create = () => {
    resources = new CgroupResources(configured)
    const subprocess = resources.decorate(local, resolve('lib/remote-resource-worker.js'))
    const isolation = new BubblewrapIsolation(subprocess)
    return new RemoteEndpoint({ filesystem, subprocess, resources, isolation, resourceHelper: resolve('lib/remote-resource-worker.js'), stateDir: join(directory, 'state'), root: join(directory, 'work'),
      filesystemRpc: confinedFilesystem(subprocess, isolation, resolve('lib/remote-fs-worker.js')),
      commandHelper: resolve('lib/remote-command-worker.js'), snapshotHelper: resolve('lib/verification-snapshot-worker.js') })
  }
  endpoint = create()
  const pool = join(configured.cgroupRoot, 'dsh-' + endpoint.journal.id)
  try {
    await endpoint.start()
    const initialArchive = await endpoint.withRecoveryCapture(signal => captureWorkspaceRecovery(join(directory, 'work'), join(directory, 'native-archive'), { maxEntries: 100, maxBytes: 1024 }, signal))
    expect(initialArchive.manifest.contentArchived).toBe(true)
    const enrolled = await endpoint.rpc({ role: 'admin' }, { op: 'grant.create', requestId: 'native-resource-grant', owner: 'test', workspace: 'resource',
      operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 }) as GrantReceipt
    const principal = { role: 'grant' as const, id: enrolled.grant.id, epoch: enrolled.grant.epoch }
    const request = { op: 'job.spawn' as const, requestId: 'native-resource-proof', revision: enrolled.grant.revision,
      argv: ['/bin/sh', '-c', 'test ! -e /sys/fs/cgroup && printf resource-proof > proof.txt'], cwd: enrolled.grant.root, graceMs: 100, env: {} }
    const settled = async (id: string) => {
      let job: RemoteJob
      await vi.waitFor(async () => { job = await endpoint.rpc(principal, { op: 'job.get', id }) as RemoteJob; expect(job.quiescent).toBe(true) }, { timeout: 15000, interval: 100 })
      return job!
    }
    await endpoint.rpc(principal, request)
    expect(await settled(request.requestId)).toMatchObject({ phase: 'settled', outcome: { exitCode: 0 } })
    expect(await endpoint.rpc(principal, { op: 'fs.read', path: join(enrolled.grant.root, 'proof.txt') })).toBe('resource-proof')
    const captureRequest = { requestId: randomUUID(), grantId: enrolled.grant.id, epoch: enrolled.grant.epoch, destination: join(directory, 'native-retained-archive'), maxEntries: 100, maxBytes: 4096 }
    const captureReceipt = await endpoint.captureWorkspace(captureRequest)
    expect(captureReceipt).toMatchObject({ phase: 'complete', result: { managedQuiescenceObserved: true, globalSnapshotVerified: false } })
    expect(await endpoint.captureWorkspace(captureRequest)).toEqual(captureReceipt)
    const interruptedCapture = { ...captureRequest, requestId: randomUUID(), destination: join(directory, 'native-interrupted-archive') }
    const completionFault = vi.spyOn(WorkspaceCaptures.prototype, 'complete').mockImplementationOnce(() => { throw new Error('native completion interruption') })
    try { await expect(endpoint.captureWorkspace(interruptedCapture)).rejects.toThrow('native completion interruption') } finally { completionFault.mockRestore() }
    expect(await endpoint.captureWorkspace(interruptedCapture)).toMatchObject({ phase: 'started' })
    const reviewedDigest = createHash('sha256').update(await readFile(join(interruptedCapture.destination, 'manifest.json'))).digest('hex')
    expect(await endpoint.reconcileWorkspaceCapture(interruptedCapture, reviewedDigest)).toMatchObject({ phase: 'complete', request: interruptedCapture,
      result: { reconciled: true, managedQuiescenceObserved: true, globalSnapshotVerified: false } })

    const node = await local.resolveExecutable('node')
    const cpu = { ...request, requestId: 'native-resource-cpu', argv: [node, '-e', 'const end=Date.now()+5000; while(Date.now()<end) {}'] }
    expect(resources!.quiescent()).toBe(true)
    await endpoint.rpc(principal, cpu)
    await vi.waitFor(() => expect(resources!.quiescent()).toBe(false), { timeout: 4000, interval: 20 })
    const forbiddenCapture = vi.fn(async () => 'not captured')
    await expect(endpoint.withRecoveryCapture(forbiddenCapture)).rejects.toThrow('managed process quiescence')
    expect(forbiddenCapture).not.toHaveBeenCalled()
    const throttled = await settled(cpu.requestId)
    expect(resources!.quiescent()).toBe(true)
    expect(throttled.outcome?.exitCode).toBe(0); expect(throttled.resources?.complete).toBe(true)
    const workspacePath = (name: string) => join(pool, 'w-' + createHash('sha256').update('workspace:' + name).digest('hex').slice(0, 32))
    const parent = workspacePath(enrolled.grant.workspace)
    const parentThrottled = async () => Number((await readFile(join(parent, 'cpu.stat'), 'utf8')).match(/nr_throttled (\d+)/)?.[1] ?? NaN)
    expect((throttled.resources?.throttledPeriods ?? 0) + await parentThrottled()).toBeGreaterThan(0)
    // Two simultaneously populated command children must share the same enforced workspace CPU ceiling.
    const other = await endpoint.rpc({ role: 'admin' }, { op: 'grant.create', requestId: 'native-other-grant', owner: 'test', workspace: 'other-resource',
      operations: ['fs.read', 'process.spawn'], leaseMs: 300000 }) as GrantReceipt
    const otherPrincipal = { role: 'grant' as const, id: other.grant.id, epoch: other.grant.epoch }
    const work = [0, 1].map(index => ({ ...cpu, requestId: 'native-aggregate-' + index,
      argv: [node, '-e', 'const end=Date.now()+5000; while(Date.now()<end) {}'] }))
    const separate = { ...work[0]!, requestId: 'native-separate', cwd: other.grant.root, revision: other.grant.revision }
    await Promise.all([...work.map(value => endpoint.rpc(principal, value)), endpoint.rpc(otherPrincipal, separate)])
    const populatedChildren = async (path: string) => {
      const children = (await readdir(path)).filter(name => name.startsWith('s-'))
      return (await Promise.all(children.map(async name => /populated 1/.test(await readFile(join(path, name, 'cgroup.events'), 'utf8'))))).filter(Boolean).length
    }
    await vi.waitFor(async () => {
      expect(await populatedChildren(parent)).toBe(2)
      expect(await populatedChildren(workspacePath(other.grant.workspace))).toBe(1)
    }, { timeout: 4000 })
    expect((await readFile(join(parent, 'cpu.max'), 'utf8')).trim()).toBe('25000 100000')
    expect((await readFile(join(pool, 'cpu.max'), 'utf8')).trim()).toBe('200000 100000')
    for (const value of work) expect(await settled(value.requestId)).toMatchObject({ outcome: { exitCode: 0 }, quiescent: true })
    await vi.waitFor(() => expect(endpoint.journal.job(separate.requestId)).toMatchObject({ outcome: { exitCode: 0 }, quiescent: true }), { timeout: 15000 })
    expect(await parentThrottled()).toBeGreaterThan(0)

    const forks = { ...request, requestId: 'native-resource-pids', argv: [node, '-e',
      "const {spawn}=require('node:child_process'); const children=[]; for(let i=0;i<80;i++){const child=spawn('/bin/sleep',['3']); child.on('error',()=>{}); children.push(child)} setTimeout(()=>children.forEach(child=>child.kill()),300)"] }
    await endpoint.rpc(principal, forks)
    const bounded = await settled(forks.requestId)
    expect(bounded.resources?.complete).toBe(true); expect(bounded.resources?.processLimitEvents).toBeGreaterThan(0)
    const oom = { ...request, requestId: 'native-resource-oom', argv: [node, '-e', 'const buffers=[]; while(true) buffers.push(Buffer.alloc(8*1024*1024,1))'] }
    await endpoint.rpc(principal, oom)
    const killed = await settled(oom.requestId)
    expect(killed.phase).toBe('settled'); expect(killed.outcome?.exitCode).not.toBe(0)
    expect(killed.resources?.complete).toBe(true); expect(killed.resources?.oomKills).toBeGreaterThan(0)
    expect(endpoint.identity().resources).toMatchObject({ ready: true, policy: configured })
    await endpoint.stop(); endpoint = create(); await endpoint.start()
    expect(await endpoint.rpc(principal, request)).toMatchObject({ id: request.requestId, phase: 'settled', outcome: { exitCode: 0 }, quiescent: true })
    expect(await endpoint.rpc(principal, { op: 'job.get', id: oom.requestId })).toMatchObject({ id: oom.requestId, outcome: killed.outcome, resources: killed.resources, quiescent: true })
    await endpoint.stop()
    const built = await import(pathToFileURL(resolve('lib/remote-endpoint.js')).href)
    const registered = vi.fn(), disposers: (() => Promise<void>)[] = [], receiptFile = join(directory, 'maintenance-result.json')
    const maintenanceContext = { fs: filesystem, subprocess: local, webServer: { host: '127.0.0.1', register: registered },
      logger: { info() {}, warn() {} }, effect: (effect: () => (() => Promise<void>)) => { disposers.push(effect()) } } as unknown as Context
    const maintenanceRequest = { ...captureRequest, requestId: randomUUID(), destination: join(directory, 'native-maintenance-archive') }
    try {
      await built.apply(maintenanceContext, built.Config({ stateDir: join(directory, 'state'), workspaceRoot: join(directory, 'work'), resources: configured,
        maintenance: { mode: 'capture', request: maintenanceRequest, receiptFile } }))
      expect(registered).not.toHaveBeenCalled()
      expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toMatchObject({ mode: 'capture', executionOwnership: false,
        capture: { phase: 'complete', request: maintenanceRequest } })
    } finally { for (const dispose of disposers.reverse()) await dispose() }

  } finally {
    await endpoint.stop(); await ctx.fiber.dispose()
    // Kernel rmdir refuses a populated cgroup; never recursively delete or kill an unknown range here.
    await rmdir(pool)
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)


it('groups concurrent commands by trusted workspace while retaining distinct effect scopes', () => {
  const workspace = { cpuPercent: 150, memoryBytes: 512 * 1024 ** 2, processes: 64 }
  const h = fixture(new FakeCgroup(), { ...policy, workspace })
  h.resources.run('job:one', () => h.runtime.spawn(h.spec), 'alpha')
  h.resources.run('job:two', () => h.runtime.spawn(h.spec), 'alpha')
  h.resources.run('operation:three', () => h.runtime.spawn(h.spec), 'beta')
  const paths = vi.mocked(h.base.spawn).mock.calls.map(([spec]) => spec.argv[3]!)
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))
  expect(parent(paths[0]!)).toBe(parent(paths[1]!))
  expect(paths[0]).not.toBe(paths[1])
  expect(parent(paths[0]!)).not.toBe(parent(paths[2]!))
  for (const path of paths) {
    for (const [file, value] of Object.entries(budgetFiles(workspace, false))) expect(h.io.read(join(parent(path), file))).toBe(value)
  }
  const encoded = JSON.parse(vi.mocked(h.base.spawn).mock.calls[0]![0].argv[4]!)
  expect(encoded.workspace).toEqual(budgetFiles(workspace, false))
  h.io.population(paths[0]!, true)
  expect(h.resources.hasLive('job:one')).toBe(true)
  expect(h.resources.hasLive('job:two')).toBe(false)
})

it('rejects workspace ceilings outside the command and pool interval', () => {
  expect(EndpointResources.safeParse({ ...policy, workspace: { ...policy.command, cpuPercent: 99 } }).success).toBe(false)
  expect(EndpointResources.safeParse({ ...policy, workspace: { ...policy.pool, memoryBytes: 2 * 1024 ** 3 } }).success).toBe(false)
})

it('refuses changed workspace limits before admitting another command', () => {
  const workspace = { ...policy.command }
  const h = fixture(new FakeCgroup(), { ...policy, workspace })
  h.resources.run('job:one', () => h.runtime.spawn(h.spec), 'alpha')
  const path = vi.mocked(h.base.spawn).mock.calls[0]![0].argv[3]!
  h.io.files.set(join(path.slice(0, path.lastIndexOf('/')), 'memory.max'), 'max')
  expect(() => h.resources.run('job:two', () => h.runtime.spawn(h.spec), 'alpha')).toThrow('pinned endpoint policy')
  expect(h.base.spawn).toHaveBeenCalledOnce()
})


it('preserves the optional aggregate policy through the Harness endpoint plugin schema', async () => {
  const { Config } = await import('../src/remote/endpoint-plugin.ts')
  const workspace = { cpuPercent: 150, memoryBytes: 512 * 1024 ** 2, processes: 64 }
  const parsed = Config({ stateDir: '/private/endpoint', workspaceRoot: '/workspaces', resources: { ...policy, workspace } })
  expect(parsed.resources?.workspace).toEqual(workspace)
})

it('retains populated workspace scopes across restart while cleaning only empty original command groups', () => {
  const configured = { ...policy, workspace: { ...policy.pool } }, h = fixture(new FakeCgroup(), configured)
  h.resources.run('job:retained', () => h.runtime.spawn(h.spec), 'same-workspace')
  h.resources.run('job:empty', () => h.runtime.spawn(h.spec), 'same-workspace')
  const [live, empty] = vi.mocked(h.base.spawn).mock.calls.map(([spec]) => spec.argv[3]!)
  h.io.population(live!, true)
  h.resources.close()
  const restored = new CgroupResources(configured, h.io); cleanup.push(restored)
  restored.start(h.pool.slice(h.pool.lastIndexOf('dsh-') + 4))
  expect(restored.hasLive('job:retained')).toBe(true)
  expect(h.io.directories.has(live!)).toBe(true)
  expect(h.io.directories.has(empty!)).toBe(false)
  expect(h.io.directories.has(live!.slice(0, live!.lastIndexOf('/')))).toBe(true)
  expect(h.base.spawn).toHaveBeenCalledTimes(2)
})

it('cancels only the original command group and preserves its live workspace sibling', async () => {
  const h = fixture(new FakeCgroup(), { ...policy, workspace: { ...policy.pool } }), abort = new AbortController()
  h.resources.run('job:cancel', () => h.runtime.spawn({ ...h.spec, signal: abort.signal }), 'shared')
  h.resources.run('job:sibling', () => h.runtime.spawn(h.spec), 'shared')
  const [original, sibling] = vi.mocked(h.base.spawn).mock.calls.map(([spec]) => spec.argv[3]!)
  h.io.population(original!, true); h.io.population(sibling!, true)
  abort.abort()
  await vi.waitFor(() => expect(h.io.writes).toContainEqual([join(original!, 'cgroup.kill'), '1']))
  expect(h.io.writes.filter(([path]) => path.endsWith('/cgroup.kill'))).toEqual([[join(original!, 'cgroup.kill'), '1']])
  expect(h.resources.hasLive('job:sibling')).toBe(true)
})

it('preserves a workspace whose removal races a newly observed process', async () => {
  const h = fixture(new FakeCgroup(), { ...policy, workspace: { ...policy.pool } })
  const first = h.resources.run('job:first', () => h.runtime.spawn(h.spec), 'first')
  const scope = vi.mocked(h.base.spawn).mock.calls[0]![0].argv[3]!, parent = scope.slice(0, scope.lastIndexOf('/'))
  expect(await first.waitForExit()).toBe(true)
  const remove = h.io.remove.bind(h.io)
  vi.spyOn(h.io, 'remove').mockImplementation(path => { if (path === parent) h.io.population(path, true); remove(path) })
  h.resources.run('job:second', () => h.runtime.spawn(h.spec), 'second')
  expect(h.io.directories.has(parent)).toBe(true)
  expect(h.io.read(join(parent, 'cgroup.events'))).toContain('populated 1')
})

it('attributes endpoint commands and filesystem helpers to the authenticated grant workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace attribution ')), ctx = new Context(), io = new FakeCgroup()
  const filesystem = new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }), subprocess = new LocalSubprocessRuntime(ctx)
  const resources = new CgroupResources({ ...policy, workspace: { ...policy.pool } }, io)
  const run = vi.spyOn(resources, 'run')
  const scopes: string[] = []
  // Strip only the trusted resource wrapper in this simulated-kernel fixture; execute actual snapshot/check helpers.
  const simulated = new Proxy(subprocess, { get(target, property) {
    if (property === 'spawn') return (spec: SubprocessSpawnSpec) => {
      scopes.push(spec.argv[3]!); return target.spawn({ ...spec, argv: spec.argv.slice(5) })
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const bounded = resources.decorate(simulated, resolve('lib/remote-resource-worker.js'))
  // Real endpoint/FS/process execution, simulated resource kernel: this verifies trusted attribution, not enforcement.
  const isolation = { name: 'test-only-unconfined', wrap: async (argv: readonly string[], _root: string, _cwd: string, _network: boolean, _signal: AbortSignal, _env: Readonly<Record<string, string>>, helper?: string) =>
    argv.map(arg => arg === '/run/dsh-filesystem.mjs' && helper ? helper : arg) }
  const endpoint = new RemoteEndpoint({ filesystem, subprocess: bounded, resources, isolation,
    stateDir: join(directory, 'state'), root: join(directory, 'work'),
    filesystemRpc: confinedFilesystem(bounded, isolation, resolve('lib/remote-fs-worker.js')),
    commandHelper: resolve('lib/remote-command-worker.js'), snapshotHelper: resolve('lib/verification-snapshot-worker.js') })
  try {
    await endpoint.start()
    const enrolled = await endpoint.rpc({ role: 'admin' }, { op: 'grant.create', requestId: 'allocation-grant', owner: 'test', workspace: 'trusted-workspace',
      operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 }) as GrantReceipt
    const principal = { role: 'grant' as const, id: enrolled.grant.id, epoch: enrolled.grant.epoch }
    await writeFile(join(enrolled.grant.root, 'proof.txt'), 'trusted')
    expect(await endpoint.rpc(principal, { op: 'fs.read', path: join(enrolled.grant.root, 'proof.txt') })).toBe('trusted')
    expect(run.mock.calls.some(([owner, , workspace]) => owner === 'read' && workspace === 'trusted-workspace')).toBe(true)
    await endpoint.rpc(principal, { op: 'fs.write', requestId: 'allocation-write', path: join(enrolled.grant.root, 'written.txt'), content: 'scoped' })
    expect(run.mock.calls.some(([owner, , workspace]) => owner === 'operation:allocation-write' && workspace === 'trusted-workspace')).toBe(true)
    const request = { op: 'job.spawn' as const, requestId: 'allocation-job', revision: enrolled.grant.revision,
      argv: [await subprocess.resolveExecutable('true')], cwd: enrolled.grant.root, graceMs: 100, env: { DSH_SUPERAGENT_WORKSPACE: 'forged-workspace' } }
    await endpoint.rpc(principal, request)
    await vi.waitFor(() => expect(endpoint.journal.job(request.requestId), JSON.stringify(endpoint.journal.job(request.requestId))).toMatchObject({ phase: 'settled', quiescent: true, outcome: { exitCode: 0 } }))
    expect(run.mock.calls.filter(([owner]) => owner === 'job:' + request.requestId).map(([, , workspace]) => workspace)).toEqual(['trusted-workspace'])
    expect(run.mock.calls.some(([, , workspace]) => workspace === 'forged-workspace')).toBe(false)
    const originalParent = scopes.at(-1)!.slice(0, scopes.at(-1)!.lastIndexOf('/')), before = scopes.length
    const check = { ...request, requestId: 'allocation-check', verification: { kind: 'check' as const, snapshot: { repository: 'none' as const } } }
    await endpoint.rpc(principal, check)
    await vi.waitFor(() => expect(endpoint.journal.job(check.requestId), JSON.stringify(endpoint.journal.job(check.requestId)))
      .toMatchObject({ phase: 'settled', quiescent: true, outcome: { exitCode: 0 }, verification: { stage: 'finished', snapshotUnchanged: true, storageReleased: true } }), { timeout: 5000 })
    const verificationScopes = scopes.slice(before)
    expect(verificationScopes.length).toBeGreaterThanOrEqual(3)
    expect(new Set(verificationScopes.map(path => path.slice(0, path.lastIndexOf('/'))))).toEqual(new Set([originalParent]))
    expect(endpoint.journal.job(check.requestId).resources?.scopes).toBe(verificationScopes.length)
    const count = scopes.length
    await endpoint.rpc(principal, check)
    expect(scopes).toHaveLength(count)
    expect(endpoint.journal.job(check.requestId).resources?.scopes).toBe(verificationScopes.length)
    expect(run.mock.calls.filter(([owner]) => owner === 'job:' + check.requestId).map(([, , workspace]) => workspace)).toEqual(['trusted-workspace'])

  } finally { await endpoint.stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})


it('removes empty workspace parents on disposal without removing populated parents', async () => {
  const h = fixture(new FakeCgroup(), { ...policy, workspace: { ...policy.pool } })
  h.resources.run('job:live', () => h.runtime.spawn(h.spec), 'live')
  const liveScope = vi.mocked(h.base.spawn).mock.calls.at(-1)![0].argv[3]!
  h.io.population(liveScope, true)
  const handle = h.resources.run('job:empty', () => h.runtime.spawn(h.spec), 'empty')
  const emptyScope = vi.mocked(h.base.spawn).mock.calls.at(-1)![0].argv[3]!
  await handle.waitForExit()
  const emptyParent = emptyScope.slice(0, emptyScope.lastIndexOf('/'))
  expect(h.io.directories.has(emptyParent)).toBe(true)
  h.resources.close()
  expect(h.io.directories.has(emptyParent)).toBe(false)
  expect(h.io.directories.has(liveScope.slice(0, liveScope.lastIndexOf('/')))).toBe(true)
})


it('requires pool-wide kernel emptiness even without a known scope and refuses unavailable evidence', () => {
  const h = fixture()
  expect(h.resources.quiescent()).toBe(true)
  // cgroup.events at the pool includes all descendants, including names absent from the journal.
  h.io.files.set(join(h.pool, 'cgroup.events'), 'populated 1\nfrozen 0')
  expect(h.resources.hasLive('unknown-original')).toBe(false)
  expect(h.resources.quiescent()).toBe(false)
  h.io.files.set(join(h.pool, 'cgroup.events'), 'populated 0\nfrozen 0')
  expect(h.resources.quiescent()).toBe(true)
  h.io.files.set(join(h.pool, 'cgroup.events'), 'frozen 0')
  expect(h.resources.quiescent()).toBe(false)
  h.io.files.set(join(h.pool, 'cgroup.events'), 'populated 0')
  h.io.files.set(join(h.pool, 'memory.max'), 'max')
  expect(h.resources.quiescent()).toBe(false)
  h.resources.close()
  expect(h.resources.quiescent()).toBe(false)
})


it('reports recovery inventory non-quiescent for populated or unreadable pools despite empty job journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resource recovery ')), ctx = new Context(), io = new FakeCgroup()
  const resources = new CgroupResources(policy, io)
  const endpoint = new RemoteEndpoint({ filesystem: new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }),
    subprocess: new LocalSubprocessRuntime(ctx), stateDir: join(directory, 'state'), root: join(directory, 'work'), resources,
    isolation: { name: 'test-only-unconfined', wrap: async (argv: readonly string[]) => argv } })
  try {
    await endpoint.start()
    // Supply identity metadata only; this test exercises the production inventory/quiescence path, not authority transport.
    const identity = endpoint.identity()
    vi.spyOn(endpoint, 'identity').mockReturnValue({ ...identity, ownership: { authorityId: randomUUID(), coordinatorId: 'coordinator', resourceId: 'endpoint' } })
    const observe = () => endpoint.rpc({ role: 'admin' }, { op: 'recovery.inventory', offset: 0 })
    expect(endpoint.journal.jobs()).toHaveLength(0)
    expect(await observe()).toMatchObject({ quiescent: true })
    const events = join(io.root, 'dsh-' + endpoint.journal.id, 'cgroup.events')
    io.files.set(events, 'populated 1')
    expect(await observe()).toMatchObject({ quiescent: false })
    io.files.delete(events)
    expect(await observe()).toMatchObject({ quiescent: false })
    io.files.set(events, 'populated 0')
    expect(await observe()).toMatchObject({ quiescent: true })
  } finally { await endpoint.stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it('holds all endpoint admission during host capture and releases the fence after refusal or failure', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'resource capture '))), ctx = new Context(), io = new FakeCgroup()
  const resources = new CgroupResources(policy, io), root = join(directory, 'work')
  const endpoint = new RemoteEndpoint({ filesystem: new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }),
    subprocess: new LocalSubprocessRuntime(ctx), stateDir: join(directory, 'state'), root, resources,
    isolation: { name: 'test-only-unconfined', wrap: async (argv: readonly string[]) => argv } })
  try {
    await endpoint.start()
    const activeRead = endpoint.rpc({ role: 'admin' }, { op: 'identity' })
    const notCalled = vi.fn(async () => 'unexpected')
    await expect(endpoint.withRecoveryCapture(notCalled)).rejects.toThrow('idle endpoint admission')
    expect(notCalled).not.toHaveBeenCalled(); await activeRead
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const capture = endpoint.withRecoveryCapture(async signal => { entered.resolve(); await release.promise; signal.throwIfAborted(); return 'captured' })
    await entered.promise
    try {
      await expect(endpoint.rpc({ role: 'admin' }, { op: 'identity' })).rejects.toThrow('held for recovery capture')
      await expect(endpoint.rpc({ role: 'admin' }, { op: 'grant.create', requestId: 'blocked', owner: 'test', workspace: 'blocked',
        operations: ['fs.read'], leaseMs: 60000 })).rejects.toThrow('held for recovery capture')
      await expect(endpoint.withRecoveryCapture(notCalled)).rejects.toThrow('idle endpoint admission')
      expect(endpoint.journal.grants()).toHaveLength(0)
    } finally { release.resolve() }
    expect(await capture).toBe('captured')
    await expect(endpoint.withRecoveryCapture(async () => { throw new Error('capture failed') })).rejects.toThrow('capture failed')
    expect(await endpoint.rpc({ role: 'admin' }, { op: 'identity' })).toBeDefined()
    const events = join(io.root, 'dsh-' + endpoint.journal.id, 'cgroup.events')
    await expect(endpoint.withRecoveryCapture(async () => { io.files.set(events, 'populated 1'); return 'not complete' })).rejects.toThrow('changed during capture')
    await expect(endpoint.withRecoveryCapture(notCalled)).rejects.toThrow('managed process quiescence')
    io.files.set(events, 'populated 0')
    await expect(endpoint.withRecoveryCapture(notCalled, AbortSignal.abort())).rejects.toThrow()
    expect(notCalled).not.toHaveBeenCalled()
    await writeFile(join(root, 'retained.txt'), 'fenced content')
    const archived = await endpoint.withRecoveryCapture(signal => captureWorkspaceRecovery(root, join(directory, 'archive'), { maxEntries: 100, maxBytes: 1024 }, signal))
    expect(archived.manifest.entries).toContainEqual(expect.objectContaining({ path: 'retained.txt', kind: 'file' }))
    expect(archived.manifest).toMatchObject({ contentArchived: true, executionQuiescenceVerified: false, restoreVerified: false })
    const grant = await endpoint.rpc({ role: 'admin' }, { op: 'grant.create', requestId: 'capture-grant', owner: 'test', workspace: 'capture',
      operations: ['fs.read'], leaseMs: 60000 }) as GrantReceipt
    await writeFile(join(grant.grant.root, 'data'), 'original capture bytes')
    const request = { requestId: randomUUID(), grantId: grant.grant.id, epoch: grant.grant.epoch, destination: join(directory, 'retained-archive'), maxEntries: 100, maxBytes: 1024 }
    const saved = await endpoint.captureWorkspace(request)
    expect(saved).toMatchObject({ phase: 'complete', binding: { grantId: grant.grant.id, epoch: grant.grant.epoch, rootIdentity: grant.grant.rootIdentity },
      result: { managedQuiescenceObserved: true, globalSnapshotVerified: false, restoreVerified: false } })
    await writeFile(join(grant.grant.root, 'data'), 'new bytes must not be recaptured')
    expect(await endpoint.captureWorkspace(request)).toEqual(saved)
    await expect(endpoint.captureWorkspace({ ...request, maxBytes: 2048 })).rejects.toThrow('another payload')
    const interrupted = { ...request, requestId: randomUUID(), destination: join(directory, 'interrupted-archive'), maxBytes: 1 }
    await expect(endpoint.captureWorkspace(interrupted)).rejects.toThrow('byte budget')
    const held = await endpoint.captureWorkspace(interrupted)
    expect(held).toMatchObject({ phase: 'started', request: interrupted })
    expect(held.result).toBeUndefined()
    expect(await endpoint.captureWorkspace(interrupted)).toEqual(held)
    await expect(endpoint.reconcileWorkspaceCapture(interrupted, '0'.repeat(64))).rejects.toThrow()
    const recoverable = { ...request, requestId: randomUUID(), destination: join(directory, 'recoverable-archive') }
    const saveFailure = vi.spyOn(WorkspaceCaptures.prototype, 'complete').mockImplementationOnce(() => { throw new Error('lost completion write') })
    try { await expect(endpoint.captureWorkspace(recoverable)).rejects.toThrow('lost completion write') } finally { saveFailure.mockRestore() }
    const originalIntent = await endpoint.captureWorkspace(recoverable)
    expect(originalIntent.phase).toBe('started')
    const manifestBefore = await readFile(join(recoverable.destination, 'manifest.json'))
    const digest = createHash('sha256').update(manifestBefore).digest('hex')
    await expect(endpoint.reconcileWorkspaceCapture(recoverable, '0'.repeat(64))).rejects.toThrow('reviewed manifest')
    const sourceBefore = await readFile(join(grant.grant.root, 'data'))
    await writeFile(join(grant.grant.root, 'data'), 'changed source')
    await expect(endpoint.reconcileWorkspaceCapture(recoverable, digest)).rejects.toThrow('freshly observed source')
    expect(await endpoint.captureWorkspace(recoverable)).toEqual(originalIntent)
    await writeFile(join(grant.grant.root, 'data'), sourceBefore)
    const reconciled = await endpoint.reconcileWorkspaceCapture(recoverable, digest)
    expect(reconciled).toMatchObject({ request: recoverable, binding: originalIntent.binding, startedAt: originalIntent.startedAt,
      phase: 'complete', result: { reconciled: true, manifestHash: digest, globalSnapshotVerified: false, restoreVerified: false } })
    expect(await readFile(join(recoverable.destination, 'manifest.json'))).toEqual(manifestBefore)
    expect(await endpoint.reconcileWorkspaceCapture(recoverable, digest)).toEqual(reconciled)
    await expect(endpoint.reconcileWorkspaceCapture(recoverable, '0'.repeat(64))).rejects.toThrow('reviewed digest')


  } finally { await endpoint.stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

it('maintenance startup preserves accepted jobs without dispatch and refuses normal RPC admission', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'resource maintenance '))), ctx = new Context(), io = new FakeCgroup()
  const endpoint = new RemoteEndpoint({ filesystem: new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }),
    subprocess: new LocalSubprocessRuntime(ctx), stateDir: join(directory, 'state'), root: join(directory, 'work'), resources: new CgroupResources(policy, io),
    isolation: { name: 'test-only-unconfined', wrap: async (argv: readonly string[]) => argv } })
  try {
    const at = new Date().toISOString(), id = 'retained-accepted'
    endpoint.journal.saveJob({ id, grantId: 'original-grant', epoch: 1, revision: 1, fingerprint: 'original', phase: 'accepted', createdAt: at, updatedAt: at,
      request: { op: 'job.spawn', requestId: id, revision: 1, argv: ['/bin/false'], cwd: join(directory, 'work'), graceMs: 10, env: {} }, cancelRequested: false, quiescent: false })
    await endpoint.start({ maintenance: true })
    await expect(endpoint.rpc({ role: 'admin' }, { op: 'identity' })).rejects.toThrow('host-only maintenance')
    await expect(endpoint.withRecoveryCapture(async () => 'must not capture')).rejects.toThrow('managed process quiescence')
    expect(endpoint.journal.job(id)).toMatchObject({ phase: 'accepted', quiescent: false, cancelRequested: false })
  } finally { await endpoint.stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})
