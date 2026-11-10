/** Opt-in actual Harness retry boundary: scripted inference, fresh state and no external provider traffic. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { executorRecoveryProvider } from './fixtures/executor-recovery-provider.ts'

type Event = { sessionId: string; type: string; at: number; turn?: number; step?: number; retry?: number; maxRetries?: number; delayMs?: number; retryId?: string }
it.runIf(process.env.DSH_EXECUTOR_RECOVERY_QUALIFICATION === '1')('uses native installed Harness request retries then holds the failed worker without an outer continuation', async () => {
  const cli = process.env.DSH_EXECUTOR_RECOVERY_QUALIFICATION_CLI ?? process.env.DSH_ENDPOINT_QUALIFICATION_CLI ?? process.env.DSH_WATCHDOG_QUALIFICATION_CLI
  if (!cli) throw new Error('Supply an installed Harness qualification CLI')
  const checkout = resolve('.'), directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh executor recovery ')))
  const root = join(directory, 'workspace'), home = join(directory, 'user-home'), trace = join(directory, 'events.jsonl')
  const log = join(directory, 'harness.log'), profile = 'executor-recovery-' + randomUUID(), model = { provider: 'qualification', model: 'scripted' }
  const safeEnvironment = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
  const environment = { ...safeEnvironment, HOME: home }
  await mkdir(home, { mode: 0o700 }); await writeFile(trace, '', { mode: 0o600 })
  const provider = await executorRecoveryProvider()
  let child: ChildProcess | undefined, stage = 'fresh isolated installation'
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const running = child, done = new Promise<void>(resolve => running.once('exit', () => resolve()))
    running.kill('SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
    try { await done } finally { clearTimeout(timer) }
  }
  const events = async (): Promise<Event[]> => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  try {
    const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
    const installed = await promisify(execFile)('python3', [join(checkout, 'scripts/agentic-os'), 'init', '--directory', root, '--role', 'workspace',
      '--checkout', checkout, '--dsh', cli, '--profile', profile, '--port', String(port)], { cwd: directory, env: environment, timeout: 120000 })
    expect(JSON.parse(installed.stdout)).toMatchObject({ installed: true, version: '0.2.1-rc.3' })
    const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')) as unknown[], patch = join(root, 'qualification.json'), shim = join(directory, 'loopback-only.mjs')
    await writeFile(shim, `const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Qualification blocked external fetch');return original(input,{...init,redirect:'error'})};\n`, { mode: 0o600 })
    // This model and policy belong only to this disposable installation. User settings and credentials are never read.
    await writeFile(patch, JSON.stringify([...launch,
      { id: 'llm-pi-ai', config: { providers: { qualification: { displayName: 'Local recovery fixture', api: 'openai-completions', baseURL: provider.url,
        apiKeyEnv: 'EXECUTOR_RECOVERY_FIXTURE_KEY', compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 } },
        timeoutMs: 60000, streamIdleTimeoutMs: 60000, models: [{ id: 'scripted', name: 'Scripted fixture', contextWindow: 131072, maxTokens: 1024, input: ['text'] }] } } } },
      { id: 'agent-default-model', config: model },
      { insert: [{ id: 'executor-recovery-observer', name: pathToFileURL(join(checkout, 'tests/fixtures/executor-recovery-observer.mjs')).href, config: { trace } }] },
    ]), { mode: 0o600 })
    const output = await open(log, 'a', 0o600)
    try { child = spawn(cli, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: directory,
      env: { ...environment, DSH_HOME: join(root, 'home'), EXECUTOR_RECOVERY_FIXTURE_KEY: provider.providerKey, NODE_OPTIONS: `--import=${pathToFileURL(shim).href}` },
      stdio: ['ignore', output.fd, output.fd] }) } finally { await output.close() }
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`Qualification ${path} HTTP ${response.status}`)
      return response.json() as Promise<any>
    }
    await vi.waitFor(async () => { expect(child?.exitCode).toBeNull(); expect((await api('state')).health.runtime.state).toBe('ready') }, { timeout: 40000, interval: 250 })
    const persona = await api('personas', { requestId: randomUUID(), definition: { name: 'Recovery boundary fixture', description: 'Synthetic provider fault qualification',
      instructions: 'Use the configured synthetic provider only. No external services or delegation.', model, capabilities: ['read'], skills: [] } })
    const item = await api('inbox', { requestId: randomUUID(), title: 'Native request retry boundary', persona: { id: persona.id, version: 1 }, text: 'Report the local qualification result.' })
    stage = 'native retries and accepted terminal worker failure'
    let failed: any
    await vi.waitFor(async () => {
      expect(provider.failures).toEqual([]); expect(provider.workerRequests).toHaveLength(3)
      failed = await api(`tickets/${item.id}`)
      expect(failed.assignments).toHaveLength(1)
      expect(failed.assignments[0].report).toMatchObject({ state: 'failed', summary: 'The worker provider request failed; Harness ended this turn.' })
      expect((await api(`inbox/${item.id}`)).item.status).toBe('blocked')
      expect((await events()).filter(event => event.type === 'agent/error')).toHaveLength(1)
    }, { timeout: 25000, interval: 100 })
    const first = await events(), retries = first.filter(event => event.type === 'llm/retry'), starts = first.filter(event => event.type === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(retries.map(event => event.retry)).toEqual([1, 2])
    expect(first.filter(event => event.type === 'llm/retry-started').map(event => event.retry)).toEqual([1, 2])
    expect(new Set(retries.map(event => event.retryId)).size).toBe(1)
    for (const event of retries) expect(event).toMatchObject({ sessionId: `worker-${item.id}`, turn: starts[0]!.turn, step: 1, maxRetries: 2, delayMs: 100 })
    const requests = first.filter(event => event.type === 'agent/request')
    expect(requests).toHaveLength(3)
    for (const event of [...requests, ...first.filter(event => event.type === 'agent/error')])
      expect(event).toMatchObject({ sessionId: `worker-${item.id}`, turn: starts[0]!.turn, step: 1 })
    expect(new Set(provider.workerRequests.map(request => request.sha256)).size).toBe(1)
    const failureAt = Date.now(), assignmentId = failed.assignments[0].id
    stage = 'failed hold beyond the former fifteen-second outer continuation'
    await new Promise(resolve => setTimeout(resolve, 16100))
    expect(Date.now() - failureAt).toBeGreaterThanOrEqual(16000)
    expect(child?.exitCode).toBeNull(); expect(provider.failures).toEqual([]); expect(provider.workerRequests).toHaveLength(3)
    const held = await api(`tickets/${item.id}`), finalEvents = await events()
    expect(held.assignments).toHaveLength(1); expect(held.assignments[0].id).toBe(assignmentId)
    expect(held.assignments[0].report).toEqual(failed.assignments[0].report)
    expect((await api(`inbox/${item.id}`)).item.status).toBe('blocked')
    expect(finalEvents.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(finalEvents.filter(event => event.type === 'agent/error')).toHaveLength(1)
    expect(finalEvents.filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(finalEvents.filter(event => event.type === 'agent/request')).toHaveLength(3)
    expect(JSON.stringify(held)).not.toContain(provider.privateCanary)
    expect(JSON.stringify(held)).not.toContain(provider.providerKey)
  } catch (error) {
    const diagnostics = (await readFile(log, 'utf8').catch(() => '')).replaceAll(provider.privateCanary, '[synthetic body omitted]')
      .replaceAll(provider.providerKey, '[synthetic key omitted]').split('\n').filter(line => !/api.?key|authoriz|credential|token|secret|signing/i.test(line)).slice(-25).join('\n')
    throw new Error(`${stage}: ${String(error)}\nInstalled Harness diagnostics:\n${diagnostics}`, { cause: error })
  } finally { await stop(); await provider.close(); await rm(directory, { recursive: true, force: true }) }
}, 180000)
