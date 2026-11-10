import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CgroupResources } from '../src/remote/resources.ts'
import { EndpointResources, budgetFiles } from '../src/remote/resource-model.ts'
import { FakeCgroup } from './fixtures/cgroup.ts'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { RemoteEndpoint } from '../src/remote/endpoint.ts'
import { BubblewrapIsolation } from '../src/remote/isolation.ts'
import { confinedFilesystem } from '../src/remote/filesystem-runner.ts'
import type { GrantReceipt, RemoteJob, RemoteOperation } from '../src/remote/protocol.ts'

const policy: EndpointResources = { cgroupRoot: '/delegated', pool: { cpuPercent: 200, memoryBytes: 1024 ** 3, processes: 128 },
  command: { cpuPercent: 100, memoryBytes: 256 * 1024 ** 2, processes: 32 } }
const cleanup: CgroupResources[] = []
afterEach(() => { for (const resources of cleanup.splice(0)) resources.close(); vi.restoreAllMocks() })
function fixture(io = new FakeCgroup()) {
  const resources = new CgroupResources(policy, io), id = randomUUID(); cleanup.push(resources); resources.start(id)
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
  const configured = { ...policy, command: { ...policy.command, cpuPercent: 25 }, cgroupRoot: process.env.DSH_RESOURCE_QUALIFICATION_ROOT! }
  let endpoint: RemoteEndpoint
  const create = () => {
    const resources = new CgroupResources(configured), subprocess = resources.decorate(local, resolve('lib/remote-resource-worker.js'))
    const isolation = new BubblewrapIsolation(subprocess)
    return new RemoteEndpoint({ filesystem, subprocess, resources, isolation, resourceHelper: resolve('lib/remote-resource-worker.js'), stateDir: join(directory, 'state'), root: join(directory, 'work'),
      filesystemRpc: confinedFilesystem(subprocess, isolation, resolve('lib/remote-fs-worker.js')),
      commandHelper: resolve('lib/remote-command-worker.js'), snapshotHelper: resolve('lib/verification-snapshot-worker.js') })
  }
  endpoint = create()
  const pool = join(configured.cgroupRoot, 'dsh-' + endpoint.journal.id)
  try {
    await endpoint.start()
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
    const node = await local.resolveExecutable('node')
    const cpu = { ...request, requestId: 'native-resource-cpu', argv: [node, '-e', 'const end=Date.now()+2000; while(Date.now()<end) {}'] }
    await endpoint.rpc(principal, cpu)
    const throttled = await settled(cpu.requestId)
    expect(throttled.outcome?.exitCode).toBe(0); expect(throttled.resources?.complete).toBe(true)
    expect(throttled.resources?.throttledPeriods).toBeGreaterThan(0)
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
  } finally {
    await endpoint.stop(); await ctx.fiber.dispose()
    // Kernel rmdir refuses a populated cgroup; never recursively delete or kill an unknown range here.
    await rmdir(pool)
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
