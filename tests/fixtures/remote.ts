import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import { RemoteEndpoint } from '../../src/remote/endpoint.ts'
import { remoteHandler } from '../../src/remote/http.ts'
import { RemoteClient } from '../../src/remote/client.ts'
import { RemoteFileSystem } from '../../src/remote/filesystem.ts'
import { RemoteSubprocess } from '../../src/remote/subprocess.ts'
import { confinedFilesystem } from '../../src/remote/filesystem-runner.ts'
import { BubblewrapIsolation, type ExecutionIsolation } from '../../src/remote/isolation.ts'
import type { GrantReceipt, RemoteJob } from '../../src/remote/protocol.ts'

/** Real Harness local providers and real HTTP; test-only passthrough never enters the production endpoint plugin. */
export async function remoteFixture(cleanup: (() => Promise<unknown>)[], options: { leaseMs?: number; outputMaxBytes?: number; native?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-')), ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 }), process = new LocalSubprocessRuntime(ctx)
  const isolation: ExecutionIsolation = options.native ? new BubblewrapIsolation(process) : { name: 'test-only-unconfined',
    wrap: async (argv, _root, _cwd, _network, _signal, _env, helper, mounts = []) => argv.map(arg => {
      if (arg === '/run/dsh-filesystem.mjs' && helper) return helper
      const mounted = mounts.find(mount => mount.target === arg)
      if (mounted) return mounted.source
      if (arg.startsWith('{"argv":') && mounts.length) {
        const config = JSON.parse(arg)
        config.bindings = config.bindings.map((binding: { path: string }) => ({ ...binding, path: mounts.find(mount => mount.target === binding.path)!.source }))
        return JSON.stringify(config)
      }
      return arg
    }) }
  const host = { stateDir: join(directory, 'control'), root: join(directory, 'work'), filesystem: fs, subprocess: process,
    isolation, filesystemRpc: confinedFilesystem(process, isolation, fileURLToPath(new URL(options.native ? '../../lib/remote-fs-worker.js' : '../../src/remote/fs-worker.ts', import.meta.url))),
    commandHelper: fileURLToPath(new URL(options.native ? '../../lib/remote-command-worker.js' : '../../src/remote/command-worker.ts', import.meta.url)),
    outputMaxBytes: options.outputMaxBytes, shutdownMs: 2000 }
  let endpoint = new RemoteEndpoint(host)
  await endpoint.start()
  let lose = false, offline = false
  let handler = remoteHandler(endpoint)
  const server = createServer((req, res) => {
    if (offline) { res.destroy(); return }
    if (lose) { lose = false; res.end = (() => { res.destroy(); return res }) as typeof res.end }
    void handler(req, res).catch(() => res.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const connection = { url, endpointId: endpoint.journal.id, credentialFile: join(directory, 'control/admin.token'), timeoutMs: 1000 }
  const admin = new RemoteClient(connection)
  const enrolled = await admin.call<GrantReceipt>({ op: 'grant.create', requestId: 'enroll', owner: 'coordinator', workspace: 'task',
    operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: options.leaseMs ?? 300_000 })
  const credentialFile = join(directory, 'grant.token'); await writeFile(credentialFile, enrolled.credential!, { mode: 0o600 })
  const client = new RemoteClient({ ...connection, credentialFile })
  const world = new Context(), remoteFs = new RemoteFileSystem(world, client, enrolled.grant), remoteProcess = new RemoteSubprocess(world, client, enrolled.grant)
  cleanup.push(async () => { offline = false; await endpoint.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await world.fiber.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const spawn = (script: string, extra = {}) => ({ op: 'job.spawn' as const, requestId: randomUUID(), revision: enrolled.grant.revision,
    argv: ['/bin/sh', '-c', script], cwd: enrolled.grant.root, graceMs: 100, env: {}, ...extra })
  const settled = async (id: string) => {
    let value: RemoteJob | undefined
    await vi.waitFor(async () => { value = await client.call<RemoteJob>({ op: 'job.get', id }); expect(value.quiescent).toBe(true) }, { timeout: 5000 })
    return value!
  }
  return { directory, ctx, get endpoint() { return endpoint }, server, url, connection, admin, client, enrolled, remoteFs, remoteProcess, fs, isolation, spawn, settled,
    restart: async () => { await endpoint.stop(); endpoint = new RemoteEndpoint(host); await endpoint.start(); handler = remoteHandler(endpoint) },
    lose: () => { lose = true }, failResponse: () => {
      const rpc = endpoint.rpc.bind(endpoint)
      vi.spyOn(endpoint, 'rpc').mockImplementationOnce(async (...args) => { await rpc(...args); throw new Error('Response failed after commit') })
    }, offline: (value: boolean) => { offline = value } }
}
