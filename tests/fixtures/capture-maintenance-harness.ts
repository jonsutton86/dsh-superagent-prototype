/** Fresh installed Harness loader, isolated HOME, no provider traffic or operator installation changes. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { EndpointConfig } from '../../src/remote/endpoint-plugin.ts'
import type { WorkspaceCaptureRecord } from '../../src/remote/workspace-capture.ts'
import { RPC_PATH } from '../../src/remote/protocol.ts'

export async function qualifyCaptureMaintenance(cli: string, config: Omit<EndpointConfig, 'allowedEnv' | 'maxRunning' | 'outputMaxBytes'>,
  request: WorkspaceCaptureRecord['request']) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-capture-profile-'))), home = join(directory, 'home'), installation = join(directory, 'installation')
  const environment = { ...Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])),
    HOME: home, npm_config_ignore_workspace_root_check: 'true' }
  const profile = 'capture-' + randomUUID(), receiptFile = join(directory, 'capture-status.json')
  let child: ChildProcess | undefined, log = ''
  try {
    await mkdir(home, { mode: 0o700 })
    const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
    await promisify(execFile)('python3', [resolve('scripts/agentic-os'), 'init', '--directory', installation, '--role', 'workspace',
      '--checkout', resolve('.'), '--dsh', cli, '--profile', profile, '--port', String(port)], { cwd: directory, env: environment, timeout: 120000 })
    const launch = JSON.parse(await readFile(join(installation, 'launch.json'), 'utf8')) as unknown[], patch = join(directory, 'capture.patch.json')
    await writeFile(patch, JSON.stringify([...launch, { id: 'dsh-superagent', disabled: true }, { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'capture-maintenance-endpoint', name: 'dsh-superagent/remote-endpoint', config: { ...config, maintenance: { mode: 'capture', request, receiptFile } } }] }]), { mode: 0o600 })
    child = spawn(cli, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: directory,
      env: { ...environment, DSH_HOME: join(installation, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.on('data', chunk => { log = (log + String(chunk)).slice(-40000) })
    child.stderr!.on('data', chunk => { log = (log + String(chunk)).slice(-40000) })
    await vi.waitFor(async () => {
      expect(child!.exitCode).toBeNull()
      expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toMatchObject({ version: 1, mode: 'capture', executionOwnership: false,
        capture: { phase: 'complete', request, result: { managedQuiescenceObserved: true, globalSnapshotVerified: false } } })
    }, { timeout: 45000, interval: 250 })
    const response = await fetch(`http://127.0.0.1:${port}${RPC_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
    // Harness's unmatched POST reaches its static fallback (405), rather than a 404 router response.
    // A registered endpoint RPC would authenticate this request and return its JSON 401 instead.
    const absent = await fetch(`http://127.0.0.1:${port}/missing-capture-route-${randomUUID()}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(405)
    expect(response.status).toBe(absent.status)
    expect(await response.text()).toBe(await absent.text())
  } catch (error) {
    throw new Error(String(error) + '\n' + log.split('\n').filter(line => !/key|token|secret|credential|authorization/i.test(line)).slice(-30).join('\n'))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const running = child, done = new Promise<void>(resolve => running.once('exit', () => resolve()))
      running.kill('SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
      try { await done } finally { clearTimeout(timer) }
    }
    await rm(directory, { recursive: true, force: true })
  }
}
