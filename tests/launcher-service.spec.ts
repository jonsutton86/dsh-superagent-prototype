import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const script = resolve('scripts/agentic-os')
let root: string, directory: string, cli: string, checkout: string
const supervisors: { child: ChildProcess; closed: Promise<number | null> }[] = []
const env = () => ({ ...process.env, DSH_LAUNCHER_FIXTURE: root })
function run(action: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [script, action, '--directory', directory, ...args],
    { env: env(), timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr })))
}
const json = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'))
async function state() { return JSON.parse((await run('status')).stdout) }
const wait = async (assert: () => unknown | Promise<unknown>) => vi.waitFor(assert, { timeout: 10_000, interval: 100 })
async function ready() {
  await wait(async () => {
    const current = await state()
    expect(current).toMatchObject({ ready: true, supervision: { running: true, phase: 'running', process: current.process } })
  })
  return state()
}
function supervise(...args: string[]) {
  const child = spawn('python3', [script, 'supervise', '--directory', directory, '--timeout', '3', '--stop-timeout', '3', '--restart-delay', '0.2', ...args], { env: env(), stdio: 'ignore' })
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const value = { child, closed }; supervisors.push(value); return value
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agentic service '))); directory = join(root, 'installation $HOME %n')
  cli = join(root, 'fake harness.cjs'); copyFileSync(resolve('tests/fixtures/launcher.cjs'), cli); chmodSync(cli, 0o700)
  checkout = join(root, 'checkout'); mkdirSync(join(checkout, 'lib'), { recursive: true })
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'dsh-superagent' }))
  for (const file of ['index.js', 'client.js']) writeFileSync(join(checkout, 'lib', file), 'export {}')
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
  const result = await run('init', '--checkout', checkout, '--dsh', cli, '--port', String(port))
  expect(result.code, result.stderr).toBe(0)
})
afterEach(async () => {
  rmSync(join(directory, 'state/ignore-stop'), { force: true })
  // Stop through the installation's identity-checked control before terminating any test supervisor.
  await wait(async () => expect((await run('stop', '--stop-timeout', '3')).code).toBe(0))
  if (existsSync(join(directory, 'service.json'))) {
    const result = await run('service-remove', '--stop-timeout', '3')
    expect(result.code, result.stderr).toBe(0)
  }
  for (const { child, closed } of supervisors.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
  }
  rmSync(root, { force: true, recursive: true })
})

it('recovers an exited Harness, preserves state and honors manual stop across supervisor restarts', async () => {
  const first = supervise(); const before = await ready()
  writeFileSync(join(directory, 'state/durable.txt'), 'keep this state')
  process.kill(before.process.pid, 'SIGKILL')
  await wait(async () => {
    const next = await state(); expect(next.ready).toBe(true); expect(next.process.pid).not.toBe(before.process.pid)
    expect(next.supervision).toMatchObject({ phase: 'running', process: next.process })
  })
  expect(readFileSync(join(directory, 'state/durable.txt'), 'utf8')).toBe('keep this state')
  expect((await run('stop', '--stop-timeout', '3')).code).toBe(0)
  await wait(async () => expect(await state()).toMatchObject({ process: null, manuallyStopped: true, supervision: { phase: 'manually-stopped' } }))
  first.child.kill('SIGTERM'); expect(await first.closed).toBe(0)
  supervise()
  await wait(async () => expect(await state()).toMatchObject({ process: null, manuallyStopped: true, supervision: { running: true, phase: 'manually-stopped' } }))
  expect(readFileSync(join(directory, 'state/launch-count'), 'utf8')).toBe('2')
  expect((await run('start', '--timeout', '3')).code).toBe(0)
  await ready()
}, 30000)

it('leaves a live unhealthy Harness intact, refuses a duplicate supervisor and shuts down gracefully', async () => {
  const first = supervise(); const before = await ready()
  const duplicate = supervise(); expect(await duplicate.closed).toBe(1)
  writeFileSync(join(directory, 'state/health.json'), JSON.stringify({ health: { runtime: { state: 'error' } } }))
  await wait(async () => expect(await state()).toMatchObject({ ready: false, process: before.process, supervision: { phase: 'running' } }))
  expect(readFileSync(join(directory, 'state/launch-count'), 'utf8')).toBe('1')
  first.child.kill('SIGTERM'); expect(await first.closed).toBe(0)
  expect(await state()).toMatchObject({ process: null, manuallyStopped: false, supervision: { running: false, phase: 'stopped' } })
  expect(existsSync(join(directory, 'state/graceful-stop'))).toBe(true)
}, 20000)

