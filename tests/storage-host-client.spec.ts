import { createServer } from 'node:http'
import { remoteHandler } from '../src/remote/http.ts'
import { Store } from '../src/app/store.ts'
import { Endpoints } from '../src/environments/endpoints.ts'
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { EndpointStorage } from '../src/remote/storage-model.ts'
import { StorageReservations, storageRoots } from '../src/remote/storage-journal.ts'
import { LocalStorageHost } from '../src/remote/storage-host-client.ts'
import { RemoteEndpoint } from '../src/remote/endpoint.ts'
import { BubblewrapIsolation } from '../src/remote/isolation.ts'
import { confinedFilesystem } from '../src/remote/filesystem-runner.ts'
import type { GrantReceipt, Principal, RemoteJob } from '../src/remote/protocol.ts'

it.runIf(!!process.env.DSH_STORAGE_SERVICE_CONFIG)('starts, enrolls, executes and recovers a storage-backed endpoint as its unprivileged user', async () => {
  const config = JSON.parse(process.env.DSH_STORAGE_SERVICE_CONFIG!) as { endpointId: string; uid: number; policy: unknown }
  expect(process.platform).toBe('linux'); expect(process.getuid?.()).toBe(config.uid); expect(config.uid).toBeGreaterThan(0)
  const policy = EndpointStorage.parse(config.policy), directory = await mkdtemp(join(tmpdir(), 'dsh-storage-client-'))
  const state = join(directory, 'state'), assignedRoot = `${policy.mountRoot}/dsh-${config.endpointId}/workspaces`
  const ctx = new Context(), filesystem = new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 })
  const subprocess = new LocalSubprocessRuntime(ctx), isolation = new BubblewrapIsolation(subprocess)
  const client = new LocalStorageHost(process.env.DSH_STORAGE_SERVICE_SOCKET!)
  const host = { stateDir: state, root: assignedRoot, filesystem, subprocess, isolation,
    filesystemRpc: confinedFilesystem(subprocess, isolation, resolve('lib/remote-fs-worker.js')),
    snapshotHelper: resolve('lib/verification-snapshot-worker.js'), storage: { endpointId: config.endpointId, policy, host: client } }
  let endpoint = new RemoteEndpoint(host)
  const server = createServer((request, response) => { void remoteHandler(endpoint)(request, response).catch(() => response.destroy()) })
  let store: Store | undefined, coordinator: Endpoints | undefined
  const openCoordinator = () => {
    store = new Store(join(directory, 'coordinator.sqlite'))
    coordinator = new Endpoints({ store, stateDir: join(directory, 'coordinator'), lifetime: new AbortController().signal,
      workerRoots: () => [assignedRoot] })
  }
  try {
    await endpoint.start()
    expect(endpoint.journal.id).toBe(config.endpointId)
    await expect(writeFile(join(assignedRoot, 'unprivileged-parent-write'), 'no')).rejects.toMatchObject({ code: 'EACCES' })
    const enrollment = { op: 'grant.create', requestId: 'socket-original', owner: 'coordinator', workspace: 'socket-one',
      operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 }
    if (process.env.DSH_STORAGE_REPAIR_EXCHANGE) {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      openCoordinator()
      await coordinator!.register({ requestId: 'register-storage', endpointId: config.endpointId,
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, name: 'Storage recovery',
        credentialFile: join(state, 'admin.token'), revision: 0 })
      expect(await coordinator!.submit(config.endpointId, { revision: 1, request: enrollment })).toMatchObject({
        id: enrollment.requestId, phase: 'unknown' })
      const command = coordinator!.commands(config.endpointId).items[0]!
      await coordinator!.stop(); store!.close(); openCoordinator()
      expect(coordinator!.commands(config.endpointId).items[0]).toEqual(command)
      const pending = new StorageReservations(endpoint.journal, policy).list().find(item => item.workspace === enrollment.workspace)!
      expect(pending).toMatchObject({ requestId: enrollment.requestId, phase: 'provisioning' })
      expect(endpoint.journal.grants()).toHaveLength(0)
      await writeFile(join(process.env.DSH_STORAGE_REPAIR_EXCHANGE, 'ready'), 'waiting', { mode: 0o600 })
      await vi.waitFor(async () => expect(await readFile(join(process.env.DSH_STORAGE_REPAIR_EXCHANGE!, 'done'), 'utf8')).toBe('repaired'), { timeout: 30000, interval: 100 })
      await endpoint.stop(); endpoint = new RemoteEndpoint(host); await endpoint.start()
      const retained = new StorageReservations(endpoint.journal, policy).list().find(item => item.workspace === enrollment.workspace)!
      expect(retained).toEqual(pending)
      expect(await coordinator!.storageStatus(config.endpointId, { workspace: enrollment.workspace })).toMatchObject({
        state: 'observed', phase: 'provisioning', reservedAllocations: 2 })
      expect(coordinator!.commands(config.endpointId).items[0]).toEqual(command)
      const recovered = await coordinator!.retry(config.endpointId, enrollment.requestId)
      expect(recovered).toMatchObject({ id: enrollment.requestId, phase: 'done', result: { grant: { workspace: enrollment.workspace } } })
      expect(endpoint.journal.grants()).toHaveLength(1)
      expect(await coordinator!.retry(config.endpointId, enrollment.requestId)).toEqual(recovered)
    }
    const receipt = await endpoint.rpc({ role: 'admin' }, enrollment) as GrantReceipt
    const principal: Principal = { role: 'grant', id: receipt.grant.id, epoch: receipt.grant.epoch }
    await endpoint.rpc(principal, { op: 'fs.write', requestId: 'write', path: 'hello', content: 'quota-backed', expected: { kind: 'createIfAbsent' } })
    expect(await endpoint.rpc(principal, { op: 'fs.read', path: 'hello' })).toBe('quota-backed')
    const launch = async (id: string, argv: string[], verify = false) => {
      await endpoint.rpc(principal, { op: 'job.spawn', requestId: id, revision: receipt.grant.revision, argv, cwd: receipt.grant.root, graceMs: 100, env: {},
        ...(verify ? { verification: { kind: 'check', snapshot: { repository: 'none' } } } : {}) })
      let job: RemoteJob | undefined
      await vi.waitFor(async () => {
        job = await endpoint.rpc(principal, { op: 'job.get', id }) as RemoteJob
        expect(job.quiescent).toBe(true)
      }, { timeout: 20000 })
      return job!
    }
    expect((await launch('read', ['/bin/sh', '-c', 'test "$(cat hello)" = quota-backed'])).outcome?.exitCode).toBe(0)
    const checked = await launch('verify', ['/bin/sh', '-c', 'test "$(cat hello)" = quota-backed'], true)
    expect(checked, checked.error).toMatchObject({ outcome: { exitCode: 0 }, verification: { stage: 'finished', storageReleased: true } })
    await expect(access(join(state, 'verification'))).rejects.toThrow()
    expect((await launch('socket-hidden', ['/usr/bin/python3', '-c', 'import os,sys; assert not os.path.exists(sys.argv[1])',
      process.env.DSH_STORAGE_SERVICE_SOCKET!])).outcome?.exitCode).toBe(0)
    expect((await launch('fill', ['/usr/bin/python3', '-c', "import os; f=open('full','wb'); os.posix_fallocate(f.fileno(),0,20*1024*1024)"])).outcome?.exitCode).toBe(1)
    await expect(endpoint.rpc(principal, { op: 'recovery.world', revision: 'a'.repeat(32) })).rejects.toThrow('quota policy and host-registry')
    const allocations = new StorageReservations(endpoint.journal, policy).list()
    expect(allocations).toHaveLength(2) // The persistent startup proof allocation is charged to the same pool.
    const original = allocations.find(item => item.workspace === 'socket-one')!
    expect(original.phase).toBe('provisioned')
    await expect(endpoint.rpc({ role: 'admin' }, { ...enrollment, requestId: 'reserved', workspace: '__dsh_startup' })).rejects.toThrow('reserved')
    await endpoint.stop(); endpoint = new RemoteEndpoint(host); await endpoint.start()
    const replay = await endpoint.rpc({ role: 'admin' }, enrollment) as GrantReceipt
    expect(replay.grant.id).toBe(receipt.grant.id)
    expect(new StorageReservations(endpoint.journal, policy).list()).toHaveLength(2)
    expect(await endpoint.rpc(principal, { op: 'fs.read', path: 'hello' })).toBe('quota-backed')
    const forged = { ...original, endpointId: randomUUID() }
    await expect(client.observe(policy, forged, storageRoots(policy, forged), AbortSignal.timeout(20000))).rejects.toThrow('Storage host response')
    await expect(client.observe(policy, original, ['/unassigned'], AbortSignal.timeout(20000))).rejects.toThrow('Storage host response')
    await expect(client.observe(policy, original, storageRoots(policy, original), AbortSignal.abort())).rejects.toThrow()
  } finally {
    await coordinator?.stop(); store?.close()
    if (server.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await endpoint.stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 90000)
