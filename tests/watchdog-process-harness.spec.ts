/** Opt-in installed-process safety qualification. Scripted inference proves runtime contracts, not semantic diagnosis quality. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { watchdogScriptedProvider } from './fixtures/watchdog-scripted-provider.ts'

it.runIf(process.env.DSH_WATCHDOG_PROCESS_QUALIFICATION === '1')('keeps installed supervision observable through provider faults while a real productive worker finishes once', async () => {
  const cli = process.env.DSH_WATCHDOG_QUALIFICATION_CLI ?? process.env.DSH_PUBLICATION_QUALIFICATION_CLI ?? process.env.DSH_ENDPOINT_QUALIFICATION_CLI
  if (!cli) throw new Error('Supply an installed Harness qualification CLI')
  const checkout = resolve('.'), directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh watchdog process ')))
  const cleanups: (() => Promise<unknown>)[] = [], logs: string[] = []
  let stage = 'fresh isolated installation'
  const safeEnvironment = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
  const privateHome = join(directory, 'user-home'); await mkdir(privateHome, { mode: 0o700 })
  const environment = { ...safeEnvironment, HOME: privateHome }
  const port = async () => {
    const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const result = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve())); return result
  }
  const mainPort = await port(), watchPort = await port(), proof = 'productive-watchdog-' + randomUUID()
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
  const command = 'python3 -c ' + quote(`from pathlib import Path\nimport hashlib,time\np=Path('invocations.txt')\np.open('a').write('started\\n')\nf=Path('samples.txt').open('w')\nfor i in range(30):\n f.write(hashlib.sha256(str(i).encode()).hexdigest()+'\\n');f.flush();time.sleep(1)\nPath('proof.txt').write_text(${JSON.stringify(proof)})\nprint('QUALIFICATION_DONE',flush=True)`)
  const provider = await watchdogScriptedProvider(command, proof); cleanups.push(() => provider.close())
  const shim = join(directory, 'loopback-only.mjs')
  await writeFile(shim, `const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Qualification blocked external fetch');return original(input,{...init,redirect:'error'})};\n`, { mode: 0o600 })
  const model = { provider: 'qualification', model: 'scripted' }
  const modelPatch = [{ id: 'llm-pi-ai', config: { providers: { qualification: { displayName: 'Local qualification fixture', api: 'openai-completions',
    baseURL: provider.url, apiKeyEnv: 'WATCHDOG_FIXTURE_KEY', compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    retryPolicy: { mode: 'normal', maxRetries: 0 }, timeoutMs: 60_000, streamIdleTimeoutMs: 60_000,
    models: [{ id: 'scripted', name: 'Scripted fixture', contextWindow: 131072, maxTokens: 1024, input: ['text'] }] } } } },
    { id: 'agent-default-model', config: model }]
  const installation = async (kind: string, port: number, extra: unknown[]) => {
    const root = join(directory, kind), profile = 'watchdog-process-' + kind
    const result = await promisify(execFile)('python3', [join(checkout, 'scripts/agentic-os'), 'init', '--directory', root, '--role', 'workspace',
      '--checkout', checkout, '--dsh', cli, '--profile', profile, '--port', String(port)], { cwd: directory, env: environment, timeout: 120000 })
    expect(JSON.parse(result.stdout)).toMatchObject({ installed: true, version: '0.2.1-rc.3' })
    const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')) as unknown[]
    const patch = join(root, 'qualification.json'), log = join(root, 'qualification.log'); logs.push(log)
    await writeFile(patch, JSON.stringify([...launch, ...modelPatch, ...extra]), { mode: 0o600 })
    let child: ChildProcess | undefined
    const stop = async (hard = false) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const running = child, done = new Promise<void>(resolve => running.once('exit', () => resolve()))
      running.kill(hard ? 'SIGKILL' : 'SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
      try { await done } finally { clearTimeout(timer) }
    }
    cleanups.push(() => stop())
    return { state: join(root, 'state'), stop, alive: () => !!child && child.exitCode === null && child.signalCode === null,
      async start() {
        const output = await open(log, 'a', 0o600)
        try { child = spawn(cli, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: directory,
          env: { ...environment, DSH_HOME: join(root, 'home'), WATCHDOG_FIXTURE_KEY: provider.providerKey, NODE_OPTIONS: `--import=${pathToFileURL(shim).href}` },
          stdio: ['ignore', output.fd, output.fd] }) } finally { await output.close() }
      },
    }
  }
  const api = async (kind: 'main' | 'watch', path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${kind === 'main' ? mainPort : watchPort}/${kind === 'main' ? 'orchestrator' : 'watchdog'}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`Qualification ${kind}/${path} HTTP ${response.status}: ${await response.text()}`)
    return response.json() as Promise<any>
  }
  try {
    const main = await installation('main', mainPort, [])
    const watch = await installation('watch', watchPort, [{ id: 'dsh-superagent', disabled: true }, { id: 'dsh-superagent-sources', disabled: true },
      { insert: [{ id: 'watchdog-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'dsh-superagent-watchdog', name: 'Qualification watchdog', plugins: [] } },
        { id: 'watchdog', name: 'dsh-superagent/watchdog', config: { stateDir: join(directory, 'watch', 'state'), tokenFile: join(main.state, 'watchdog.token'),
          url: `http://127.0.0.1:${mainPort}`, pollMs: 1000, staleMs: 1000, reviewEveryMs: 3600000, retryMs: 5000, assessmentTimeoutMs: 2000, model } }] }])
    await main.start()
    const readyMain = () => vi.waitFor(async () => { expect(main.alive()).toBe(true); expect((await api('main', 'state')).health.runtime.state).toBe('ready') }, { timeout: 40000, interval: 250 })
    await readyMain()
    const persona = await api('main', 'personas', { requestId: randomUUID(), definition: { name: 'Productive process fixture', description: 'Synthetic provider runtime qualification',
      instructions: 'Run the assigned local sampling job once, collect its output, publish its artifact, and report ready. Use no external services.', model, capabilities: ['read', 'write', 'commands'], skills: [] } })
    const startedAt = Date.now()
    const item = await api('main', 'inbox', { requestId: 'watchdog-productive-process', title: 'Deliberately long productive local job', persona: { id: persona.id, version: 1 },
      text: 'Produce the local qualification samples for thirty seconds, write proof.txt, publish its exact content, and report ready. Do not delegate or contact external services.' })
    await vi.waitFor(() => { expect(provider.failures).toEqual([]); expect(provider.calls.filter(call => call.name === 'bash')).toHaveLength(1) }, { timeout: 20000, interval: 100 })
    await watch.start(); stage = 'real provider failure while productive worker remains active'
    await vi.waitFor(async () => {
      expect(watch.alive()).toBe(true); expect(provider.failures).toEqual([])
      const status = await api('watch', 'status'); expect(status.monitor.reachable).toBe(true); expect(status.monitor.modelError).toBeTruthy()
      expect(JSON.stringify(status)).not.toContain(provider.privateCanary); expect(provider.counts().errors).toBe(1)
    }, { timeout: 20000, interval: 100 })
    provider.mode('hang'); stage = 'watchdog deadline during stalled provider stream'
    await vi.waitFor(async () => {
      const status = await api('watch', 'status'); expect(status.monitor.reachable).toBe(true)
      expect(status.monitor.modelError).toContain('timed out'); expect(provider.counts().hangs).toBe(1)
      expect(provider.counts().aborted).toBe(1)
    }, { timeout: 15000, interval: 100 })
    provider.mode('assess'); stage = 'bounded assessment recovery without interrupting productive work'
    let incident: any
    await vi.waitFor(async () => {
      expect(provider.failures).toEqual([]); const status = await api('watch', 'status')
      incident = status.incidents.find((value: any) => value.observation.id === item.id)
      expect(incident?.assessment?.finding).toBe('progressing'); expect(status.monitor.modelError).toBeUndefined()
      expect(incident.intervention).toBeUndefined(); expect(incident.observation.stage).toBe('working')
      expect(incident.observation.execution).toMatchObject({ assignmentId: incident.observation.assignmentId,
        session: { availability: 'available', attribution: 'session', assignmentAttribution: 'unknown' },
        jobs: { availability: 'available', attribution: 'session', assignmentAttribution: 'unknown', lifecycleAttribution: 'unknown' } })
      expect(incident.observation.execution.jobs.counts.running).toBeGreaterThanOrEqual(1)
      expect(incident.observation.execution.assignmentId).toBe((await api('main', `tickets/${item.id}`)).assignments.at(-1).id)
    }, { timeout: 15000, interval: 100 })
    const acknowledgement = { requestId: `wd-${Date.now()}-${randomUUID()}`, incidentId: incident.id, revision: incident.viewRevision, note: 'Reviewed original synthetic runtime evidence.' }
    const receipt = await api('watch', 'acknowledgements', acknowledgement), originalDelivery = incident.delivery.id
    stage = 'real worker output and host-recorded artifact provenance'
    await vi.waitFor(async () => { expect(provider.failures).toEqual([]); expect((await api('main', `inbox/${item.id}`)).item.status).toBe('review') }, { timeout: 50000, interval: 250 })
    const ticket = await api('main', `tickets/${item.id}`), readProof = async () => {
      expect(await readFile(join(ticket.directory, 'proof.txt'), 'utf8')).toBe(proof)
      expect((await readFile(join(ticket.directory, 'invocations.txt'), 'utf8')).trim().split('\n')).toEqual(['started'])
      expect((await readFile(join(ticket.directory, 'samples.txt'), 'utf8')).trim().split('\n'))
        .toEqual(Array.from({ length: 30 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')))
      const library = await api('main', 'library'), artifact = library.items.find((entry: any) => entry.provenance.ticketId === item.id)
      expect(artifact).toBeDefined(); expect((await api('main', `library/${artifact.id}`)).content).toBe(proof)
      expect(artifact.provenance).toMatchObject({ actor: 'worker', trust: 'agent_submission', ticketId: item.id, assignmentId: expect.any(String), sessionId: expect.any(String) })
      expect((await api('main', `tickets/${item.id}`)).assignments).toHaveLength(1)
    }
    await readProof(); expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30000)
    expect(provider.calls.filter(call => call.name === 'bash')).toHaveLength(1)
    expect(provider.calls.some(call => call.name === 'watchdog_request_status')).toBe(false)
    stage = 'abrupt independent process recovery with original acknowledgement receipt'
    await main.stop(true); await watch.stop(true)
    // Production single-writer locks must expire naturally; never delete another process's lock.
    await vi.waitFor(async () => {
      for (const state of [main.state, watch.state]) { const lock = await stat(state + '.lock').catch(() => undefined); if (lock) expect(Date.now() - lock.mtimeMs).toBeGreaterThan(30000) }
    }, { timeout: 35000, interval: 250 })
    await watch.start()
    await vi.waitFor(async () => { expect(watch.alive()).toBe(true); expect((await api('watch', 'status')).monitor.reachable).toBe(false) }, { timeout: 40000, interval: 250 })
    expect(await api('watch', 'acknowledgements', acknowledgement)).toEqual(receipt)
    expect((await api('watch', `incidents/${incident.id}`)).delivery.id).toBe(originalDelivery)
    await main.start(); await readyMain(); await readProof()
    expect(await api('watch', 'acknowledgements', acknowledgement)).toEqual(receipt)
    expect(provider.calls.filter(call => call.name === 'bash')).toHaveLength(1); expect(provider.failures).toEqual([])
  } catch (error) {
    const diagnostics = (await Promise.all(logs.map(path => readFile(path, 'utf8').catch(() => '')))).join('\n')
      .replaceAll(provider.privateCanary, '[synthetic provider body omitted]').replaceAll(provider.providerKey, '[synthetic key omitted]').split('\n')
      .filter(line => !/api.?key|authoriz|credential|token|secret|signing/i.test(line)).slice(-30).join('\n')
    throw new Error(`${stage}: ${String(error)}\nFixture failures: ${provider.failures.join('; ')}\nInstalled Harness diagnostics:\n${diagnostics}`, { cause: error })
  } finally { for (const close of cleanups.reverse()) await close(); await rm(directory, { recursive: true, force: true }) }
}, 240000)
