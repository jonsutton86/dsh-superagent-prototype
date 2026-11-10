import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { expect, it, vi } from 'vitest'
import { RemoteClient } from '../src/remote/client.ts'
import type { GrantReceipt, RemoteJob } from '../src/remote/protocol.ts'

it.each(['profile_durability', 'process_identity', 'plan', 'prepare', 'refusals', 'drain', 'replay', 'manual_stop', 'success', 'failure', 'terminal_intent', 'stop_fence'])('preserves delegated-service %s contracts with an explicit simulated kernel', async name => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh delegation ')))
  try {
    const result = await new Promise<{ error: Error | null; stderr: string }>(resolveResult => execFile('python3',
      [resolve('tests/fixtures/delegation.py'), resolve('scripts'), root, name], { timeout: 10000 },
      (error, _stdout, stderr) => resolveResult({ error, stderr })))
    expect(result.error, result.stderr).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
}, 12500)

/** Actual user manager, kernel groups and pinned Harness; requires a dedicated Linux service user. */
it.runIf(process.env.DSH_DELEGATED_SERVICE_QUALIFICATION === '1')('runs resource-bound Harness inside its own user service through manual stop, restart and service replacement', async () => {
  const cli = process.env.DSH_ENDPOINT_QUALIFICATION_CLI
  if (process.platform !== 'linux' || !cli) throw new Error('Supply the pinned Harness on a Linux host with CPU/memory/pids delegated to its user manager')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh delegated native '))), directory = join(root, 'endpoint')
  const run = (action: string, ...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(done => execFile('python3',
    [resolve('scripts/agentic-os'), action, '--directory', directory, ...args], { timeout: 150000 },
    (error, stdout, stderr) => done({ code: error ? 1 : 0, stdout, stderr })))
  const required = async (action: string, ...args: string[]) => { const result = await run(action, ...args); expect(result.code, result.stderr).toBe(0); return result.stdout }
  const state = async () => JSON.parse((await run('status')).stdout)
  let initialized = false, installed = false
  try {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve()))
    const budgets = { pool: { cpuPercent: 200, memoryBytes: 1024 ** 3, processes: 128 }, command: { cpuPercent: 100, memoryBytes: 256 * 1024 ** 2, processes: 32 } }
    const file = join(root, 'budgets.json'); await writeFile(file, JSON.stringify(budgets), { mode: 0o600 })
    await required('init', '--role', 'endpoint', '--checkout', resolve('.'), '--dsh', cli, '--port', String(port), '--service-resources', file)
    initialized = true
    await required('service-install', '--timeout', '60', '--stop-timeout', '60')
    installed = true
    await vi.waitFor(async () => expect(await state()).toMatchObject({ ready: true, supervision: { phase: 'running' } }), { timeout: 75000, interval: 500 })
    const before = await state(), metadata = JSON.parse(await required('enrollment'))
    const expectedGroup = before.delegation.cgroup.replace('/sys/fs/cgroup', '') + '/control'
    expect((await readFile(`/proc/${before.process.pid}/cgroup`, 'utf8')).trim()).toBe('0::' + expectedGroup)
    const admin = new RemoteClient({ url: metadata.url, endpointId: metadata.endpointId, credentialFile: metadata.credentialFile })
    const enrolled = await admin.call<GrantReceipt>({ op: 'grant.create', requestId: 'service-proof-grant', owner: 'coordinator', workspace: 'service-proof', operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 })
    if (!enrolled.credential) throw new Error('The new grant did not return a credential')
    const grantFile = join(root, 'grant.token'); await writeFile(grantFile, enrolled.credential, { mode: 0o600 })
    const client = new RemoteClient({ url: metadata.url, endpointId: metadata.endpointId, credentialFile: grantFile })
    const request = { op: 'job.spawn' as const, requestId: 'service-proof-job', revision: enrolled.grant.revision, cwd: enrolled.grant.root,
      argv: ['/bin/sh', '-c', 'test ! -e /sys/fs/cgroup && printf service-proof > proof'], env: {}, graceMs: 100 }
    await client.call(request)
    await vi.waitFor(async () => expect(await client.call<RemoteJob>({ op: 'job.get', id: request.requestId })).toMatchObject({ quiescent: true, outcome: { exitCode: 0 }, resources: { complete: true } }), { timeout: 15000 })
    const receipt = await client.call<RemoteJob>({ op: 'job.get', id: request.requestId })
    await required('restart', '--timeout', '60', '--stop-timeout', '60')
    const restarted = await state()
    expect(restarted.process.pid).not.toBe(before.process.pid)
    expect(restarted.endpoint.id).toBe(before.endpoint.id)
    expect(restarted.endpoint.resources.policy).toEqual(before.endpoint.resources.policy)
    expect(restarted.serviceStart.phase).toBe('done')
    expect(await client.call<RemoteJob>(request)).toMatchObject({ id: receipt.id, outcome: receipt.outcome, resources: receipt.resources, quiescent: true })
    await required('stop', '--stop-timeout', '60')
    expect(await required('start', '--respect-stop')).toContain('skipped')
    expect(await state()).toMatchObject({ process: null, manuallyStopped: true })
    await required('service-remove', '--stop-timeout', '60'); installed = false
    await required('service-install', '--timeout', '60', '--stop-timeout', '60'); installed = true
    expect(await state()).toMatchObject({ process: null, manuallyStopped: true })
    await required('start', '--timeout', '60')
    expect(await state()).toMatchObject({ ready: true, manuallyStopped: false, endpoint: { id: before.endpoint.id } })
    expect(await client.call<RemoteJob>({ op: 'job.get', id: request.requestId })).toMatchObject({ resources: receipt.resources, quiescent: true })
  } finally {
    if (initialized) await required('stop', '--stop-timeout', '60')
    if (installed || await readFile(join(directory, 'service.json')).then(() => true, () => false)) await required('service-remove', '--stop-timeout', '60')
    await rm(root, { recursive: true, force: true })
  }
}, 300000)
