import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { expect, it, vi } from 'vitest'
import { RemoteClient } from '../src/remote/client.ts'
import type { RemoteGrant, RemoteJob } from '../src/remote/protocol.ts'
import { sshHost } from './fixtures/ssh-host.ts'

async function unusedPort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port
}

/** No inference or external publication: actual pinned Harness daemons and Linux namespace confinement. */
it.runIf(process.env.DSH_ENDPOINT_LAUNCHER_QUALIFICATION === '1')('enrolls a confined Harness endpoint through native SSH and preserves work through transport and daemon restarts', async () => {
  const cli = process.env.DSH_ENDPOINT_QUALIFICATION_CLI
  if (!cli || process.platform !== 'linux') throw new Error('Supply a pinned installed Harness CLI on Linux for endpoint launch qualification')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh endpoint installed ')))
  const endpoint = join(root, 'execution host'), coordinator = join(root, 'coordinator host'), transport = join(root, 'SSH transport'), started: string[] = []
  let ssh: Awaited<ReturnType<typeof sshHost>> | undefined
  const run = (directory: string, action: string, ...args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile('python3', [join(process.cwd(), 'scripts/agentic-os'), action, '--directory', directory, ...args],
      { timeout: 180_000, env: process.env }, (error, stdout, stderr) => error ? reject(new Error(`Launcher ${action}: ${stderr.trim() || 'command failed'}`)) : resolve(stdout))
  })
  try {
    const endpointPort = await unusedPort(), coordinatorPort = await unusedPort()
    for (const [directory, role, port] of [[endpoint, 'endpoint', endpointPort], [coordinator, 'workspace', coordinatorPort]] as const) {
      await run(directory, 'init', '--role', role, '--checkout', resolve('.'), '--dsh', cli, '--port', String(port))
      started.push(directory)
      await run(directory, 'start', '--timeout', '60')
    }
    const endpointBefore = JSON.parse(await run(endpoint, 'status'))
    const originalMetadata = JSON.parse(await run(endpoint, 'enrollment'))
    expect(endpointBefore).toMatchObject({ ready: true, role: 'endpoint', endpoint: { id: originalMetadata.endpointId, confinement: 'linux-bubblewrap' } })
    ssh = await sshHost(join(root, 'SSH host'), endpointPort)
    const credentialFile = join(root, 'coordinator-admin.token'), enrollmentFile = join(root, 'endpoint-enrollment.json'), transportConfig = join(root, 'transport.json')
    await writeFile(credentialFile, await readFile(originalMetadata.credentialFile), { mode: 0o600 })
    await writeFile(enrollmentFile, JSON.stringify(originalMetadata), { mode: 0o600 })
    const { stop: _stop, ...sshConfiguration } = ssh
    await writeFile(transportConfig, JSON.stringify({ ...sshConfiguration, credentialFile, enrollmentFile }), { mode: 0o600 })
    await run(transport, 'init', '--role', 'transport', '--transport-config', transportConfig, '--port', String(await unusedPort()))
    started.push(transport)
    await run(transport, 'start', '--timeout', '15')
    const metadata = JSON.parse(await run(transport, 'enrollment'))
    expect(metadata.endpointId).toBe(originalMetadata.endpointId)
    expect(metadata.url).not.toBe(originalMetadata.url)
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${coordinatorPort}/orchestrator/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(`Coordinator ${path}: HTTP ${response.status}`)
      return data as any
    }
    const registration = await api('endpoints', { requestId: 'launcher-endpoint', endpointId: metadata.endpointId, name: 'Installed Linux endpoint',
      url: metadata.url, credentialFile: metadata.credentialFile, revision: 0 })
    const command = await api(`endpoints/${registration.id}/commands`, { revision: registration.revision, request: { op: 'grant.create',
      requestId: 'launcher-grant', owner: 'coordinator', workspace: 'launcher-proof', operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 } })
    expect(command.phase).toBe('done')
    const world = await api('worlds', { requestId: 'launcher-world', endpointId: registration.id, commandId: command.id, name: 'Launcher execution world' })
    expect(world.ready, world.problem).toBe(true)
    const profile = await api(`endpoints/${registration.id}/commands/${command.id}/profile`, { port: await unusedPort() })
    const config = profile.patch.flatMap((entry: any) => entry.insert ?? []).find((entry: any) => entry.id === 'operator-remote-world').config
    const remote = new RemoteClient({ url: metadata.url, endpointId: metadata.endpointId, credentialFile: config.credentialFile })
    const original = await remote.call<{ grant: RemoteGrant; authorized: boolean }>({ op: 'grant.status' })
    expect(original.authorized).toBe(true)
    const request = { op: 'job.spawn' as const, requestId: 'launcher-native-command', revision: original.grant.revision,
      argv: ['/bin/sh', '-c', 'test ! -e "$1" && printf one >> invocation-count && sleep 3 && printf launcher-native-proof > proof.txt && cat proof.txt', 'launcher-test', metadata.credentialFile],
      cwd: original.grant.root, graceMs: 1000 }
    const job = await remote.call<RemoteJob>(request)
    const connection = JSON.parse(await run(transport, 'status'))
    process.kill(connection.process.pid, 'SIGKILL')
    await expect(remote.call({ op: 'job.get', id: job.id })).rejects.toThrow()
    await run(transport, 'start', '--timeout', '15')
    await vi.waitFor(async () => expect(await remote.call<RemoteJob>({ op: 'job.get', id: job.id })).toMatchObject({ phase: 'settled', quiescent: true, outcome: { exitCode: 0 } }), { timeout: 15000, interval: 200 })
    const resultPath = join(original.grant.root, 'proof.txt')
    expect(await remote.call({ op: 'fs.read', path: resultPath })).toBe('launcher-native-proof')
    expect(await remote.call({ op: 'fs.read', path: join(original.grant.root, 'invocation-count') })).toBe('one')
    await expect(remote.call({ op: 'fs.read', path: metadata.credentialFile })).rejects.toThrow()
    await run(endpoint, 'restart', '--timeout', '60', '--stop-timeout', '60')
    expect(JSON.parse(await run(endpoint, 'status')).endpoint).toEqual(endpointBefore.endpoint)
    expect((await remote.call<RemoteJob>(request)).id).toBe(job.id)
    expect(await remote.call({ op: 'fs.read', path: resultPath })).toBe('launcher-native-proof')
    await run(coordinator, 'restart', '--timeout', '60', '--stop-timeout', '60')
    const restored = await api(`worlds/${world.id}/refresh`, {})
    expect(restored).toMatchObject({ id: world.id, ready: true })
    expect(await remote.call<RemoteJob>({ op: 'job.get', id: job.id })).toMatchObject({ phase: 'settled', quiescent: true, outcome: { exitCode: 0 } })
    await run(endpoint, 'stop', '--stop-timeout', '60')
    expect(await run(endpoint, 'start', '--respect-stop')).toContain('skipped')
  } catch (error) {
    const diagnostics: string[] = []
    for (const directory of [endpoint, coordinator]) {
      try {
        const content = await readFile(join(directory, 'install.log'), 'utf8')
        diagnostics.push(content.split('\n').filter(line => !/api.?key|authoriz|credential|token|secret|signing/i.test(line)).slice(-30).join('\n'))
      } catch { /* Installation may not have started. */ }
      try {
        const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'))
        const content = await readFile(join(directory, 'logs', run.log), 'utf8')
        diagnostics.push(content.split('\n').filter(line => !/api.?key|authoriz|credential|token|secret|signing/i.test(line)).slice(-80).join('\n'))
      } catch { /* The failure can precede log creation. */ }
    }
    throw new Error(`${String(error)}\nHarness launch diagnostics (sensitive lines omitted):\n${diagnostics.join('\n')}`, { cause: error })
  } finally {
    for (const directory of started.reverse()) await run(directory, 'stop', '--stop-timeout', '60')
    await ssh?.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 300000)
