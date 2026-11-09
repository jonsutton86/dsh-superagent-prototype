import { Context } from '@deepseek-ai/cordis'
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { scrubbedParentEnv, type SubprocessRuntime, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Setup } from '../src/app/setup.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { verifyLocalWorkspace, workerBin, workerGitConfig } from '../src/infra/environment.ts'
import { filesystem } from './fixtures/filesystem.ts'
import { Config, machineOf } from '../src/deployment.ts'
import type { MissionView } from '../src/workspace/model.ts'
import type { LibraryEntry } from '../src/workspace/library-model.ts'
import { startRuntime } from './fixtures/host.ts'
import { testMachine } from './fixtures/deployment.ts'
import { inputMessage } from '../src/executor/dsh.ts'
import { hostVerification } from './fixtures/host-verification.ts'

const close: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
let sequence = 0
const requestId = () => `local-${++sequence}`
const exec = promisify(execFile)
function localProcesses() {
  const calls: string[][] = []
  const subprocess = { spawn: (spec: SubprocessSpawnSpec) => {
    calls.push([...spec.argv])
    let stdout = '', stderr = ''
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, signal: spec.signal,
      env: { ...scrubbedParentEnv(), ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => { stdout += String(data) }); child.stderr.on('data', data => { stderr += String(data) })
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', exitCode => resolve({ exitCode, signal: null })) })
    return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } } }
  } } as unknown as SubprocessRuntime
  return { subprocess, calls }
}
function directory() { const path = mkdtempSync(join(tmpdir(), 'agentic-local-')); close.push(() => rmSync(path, { recursive: true, force: true })); return path }

it('starts local setup with a real child process and no GitHub CLI, repository, or Git probe', async () => {
  const stateDir = directory(), context = new Context(), process = localProcesses()
  context.reflect.provide('subprocess', process.subprocess)
  context.reflect.provide('fs', filesystem)
  const setup = new Setup({ context, machine: testMachine({ stateDir, executionMode: 'local' }), lifetime: new AbortController().signal, restart: vi.fn() })
  close.push(() => setup.restore())
  expect(await setup.run(SettingsSchema.parse({}))).toBe(true)
  expect(setup.deployment).toMatchObject({ executionMode: 'local' })
  expect(setup.deployment.github).toBeUndefined()
  expect(process.calls).toHaveLength(1); expect(process.calls[0]![0]).toBe('cat')
  expect(readdirSync(join(stateDir, 'work'))).toEqual([])
  expect(readFileSync(workerGitConfig(stateDir), 'utf8')).not.toContain('auth git-credential')
  await expect(exec(join(workerBin(stateDir), 'gh'), ['api', 'user'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unavailable in local') })
  const commands = new Commands(() => setup.deployment, setup.commandEnvironment, new AbortController().signal)
  await expect(commands.gh(['api', 'user'])).rejects.toThrow('unavailable in local')
})

it('rejects a mismatched subprocess/filesystem world and removes its probe', async () => {
  const path = directory(), subprocess = { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }),
    collected: { stdout: { readFrom: () => ({ text: 'different-world' }) } } }) } as unknown as SubprocessRuntime
  await expect(verifyLocalWorkspace(path, subprocess, new AbortController().signal, filesystem)).rejects.toThrow('same local process')
  expect(readdirSync(path)).toEqual([])
})

it('refuses profile mode changes while incompatible tickets remain open', async () => {
  const stateDir = directory(), context = new Context(), subprocess = localProcesses()
  context.reflect.provide('subprocess', subprocess.subprocess)
  context.reflect.provide('fs', filesystem)
  const setup = new Setup({ context, machine: testMachine({ stateDir, executionMode: 'local' }), lifetime: new AbortController().signal,
    restart: vi.fn(), incompatibleTickets: () => true })
  expect(await setup.run(SettingsSchema.parse({}))).toBe(false)
  expect(setup.problem?.code).toBe('executionModeMismatch')
  expect(subprocess.calls).toEqual([])
})

it('validates local mode configuration and rejects misspelled modes', () => {
  expect(machineOf(Config({ stateDir: '/tmp/local-profile', executionMode: 'local' })).executionMode).toBe('local')
  expect(() => Config({ stateDir: '/tmp/local-profile', executionMode: 'cloud' as never })).toThrow()
})

