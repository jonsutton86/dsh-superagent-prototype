/** Installed-Harness authority restart and resource handoff; generated control credentials never enter model context. */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { OwnershipClient } from '../../src/ownership/client.ts'
import type { OwnershipClaim, OwnershipEnrollment, OwnershipView } from '../../src/ownership/protocol.ts'
import { RemoteClient } from '../../src/remote/client.ts'
import type { RemoteJob } from '../../src/remote/protocol.ts'
import { remoteFixture } from './remote.ts'

export async function qualifyOwnership(input: { cli: string; home: string; profile: string; directory: string; temporary: string; port: number; native: boolean }) {
  const root = await realpath(input.temporary), stateDir = join(root, 'ownership-authority'), patch = join(input.directory, 'ownership.json')
  const url = `http://127.0.0.1:${input.port}`, credentialFile = join(stateDir, 'admin.token'), cleanup: (() => Promise<unknown>)[] = []
  await writeFile(patch, JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port: input.port } },
    { id: 'dsh-superagent', disabled: true }, { id: 'session-title-llm', disabled: true },
    { insert: [{ id: 'ownership-qualification', name: 'dsh-superagent/ownership-authority', config: { stateDir } }] },
  ]), { mode: 0o600 })
  let child: ChildProcess | undefined
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const running = child, exited = new Promise<void>(resolve => running.once('exit', () => resolve()))
    running.kill('SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
    try { await exited } finally { clearTimeout(timer) }
  }
  const start = async () => {
    child = spawn(input.cli, ['--profile', input.profile, '--patch', patch, '--no-open'], {
      cwd: resolve('.'), env: { ...process.env, DSH_HOME: input.home }, stdio: 'ignore',
    })
    let authorityId = ''
    await vi.waitFor(async () => {
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Ownership authority Harness exited during startup')
      const token = (await readFile(credentialFile, 'utf8')).trim()
      const response = await fetch(url + '/ownership/v1', { method: 'POST', signal: AbortSignal.timeout(1000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'identity' }) })
      expect(response.ok).toBe(true)
      const envelope = await response.json() as { authorityId: string; result: { id: string } }
      expect(envelope.result.id).toBe(envelope.authorityId); authorityId = envelope.authorityId
    }, { timeout: 30_000, interval: 250 })
    return new OwnershipClient({ url, authorityId, credentialFile })
  }
  try {
    const admin = await start()
    const enrollment = await admin.call<OwnershipEnrollment>({ op: 'coordinator.create', requestId: randomUUID(), id: 'coordinator', resources: ['endpoint'] })
    const claimant = admin.withCredential(enrollment.credential)
    const acquire = () => claimant.call<OwnershipClaim>({ op: 'lease.acquire', requestId: randomUUID(), instanceId: randomUUID(), leaseMs: 60_000 })
    const first = await acquire(), owner = admin.withCredential(first.credential), resourceFile = join(root, 'resource.token')
    await writeFile(resourceFile, enrollment.resources[0]!.credential, { mode: 0o600 })
    const access = { authorityId: admin.connection.authorityId, coordinatorId: 'coordinator', proof: () => first.credential }
    const endpoint = await remoteFixture(cleanup, { native: input.native, access,
      ownership: { ...admin.connection, credentialFile: resourceFile, coordinatorId: 'coordinator', resourceId: 'endpoint' },
      beforeEnroll: async endpoint => {
        await endpoint.ownership!.refresh(); await owner.call({ op: 'lease.activate', requestId: randomUUID() })
        await endpoint.ownership!.refresh()
      } })
    const old = await endpoint.client.call<RemoteJob>(endpoint.spawn('sleep 30; printf stale > stale-result'))
    await vi.waitFor(() => expect(endpoint.endpoint.journal.job(old.id).phase).toBe('started'))
    await stop()
    await endpoint.endpoint.ownership!.refresh().catch(() => {})
    expect(await endpoint.settled(old.id)).toMatchObject({ quiescent: true, ownership: first.lease.owner })
    const restarted = await start()
    expect(restarted.connection.authorityId).toBe(admin.connection.authorityId)
    expect(await claimant.call<OwnershipView>({ op: 'lease.inspect' })).toMatchObject({ phase: 'vacant', epoch: 1 })
    const next = await acquire(), successor = admin.withCredential(next.credential)
    await endpoint.endpoint.ownership!.refresh(); await successor.call({ op: 'lease.activate', requestId: randomUUID() })
    await expect(endpoint.client.call(endpoint.spawn('touch forbidden'))).rejects.toThrow('superseded')
    const client = new RemoteClient({ ...endpoint.client.connection, ownership: { ...access, proof: () => next.credential } })
    const fresh = await client.call<RemoteJob>(endpoint.spawn('printf successor > successor-result'))
    await endpoint.settled(fresh.id)
    expect(fresh).toMatchObject({ grantId: old.grantId, epoch: old.epoch, ownership: { epoch: 2 } })
    expect(await client.call({ op: 'fs.read', path: 'successor-result' })).toBe('successor')
    expect(await client.call({ op: 'fs.stat', path: 'stale-result' })).toBeNull()
  } finally {
    try { for (const dispose of cleanup.reverse()) await dispose() } finally { await stop() }
  }
}
