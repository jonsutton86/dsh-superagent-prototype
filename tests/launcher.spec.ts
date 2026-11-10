import { execFile, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const script = resolve('scripts/agentic-os')
let root: string, cli: string, checkout: string
const installations: string[] = []
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agentic os launcher ')))
  cli = join(root, 'fake harness.cjs'); copyFileSync(resolve('tests/fixtures/launcher.cjs'), cli); chmodSync(cli, 0o700)
  checkout = join(root, 'built checkout'); mkdirSync(join(checkout, 'lib'), { recursive: true })
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'dsh-superagent' }))
  for (const name of ['index.js', 'client.js']) writeFileSync(join(checkout, 'lib', name), 'export {}\n')
})
afterEach(async () => {
  for (const directory of installations.splice(0).reverse()) {
    rmSync(join(directory, 'state/ignore-stop'), { force: true })
    if (existsSync(join(directory, 'installation.json')) && JSON.parse(readFileSync(join(directory, 'installation.json'), 'utf8')).phase === 'ready') {
      const stopped = await run(directory, 'stop', '--stop-timeout', '3')
      expect(stopped.code, stopped.stderr).toBe(0)
    }
  }
  rmSync(root, { force: true, recursive: true })
})
function run(directory: string, action: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [script, action, '--directory', directory, ...args],
    { env: { ...process.env, DSH_LAUNCHER_FIXTURE: root }, timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr })))
}
async function port() {
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const value = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve())); return value
}
async function initialize(name = 'application') {
  const directory = join(root, name); installations.push(directory)
  const selectedPort = await port()
  const result = await run(directory, 'init', '--checkout', checkout, '--dsh', cli, '--port', String(selectedPort))
  expect(result.code, result.stderr).toBe(0)
  return { directory, port: selectedPort }
}
const state = async (directory: string) => JSON.parse((await run(directory, 'status')).stdout)
async function start(directory: string) { const result = await run(directory, 'start', '--timeout', '4'); expect(result.code, result.stderr).toBe(0); return state(directory) }

it('installs privately and preserves provider configuration and credential files on repeated init', async () => {
  const { directory } = await initialize(), profile = join(directory, 'home/profiles/agentic-os/cordis.patch.yml')
  writeFileSync(profile, '# operator provider settings\n[]\n', { mode: 0o600 })
  const credential = join(directory, 'home/.credentials.yaml'); writeFileSync(credential, 'synthetic credential fixture\n', { mode: 0o600 })
  const before = readFileSync(join(root, 'created'), 'utf8')
  expect((await run(directory, 'init')).code).toBe(0)
  expect(readFileSync(profile, 'utf8')).toContain('operator provider settings')
  expect(readFileSync(credential, 'utf8')).toBe('synthetic credential fixture\n')
  expect(readFileSync(join(root, 'created'), 'utf8')).toBe(before)
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  expect(statSync(join(directory, 'installation.json')).mode & 0o777).toBe(0o600)
  expect((await run(directory, 'init', '--port', '3099')).stderr).toContain('differs')
})

it('resumes interrupted plugin installation without replacing the already-created profile', async () => {
  const directory = join(root, 'resumable'); installations.push(directory)
  writeFileSync(join(root, 'fail-plugin-once'), 'fail')
  expect((await run(directory, 'init', '--checkout', checkout, '--dsh', cli, '--port', String(await port()))).code).toBe(1)
  const profile = join(directory, 'home/profiles/agentic-os/cordis.patch.yml'); writeFileSync(profile, '# preserve on resume\n[]\n')
  expect((await run(directory, 'start')).stderr).toContain('incomplete')
  expect((await run(directory, 'init')).code).toBe(0)
  expect(readFileSync(profile, 'utf8')).toContain('preserve on resume')
  expect(readFileSync(join(root, 'created'), 'utf8').trim().split('\n')).toHaveLength(1)
})

it('isolates identical profile names in two homes and preserves data through duplicate start, graceful stop and restart', async () => {
  const first = await initialize('first home'), second = await initialize('second home')
  const a = await start(first.directory), b = await start(second.directory)
  expect(a.process.pid).not.toBe(b.process.pid)
  rmSync(join(first.directory, 'process.json'))
  expect((await start(first.directory)).process).toEqual(a.process)
  expect(readFileSync(join(first.directory, 'state/launch-count'), 'utf8')).toBe('1')
  writeFileSync(join(first.directory, 'state/kept'), 'original data')
  expect((await run(first.directory, 'stop', '--stop-timeout', '2')).code).toBe(0)
  expect((await state(first.directory)).manuallyStopped).toBe(true)
  expect((await state(second.directory)).process).toEqual(b.process)
  expect((await run(first.directory, 'restart', '--respect-stop')).stdout).toContain('skipped')
  expect((await state(first.directory)).process).toBeNull()
  const restarted = await run(first.directory, 'restart', '--timeout', '4', '--stop-timeout', '2')
  expect(restarted.code, restarted.stderr).toBe(0)
  expect(readFileSync(join(first.directory, 'state/kept'), 'utf8')).toBe('original data')
  expect(readFileSync(join(first.directory, 'state/launch-count'), 'utf8')).toBe('2')
  expect((await state(first.directory)).manuallyStopped).toBe(false)
}, 20000)