it('persists a restart-budget hold across supervisor replacement until a successful explicit start', async () => {
  const first = supervise('--restart-limit', '2'); const initial = await ready()
  process.kill(initial.process.pid, 'SIGKILL')
  await wait(async () => {
    const current = await state(); expect(current.ready).toBe(true); expect(current.process.pid).not.toBe(initial.process.pid)
    expect(current.supervision).toMatchObject({ phase: 'running', process: current.process })
  })
  process.kill((await state()).process.pid, 'SIGKILL')
  await wait(async () => expect(await state()).toMatchObject({ process: null, supervision: { phase: 'held', reason: 'automatic-start-budget-exhausted' } }))
  first.child.kill('SIGTERM'); expect(await first.closed).toBe(0)
  supervise('--restart-limit', '2')
  await wait(async () => expect(await state()).toMatchObject({ process: null, supervision: { running: true, phase: 'held' } }))
  expect(json('supervision-attempts.json')).toHaveLength(2)
  expect((await run('start', '--timeout', '3')).code).toBe(0)
  await ready(); expect(json('supervision-attempts.json')).toEqual([])
}, 30000)

it('holds a failed automatic startup without replacing configuration or retrying indefinitely', async () => {
  const patch = readFileSync(join(directory, 'launch.json'), 'utf8')
  writeFileSync(join(directory, 'launch.json'), '[]')
  supervise()
  await wait(async () => expect(await state()).toMatchObject({ process: null, supervision: { phase: 'held', reason: 'startup-failed-check-private-log-and-status' } }))
  writeFileSync(join(directory, 'launch.json'), patch)
  expect((await state()).process).toBe(null)
  expect((await run('start', '--timeout', '3')).code).toBe(0)
  await ready()
}, 20000)

it('preserves a process that exceeds graceful supervisor shutdown timeout', async () => {
  const first = supervise('--stop-timeout', '0.2'); const before = await ready()
  writeFileSync(join(directory, 'state/ignore-stop'), 'hold')
  first.child.kill('SIGTERM'); expect(await first.closed).toBe(1)
  expect(await state()).toMatchObject({ process: before.process, manuallyStopped: false,
    supervision: { running: false, phase: 'held', reason: 'graceful-shutdown-failed-process-left-intact' } })
}, 15000)

it('generates service arguments without shell evaluation or inherited provider secrets', async () => {
  const source = `import sys,json,plistlib
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import agentic_service as s
args=SimpleNamespace(timeout=60,stop_timeout=300,restart_delay=10,restart_limit=5,restart_window=600)
out={}
for platform in ['darwin','linux']:
 s.sys.platform=platform
 value=s.settings(Path(sys.argv[2]),args)
 content=s.definition(value)
 out[platform]={'value':value,'content':plistlib.loads(content.encode()) if platform=='darwin' else content}
print(json.dumps(out))`
  const output = await new Promise<string>((fulfill, reject) => execFile('python3', ['-c', source, resolve('scripts'), directory],
    { env: { ...env(), DEEPSEEK_API_KEY: 'synthetic-do-not-export' } }, (error, stdout, stderr) => error ? reject(new Error(stderr)) : fulfill(stdout)))
  expect(output).not.toContain('synthetic-do-not-export')
  const result = JSON.parse(output)
  expect(result.darwin.content.ProgramArguments).toContain(directory)
  expect(result.darwin.content).toMatchObject({ KeepAlive: true, AbandonProcessGroup: true, Umask: 63 })
  expect(result.linux.content).toContain('$$HOME %%n')
  expect(result.linux.content).toContain(`WorkingDirectory=${directory.replaceAll('%', '%%')}\n`)
  expect(result.linux.content).toContain('KillMode=mixed\nSendSIGKILL=no')
  expect(Object.keys(result.linux.value.environment).sort()).toEqual(['PATH', 'PYTHONUNBUFFERED'])
})

it.runIf(process.platform === 'linux')('passes the native systemd unit parser with spaces, dollar signs and percent specifiers in the installation path', async () => {
  const runtime = join(directory, 'service-runtime'); mkdirSync(runtime, { mode: 0o700 })
  for (const file of ['agentic-os', 'agentic_endpoint.py', 'agentic_service.py', 'agentic_delegation.py']) copyFileSync(resolve('scripts', file), join(runtime, file))
  const source = `import sys,subprocess,os
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import agentic_service as s
root=Path(sys.argv[2])
value=s.settings(root, SimpleNamespace(timeout=60,stop_timeout=300,restart_delay=10,restart_limit=5,restart_window=600))
unit=root/value['label']; unit.write_text(s.definition(value))
os.environ['XDG_RUNTIME_DIR']=str(root)
sys.exit(subprocess.run(['systemd-analyze','--user','verify','--man=no',str(unit)]).returncode)`
  const result = await new Promise<{ code: number; stderr: string }>(fulfill => execFile('python3', ['-c', source, resolve('scripts'), directory],
    { env: env(), timeout: 15000 }, (error, _stdout, stderr) => fulfill({ code: error ? 1 : 0, stderr })))
  expect(result.code, result.stderr).toBe(0)
})

