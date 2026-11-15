/** Execute the actual trusted helper against an explicit simulated kernel; never invokes native execve. */
import { afterEach, expect, it, vi } from 'vitest'
import { budgetFiles } from '../src/remote/resource-model.ts'

const fs = vi.hoisted(() => ({ values: new Map<string, string>(), joined: false, rejectJoin: false, uid: 501 }))
vi.mock('node:fs', () => ({
  constants: { O_WRONLY: 1, O_NOFOLLOW: 2, X_OK: 1 },
  accessSync: () => {}, closeSync: () => {}, openSync: () => 10,
  lstatSync: () => ({ uid: fs.uid, isDirectory: () => true }),
  realpathSync: (path: string) => path,
  statfsSync: () => ({ type: 0x63677270 }),
  readFileSync: (path: string) => {
    if (path.endsWith('/cgroup.type')) return 'domain'
    if (path.endsWith('/cgroup.procs')) return fs.joined && !fs.rejectJoin ? '1234' : ''
    const value = fs.values.get(path); if (value === undefined) throw new Error('Missing simulated kernel file'); return value
  },
  writeSync: () => { fs.joined = true },
}))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

async function execute(change?: (group: string, workspace: string, pool: string) => void, nested = true) {
  fs.values.clear(); fs.joined = false; fs.rejectJoin = false; fs.uid = 501
  const pool = '/delegated/pool', workspace = pool + '/workspace', group = (nested ? workspace : pool) + '/command'
  const budget = { cpuPercent: 100, memoryBytes: 268435456, processes: 32 }
  const expected = { command: budgetFiles(budget), pool: budgetFiles(budget, false), ...(nested ? { workspace: budgetFiles(budget, false) } : {}) }
  for (const [path, settings] of [[pool, expected.pool], [group, expected.command], ...(nested ? [[workspace, expected.workspace!]] : [])] as [string, Record<string, string>][]) {
    for (const [file, value] of Object.entries(settings)) fs.values.set(path + '/' + file, value)
  }
  change?.(group, workspace, pool)
  const execve = vi.fn(), stderr = vi.fn()
  const fakeProcess = { platform: 'linux', pid: 1234, getuid: () => 501,
    argv: ['node', 'helper', group, JSON.stringify(expected), '/bin/true', 'private-argument'],
    env: { PRIVATE_TOKEN: 'private-environment' }, execve, stderr: { write: stderr }, exitCode: undefined as number | undefined }
  vi.stubGlobal('process', fakeProcess)
  await import('../src/remote/resource-worker.ts')
  return { execve, stderr, fakeProcess }
}

it.each([false, true])('executes only after matching limits and membership for nested=%s', async nested => {
  const result = await execute(undefined, nested)
  expect(fs.joined).toBe(true)
  expect(result.execve).toHaveBeenCalledOnce()
  expect(result.fakeProcess.exitCode).toBeUndefined()
})

it.each(['command', 'workspace', 'pool'])('refuses a changed %s limit before joining or executing', async level => {
  const result = await execute((command, workspace, pool) => fs.values.set(({ command, workspace, pool }[level]!) + '/memory.max', 'max'))
  expect(fs.joined).toBe(false)
  expect(result.execve).not.toHaveBeenCalled()
  expect(result.fakeProcess.exitCode).toBe(125)
  expect(result.stderr).toHaveBeenCalledWith('Endpoint resource boundary could not be established; command was not executed.\n')
})

it('refuses unconfirmed membership and suppresses command/environment payloads', async () => {
  const result = await execute(() => { fs.rejectJoin = true })
  expect(result.execve).not.toHaveBeenCalled()
  expect(result.fakeProcess.exitCode).toBe(125)
  expect(JSON.stringify(result.stderr.mock.calls)).not.toMatch(/private-argument|private-environment/)
})
