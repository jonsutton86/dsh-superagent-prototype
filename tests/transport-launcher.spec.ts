import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { freePort, sshHost } from './fixtures/ssh-host.ts'

for (const name of ['configuration', 'pins', 'permissions', 'parser', 'resume', 'health', 'stop_after_corruption']) {
  it(`checks transport ${name} without external credentials or connections`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic transport ')))
    try {
      const result = await new Promise<{ code: number; stderr: string }>(fulfill => execFile('python3',
        [resolve('tests/fixtures/transport.py'), resolve('scripts'), root, name], { timeout: 10000 },
        (error, _stdout, stderr) => fulfill({ code: error ? 1 : 0, stderr })))
      expect(result.code, result.stderr).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 12000)
}

it.runIf(process.env.DSH_SSH_TRANSPORT_QUALIFICATION === '1')('forwards over native SSH, verifies identity and recovers its connection without restarting endpoint work', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentic native SSH ')))
  const directory = join(root, 'transport $HOME %n'), endpointId = randomUUID(), credential = randomBytes(32).toString('base64url')
  let currentId = endpointId, requests = 0
  const endpoint = createServer((request, response) => {
    let content = ''
    request.on('data', chunk => { content += String(chunk) })
    request.on('end', () => {
      if (request.url !== '/execution/v1' || request.headers.authorization !== 'Bearer ' + credential || request.headers['x-dsh-endpoint'] !== endpointId || content !== '{"op":"identity"}') {
        response.writeHead(403).end(); return
      }
      requests++
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ endpointId: currentId, result: { id: currentId, protocol: 1, platform: 'linux', confinement: 'linux-bubblewrap',
        capabilities: { filesystem: true, process: true, administration: true, effectOwnership: true, credentialBindings: true, snapshotVerification: true } } }))
    })
  })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  const endpointPort = (endpoint.address() as { port: number }).port
  let host: Awaited<ReturnType<typeof sshHost>> | undefined, supervisor: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined
  let initialized = false, serviceInstalled = false
  const run = (action: string, ...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(fulfill =>
    execFile('python3', [resolve('scripts/agentic-os'), action, '--directory', directory, ...args], { timeout: 30000 },
      (error, stdout, stderr) => fulfill({ code: error ? 1 : 0, stdout, stderr })))
  const okay = async (action: string, ...args: string[]) => { const result = await run(action, ...args); expect(result.code, result.stderr).toBe(0); return result.stdout }
  const state = async () => JSON.parse((await run('status')).stdout)
  try {
    host = await sshHost(join(root, 'ssh host'), endpointPort)
    const enrollmentFile = join(root, 'endpoint.json'), credentialFile = join(root, 'endpoint.token'), configFile = join(root, 'transport.json')
    await writeFile(credentialFile, credential, { mode: 0o600 })
    await writeFile(enrollmentFile, JSON.stringify({ endpointId, url: `http://127.0.0.1:${endpointPort}`, credentialFile: '/remote/admin.token',
      platform: 'linux', confinement: 'linux-bubblewrap', maxRunning: 8, outputMaxBytes: 8388608 }), { mode: 0o600 })
    const { stop: _stop, ...connection } = host
    await writeFile(configFile, JSON.stringify({ ...connection, credentialFile, enrollmentFile }), { mode: 0o600 })
    await okay('init', '--role', 'transport', '--transport-config', configFile, '--port', String(await freePort())); initialized = true
    await okay('start', '--timeout', '10')
    const before = await state(); expect(before).toMatchObject({ ready: true, role: 'transport', endpoint: { endpointId } })
    expect(await okay('start', '--timeout', '3')).not.toContain(credential)
    expect((await state()).process).toEqual(before.process)
    const enrollment = JSON.parse(await okay('enrollment'))
    expect(enrollment).toMatchObject({ endpointId, credentialFile, transport: 'managed-ssh' })
    currentId = randomUUID()
    expect(await state()).toMatchObject({ ready: false, process: before.process })
    expect((await run('enrollment')).code).toBe(1)
    currentId = endpointId
    await okay('restart', '--timeout', '10', '--stop-timeout', '3')
    const restarted = await state(); expect(restarted.process.pid).not.toBe(before.process.pid)
    supervisor = spawn('python3', [resolve('scripts/agentic-os'), 'supervise', '--directory', directory, '--timeout', '10', '--stop-timeout', '3', '--restart-delay', '0.2'], { stdio: 'ignore' })
    closed = new Promise((resolve, reject) => { supervisor!.once('close', resolve); supervisor!.once('error', reject) })
    await vi.waitFor(async () => expect((await state()).supervision).toMatchObject({ running: true, phase: 'running' }), { timeout: 10000 })
    process.kill(restarted.process.pid, 'SIGKILL')
    await vi.waitFor(async () => {
      const value = await state(); expect(value.ready).toBe(true); expect(value.process.pid).not.toBe(restarted.process.pid)
    }, { timeout: 15000, interval: 200 })
    await vi.waitFor(async () => { await okay('stop', '--stop-timeout', '3') }, { timeout: 10000, interval: 200 })
    expect(await state()).toMatchObject({ ready: false, process: null, manuallyStopped: true })
    expect(await okay('start', '--respect-stop')).toContain('skipped')
    supervisor.kill('SIGTERM'); await closed; supervisor = undefined
    if (process.env.DSH_NATIVE_SERVICE_QUALIFICATION === '1') {
      // The service copies its transport implementation and preserves Stop across installation.
      serviceInstalled = true
      await okay('service-install', '--timeout', '10', '--stop-timeout', '3', '--restart-delay', '0.2')
      await vi.waitFor(async () => expect(await state()).toMatchObject({ process: null, supervision: { running: true, phase: 'manually-stopped' } }), { timeout: 10000 })
      await okay('start', '--timeout', '10'); expect((await state()).ready).toBe(true)
      await okay('service-remove', '--stop-timeout', '3'); serviceInstalled = false
    }
    const storedConfig = await readFile(join(directory, 'ssh.conf'), 'utf8')
    await writeFile(join(directory, 'ssh.conf'), storedConfig + '\nProxyCommand false\n')
    expect((await run('start', '--timeout', '3')).code).toBe(1)
    await okay('stop', '--stop-timeout', '3')
    await writeFile(join(directory, 'ssh.conf'), storedConfig)
    // A changed local trust pin is refused before SSH starts.
    const wrongKey = await readFile(host.identityFile + '.pub', 'utf8')
    await writeFile(join(directory, 'known_hosts'), `[127.0.0.1]:${host.sshPort} ${wrongKey}`)
    expect((await run('start', '--timeout', '3')).code).toBe(1)
    expect((await state()).process).toBe(null)
    // A newly reviewed configuration with the wrong host key reaches OpenSSH and is refused there.
    const wrongKnown = join(root, 'wrong_known_hosts'), wrongConfig = join(root, 'wrong.json'), wrongDirectory = join(root, 'wrong host')
    await writeFile(wrongKnown, `[127.0.0.1]:${host.sshPort} ${wrongKey}`, { mode: 0o600 })
    await writeFile(wrongConfig, JSON.stringify({ ...connection, credentialFile, enrollmentFile, knownHostsFile: wrongKnown }), { mode: 0o600 })
    await okay('init', '--directory', wrongDirectory, '--role', 'transport', '--transport-config', wrongConfig, '--port', String(await freePort()))
    const refused = await run('start', '--directory', wrongDirectory, '--timeout', '5')
    expect(refused.code).toBe(1); expect(refused.stderr).toContain('SSH exited')
    expect(JSON.parse((await run('status', '--directory', wrongDirectory)).stdout).process).toBe(null)
    expect(requests).toBeGreaterThan(0)
  } finally {
    if (initialized) await vi.waitFor(async () => { await okay('stop', '--stop-timeout', '3') }, { timeout: 15000, interval: 200 })
    if (supervisor) { supervisor.kill('SIGTERM'); await closed }
    if (serviceInstalled) await okay('service-remove', '--stop-timeout', '3')
    await host?.stop()
    endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