it.runIf(process.env.DSH_NATIVE_SERVICE_QUALIFICATION === '1')('installs the native user service, survives Harness failure, preserves manual stop and removes only its own service', async () => {
  const args = ['--timeout', '3', '--stop-timeout', '3', '--restart-delay', '0.2']
  const installed = await run('service-install', ...args); expect(installed.code, installed.stderr).toBe(0)
  const receipt = json('service.json'), before = await ready()
  expect(statSync(receipt.path).mode & 0o777).toBe(0o600)
  expect((await run('service-install', ...args)).code).toBe(0)
  expect((await state()).process).toEqual(before.process)
  const definition = readFileSync(receipt.path, 'utf8')
  writeFileSync(receipt.path, definition + '\n<!-- operator edit -->\n')
  const refused = await run('service-remove', '--stop-timeout', '3')
  expect(refused.code).toBe(1); expect(refused.stderr).toContain('changed')
  expect((await state()).process).toEqual(before.process)
  expect(existsSync(join(directory, 'manually-stopped'))).toBe(false)
  writeFileSync(receipt.path, definition)
  process.kill(before.process.pid, 'SIGKILL')
  await wait(async () => {
    const current = await state(); expect(current.ready).toBe(true); expect(current.process.pid).not.toBe(before.process.pid)
    expect(current.supervision).toMatchObject({ phase: 'running', process: current.process })
  })
  expect((await run('stop', '--stop-timeout', '3')).code).toBe(0)
  await wait(async () => expect(await state()).toMatchObject({ process: null, manuallyStopped: true, supervision: { running: true, phase: 'manually-stopped' } }))
  const count = readFileSync(join(directory, 'state/launch-count'), 'utf8')
  expect((await run('service-status')).stdout).toContain('"installed": true')
  const removed = await run('service-remove', '--stop-timeout', '3'); expect(removed.code, removed.stderr).toBe(0)
  expect(existsSync(receipt.path)).toBe(false)
  expect((await state()).process).toBe(null)
  expect(readFileSync(join(directory, 'state/launch-count'), 'utf8')).toBe(count)
  expect(json('installation.json').phase).toBe('ready')
}, 45000)

it.runIf(process.env.DSH_INSTALLED_SERVICE_QUALIFICATION === '1')('runs pinned Harness under the native service manager and preserves paused state through service removal and reinstallation', async () => {
  const harness = process.env.DSH_SERVICE_QUALIFICATION_CLI
  if (!harness) throw new Error('Supply DSH_SERVICE_QUALIFICATION_CLI with the pinned installed Harness path')
  directory = join(root, 'installed Harness')
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
  const initialized = await run('init', '--checkout', resolve('.'), '--dsh', harness, '--port', String(port))
  expect(initialized.code, initialized.stderr).toBe(0)
  const args = ['--timeout', '60', '--stop-timeout', '60']
  const installed = await run('service-install', ...args); expect(installed.code, installed.stderr).toBe(0)
  await vi.waitFor(async () => expect(await state()).toMatchObject({ ready: true, supervision: { running: true, phase: 'running' } }), { timeout: 75000, interval: 500 })
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    expect(response.status).toBe(200); return response.json() as Promise<any>
  }
  expect(await api('executor/pause', { paused: true })).toMatchObject({ paused: true })
  const before = await state(), receipt = json('service.json')
  const removed = await run('service-remove', '--stop-timeout', '60'); expect(removed.code, removed.stderr).toBe(0)
  expect((await state()).process).toBe(null)
  expect(existsSync(receipt.path)).toBe(false)
  const reinstalled = await run('service-install', ...args); expect(reinstalled.code, reinstalled.stderr).toBe(0)
  await wait(async () => expect(await state()).toMatchObject({ process: null, manuallyStopped: true, supervision: { phase: 'manually-stopped' } }))
  const started = await run('start', '--timeout', '60'); expect(started.code, started.stderr).toBe(0)
  await ready(); expect((await state()).process).not.toEqual(before.process)
  expect(await api('state')).toMatchObject({ paused: true })
}, 180000)