it('creates a private authenticated shortcut without printing its token', async () => {
  const { directory } = await initialize(); await start(directory)
  const result = await run(directory, 'access'); expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).not.toContain('fixture-access-secret')
  const shortcut = JSON.parse(result.stdout).shortcut
  expect(readFileSync(shortcut, 'utf8')).toContain('fixture-access-secret')
  expect(readFileSync(shortcut, 'utf8')).toContain('no-referrer')
  expect(statSync(shortcut).mode & 0o777).toBe(0o600)
})

it('leaves a slow process intact after stop timeout and retains the intentional-stop marker', async () => {
  const { directory } = await initialize(); const before = await start(directory)
  writeFileSync(join(directory, 'state/ignore-stop'), 'hold')
  const result = await run(directory, 'stop', '--stop-timeout', '0.1')
  expect(result.code).toBe(1); expect(result.stderr).toContain('no forced kill')
  expect(await state(directory)).toMatchObject({ process: before.process, manuallyStopped: true })
  expect((await run(directory, 'start', '--respect-stop')).stdout).toContain('skipped')
})

it('refuses changed launch configuration, wrong health identity and occupied ports without stopping unrelated services', async () => {
  const { directory, port: selectedPort } = await initialize()
  const patchFile = join(directory, 'launch.json'), original = readFileSync(patchFile, 'utf8')
  writeFileSync(patchFile, '[]\n'); expect((await run(directory, 'start')).stderr).toContain('launch patch was changed')
  writeFileSync(patchFile, original)
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(selectedPort, '127.0.0.1', resolve))
  try { expect((await run(directory, 'start')).stderr).toContain('port is in use'); expect(occupied.listening).toBe(true) }
  finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
  const before = await start(directory)
  writeFileSync(join(directory, 'state/health.json'), JSON.stringify({ setup: { machine: { stateDir: '/unrelated' }, problem: null } }))
  expect(await state(directory)).toMatchObject({ process: before.process, ready: false })
  expect((await run(directory, 'start', '--timeout', '0.1')).stderr).toContain('left intact')
  expect((await state(directory)).process).toEqual(before.process)
  writeFileSync(join(directory, 'state/health.json'), JSON.stringify({ health: { runtime: 'invalid' } }))
  expect(await state(directory)).toMatchObject({ process: before.process, ready: false })
})

it('ignores a forged PID receipt belonging to another installation', async () => {
  const a = await initialize('unstarted'), b = await initialize('running'); const running = await start(b.directory)
  writeFileSync(join(a.directory, 'process.json'), JSON.stringify(running.process), { mode: 0o600 })
  expect((await run(a.directory, 'stop')).code).toBe(0)
  expect((await state(b.directory)).process).toEqual(running.process)
})

it('refuses health redirects without contacting the redirect target', async () => {
  const { directory } = await initialize(); const before = await start(directory)
  writeFileSync(join(directory, 'state/health.json'), JSON.stringify({ testRedirect: true }))
  expect(await state(directory)).toMatchObject({ process: before.process, ready: false })
  expect(existsSync(join(directory, 'state/followed-redirect'))).toBe(false)
})

it('does not signal a running instance while another operation holds its lock', async () => {
  const { directory } = await initialize(); const before = await start(directory)
  const holder = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"ab"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', join(directory, 'operation.lock')])
  const closed = new Promise<void>(resolve => holder.once('close', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => { holder.once('error', reject); holder.stdout.once('data', () => resolve()); holder.once('exit', () => reject(new Error('Lock holder exited early'))) })
    const result = await run(directory, 'stop', '--stop-timeout', '0.1')
    expect(result.code).toBe(1); expect(result.stderr).toContain('Another operation')
    expect(existsSync(join(directory, 'manually-stopped'))).toBe(false)
  } finally { holder.stdin.end(); await closed }
  expect((await state(directory)).process).toEqual(before.process)
})