it('runs a local mission through actual management routes and Harness tools with no configured accounts', async () => {
  const host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'exit 77' } })
  }, { executionMode: 'local', noAccounts: true })
  close.push(() => host.stop())
  const state = await host.api('GET', 'state')
  expect(state.body).toMatchObject({ setup: { executionMode: 'local', problem: null, accounts: { repository: null, agent: null, feishu: null } }, paused: false })
  expect(host.runtime.configured()).toBe(true)
  expect(host.runtime.sources.instance('github')?.enabled).toBe(false)
  expect(host.runtime.sources.scope({ source: 'github', meta: {} }).listened).toBe(false)
  const config = host.runtime.prompts.current().config
  const prompt = host.runtime.prompts.compose(config, 'worker')
  expect(prompt).toContain('general-purpose worker')
  expect(prompt).not.toContain('Use gh for ALL GitHub operations')
  expect(host.runtime.prompts.skills(config)).toEqual([])
  const prompts = await host.api('GET', 'prompts')
  expect(prompts.body).toMatchObject({ defaults: { delivery: expect.stringContaining('publish supported artifacts') } })
  let result = await host.api('POST', 'missions', { requestId: requestId(), title: 'Research brief', objective: 'Create a durable briefing', acceptance: 'Review the saved brief' })
  let mission = result.body as unknown as MissionView
  result = await host.api('POST', `missions/${mission.id}/actions`, { requestId: requestId(), revision: mission.revision,
    title: 'Write brief', instructions: 'Write and preserve the research brief', owner: 'agent' })
  mission = result.body as unknown as MissionView
  result = await host.api('POST', `missions/${mission.id}/actions/${mission.actions[0]!.id}`, { requestId: requestId(), revision: mission.revision, command: 'run' })
  mission = result.body as unknown as MissionView
  await host.runtime.idle()
  const ticketId = mission.actions[0]!.ticket!.id, ticket = host.runtime.store.tickets.get(ticketId)!, sessionId = `worker-${ticketId}`
  expect(ticket.execution).toMatchObject({ mode: 'local', directory: expect.stringContaining('/work/') })
  expect(readdirSync(ticket.execution!.directory)).toEqual([])
  expect(host.agents.has(sessionId)).toBe(true)
  // Local defaults must only name registered tools for each role, preserving the existing prompt budgets.
  for (const role of ['worker', 'orchestrator'] as const) {
    const text = host.runtime.prompts.compose(config, role)
    const names = [...text.matchAll(/\b(?:orchestrator|workspace)_[a-z_]+\b/g)].map(match => match[0])
    const registered = host.tools.get(role === 'worker' ? sessionId : host.runtime.masterId)
    expect(names.filter(name => !registered?.has(name))).toEqual([])
    expect(text.length).toBeLessThan(role === 'worker' ? 40_500 : 59_000)
  }
  const resumed = { id: 'local-resumed', triggerId: 'follow-up', kind: 'resumed' as const, at: new Date().toISOString() }
  expect(inputMessage(resumed, undefined, true)).toContain('saved files')
  expect(inputMessage(resumed, undefined, true)).not.toMatch(/worktree|git history|PR state/)
  expect(inputMessage(resumed)).toContain('git history')
  expect(host.subprocess.spawn.mock.calls.every(([spec]) => spec.argv[0] !== 'git' && spec.argv[0] !== 'sh' && !spec.argv.some(arg => arg.includes('api')))).toBe(true)
  await expect(host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'Not a PR', pr_number: 42 })).rejects.toThrow('unavailable')
  const check = await hostVerification(host, mission.actions[0]!.ticket!.id, close)
  const artifact = await host.runTool(sessionId, 'workspace_publish', { requestId: requestId(), kind: 'artifact', title: 'Research brief', summary: 'Saved briefing', content: '# Brief\nEvidence and findings.' }) as unknown as LibraryEntry
  const selection = await check(artifact.id, '# Brief\nEvidence and findings.')
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: `Brief saved: ${artifact.id}` })
  mission = host.runtime.workspace.get(mission.id)
  result = await host.api('POST', `missions/${mission.id}/actions/${mission.actions[0]!.id}`, { requestId: requestId(), revision: mission.revision,
    command: 'complete', ticketRevision: mission.actions[0]!.ticket!.revision, text: 'Read the saved brief and checked its evidence', reviewKind: 'checks', checks: [selection] })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  mission = result.body as unknown as MissionView
  expect((await host.api('PUT', `missions/${mission.id}`, { requestId: requestId(), revision: mission.revision, status: 'completed' })).status).toBe(200)
  expect(host.runtime.library.read(artifact.id).content).toBe('# Brief\nEvidence and findings.')
})
