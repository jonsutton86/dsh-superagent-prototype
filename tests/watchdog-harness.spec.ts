/** Opt-in: two real Harness processes, real configured model, private temporary state and abrupt process restart. */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

it.runIf(process.env.DSH_HARNESS_QUALIFICATION === '1')('keeps independent operator evidence through main and watchdog process failure with a configured model', async () => {
  const cli = process.env.DSH_QUALIFICATION_CLI!, home = process.env.DSH_QUALIFICATION_HOME!, source = process.env.DSH_QUALIFICATION_PROFILE!
  if (!cli || !home || !source) throw new Error('Supply the qualification CLI, home and source profile paths')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-watchdog-live-')), cleanups: (() => Promise<unknown>)[] = []
  const port = async () => {
    const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const result = (listener.address() as { port: number }).port
    await new Promise<void>(resolve => listener.close(() => resolve())); return result
  }
  const mainPort = await port(), watchPort = await port(), mainState = join(directory, 'main'), watchState = join(directory, 'watchdog')
  const profile = async (kind: string, patch: unknown[]) => {
    const name = `watchdog-proof-${kind}-${randomUUID().slice(0, 8)}`, location = join(home, 'profiles', name)
    await mkdir(location, { mode: 0o700 }); cleanups.push(() => rm(location, { recursive: true, force: true }))
    for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(source, file), join(location, file))
    await symlink(join(source, 'node_modules'), join(location, 'node_modules'))
    await appendFile(join(location, 'cordis.patch.yml'), '\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n')
    const overlay = join(location, 'qualification.json')
    await writeFile(overlay, JSON.stringify([...patch, { id: 'session-title-llm', disabled: true },
      { id: 'session-persistence-jsonl', config: { root: join(directory, kind + '-sessions'), compression: 'none' } }]))
    let child: ChildProcess | undefined
    const stop = async (hard = false) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      const original = child, exited = new Promise<void>(resolve => original.once('exit', () => resolve()))
      original.kill(hard ? 'SIGKILL' : 'SIGINT')
      const timer = setTimeout(() => original.kill('SIGKILL'), 8000)
      try { await exited } finally { clearTimeout(timer) }
    }
    cleanups.push(() => stop())
    return { start: () => {
      if (child && child.exitCode === null && child.signalCode === null) throw new Error('Original qualification process is still live')
      child = spawn(cli, ['--profile', name, '--patch', overlay, '--no-open'], {
        cwd: resolve('.'), env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'ignore', 'ignore'] })
    }, stop, alive: () => !!child && child.exitCode === null && child.signalCode === null }
  }
  const api = async (target: 'main' | 'watch', path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${target === 'main' ? mainPort : watchPort}/${target === 'main' ? 'orchestrator' : 'watchdog'}/api/${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`Qualification ${target} ${path} HTTP ${response.status}`)
    return await response.json() as any
  }
  try {
    const main = await profile('main', [{ id: 'webserver', config: { host: '127.0.0.1', port: mainPort } },
      { id: 'dsh-superagent', config: { stateDir: mainState, executionMode: 'local' } },
      { id: 'dsh-superagent-github', disabled: true }, { id: 'dsh-superagent-feishu', disabled: true }])
    const watch = await profile('watch', [{ id: 'webserver', config: { host: '127.0.0.1', port: watchPort } },
      { id: 'dsh-superagent', disabled: true }, { id: 'dsh-superagent-sources', disabled: true },
      { id: 'dsh-superagent-github', disabled: true }, { id: 'dsh-superagent-feishu', disabled: true },
      { insert: [{ id: 'dsh-superagent-watchdog-preset', name: '@deepseek-ai/dsh-agent-preset', config: {
        id: 'dsh-superagent-watchdog', name: 'Independent qualification supervisor', plugins: [] } },
      { id: 'dsh-superagent-watchdog', name: 'dsh-superagent/watchdog', config: {
        stateDir: watchState, tokenFile: join(mainState, 'watchdog.token'), url: `http://127.0.0.1:${mainPort}`,
        pollMs: 1000, staleMs: 60000, reviewEveryMs: 3600000, retryMs: 300000, assessmentTimeoutMs: 90000,
        model: { provider: 'deepseek-official', model: 'deepseek-flash' } } }] }])
    const readyMain = () => vi.waitFor(async () => {
      expect(main.alive()).toBe(true); expect((await api('main', 'state')).health.runtime.state).toBe('ready')
    }, { timeout: 40000, interval: 250 })
    main.start(); await readyMain()
    const item = await api('main', 'inbox', { requestId: 'watchdog-blocked-task', text:
      'Qualification: a human must choose the target platform before this task can proceed. Immediately use orchestrator_report with state blocked, summary "Waiting for the operator to choose a target platform.", and human_action "Choose Linux or macOS." Then end your turn. Do not execute commands, create files, delegate, contact external services, or guess the platform.' })
    await vi.waitFor(async () => expect((await api('main', `inbox/${item.id}`)).item.status).toBe('question'), { timeout: 90000, interval: 500 })
    watch.start()
    let incident: any
    await vi.waitFor(async () => {
      expect(watch.alive()).toBe(true)
      const value = await api('watch', 'status'); expect(value.monitor.reachable).toBe(true)
      incident = value.incidents.find((value: any) => value.observation.id === item.id)
      expect(incident?.assessment?.finding).toBe('blocked'); expect(incident.assessment.evidence.length).toBeGreaterThan(0)
    }, { timeout: 100000, interval: 500 })
    const origin = `http://127.0.0.1:${watchPort}`
    const page = await fetch(origin + '/watchdog'); expect(page.ok).toBe(true)
    const html = await page.text(); expect(html).toContain('/watchdog/ui.js')
    const asset = await fetch(`http://127.0.0.1:${watchPort}/watchdog/ui.js`); expect(asset.ok).toBe(true)
    const js = await asset.text(); expect(js).toContain('Watchdog console'); expect(js).not.toMatch(/from ["'](?:react|react-dom)/)
    // Render the actual served bundle, not a source component; this exercises its standalone entry point and real API calls.
    const dom = new JSDOM(html, { url: origin + '/watchdog', runScripts: 'outside-only' })
    Object.assign(dom.window, { AbortController, AbortSignal, fetch: (path: string, init?: RequestInit) => fetch(new URL(path, origin), init) })
    try {
      dom.window.eval(js)
      await vi.waitFor(() => expect(dom.window.document.querySelector('.wd-list li button')).not.toBeNull(), { timeout: 10000, interval: 50 })
      expect(dom.window.document.querySelector('h1')?.textContent).toBe('Watchdog console')
      ;(dom.window.document.querySelector('.wd-list li button') as HTMLButtonElement).click()
      await vi.waitFor(() => {
        expect(dom.window.document.querySelector('.wd-primary')).not.toBeNull()
        expect((dom.window.document.querySelector('.wd-primary') as HTMLButtonElement).disabled).toBe(false)
        expect(dom.window.document.body.textContent).toContain('Choose Linux or macOS.')
      }, { timeout: 10000, interval: 50 })
      ;(dom.window.document.querySelector('.wd-primary') as HTMLButtonElement).click()
      await vi.waitFor(async () => {
        incident = await api('watch', `incidents/${incident.id}`); expect(incident.acknowledged).toBe(true)
      }, { timeout: 10000, interval: 50 })
    } finally { dom.window.close() }
    const request = { requestId: incident.acknowledgement.requestId, incidentId: incident.id,
      revision: incident.acknowledgement.revision, note: incident.acknowledgement.note }
    const receipt = await api('watch', 'acknowledgements', request)
    await main.stop(true)
    await vi.waitFor(async () => {
      expect(watch.alive()).toBe(true)
      const status = await api('watch', 'status'); expect(status.monitor.reachable).toBe(false)
      expect(status.incidents[0].acknowledged).toBe(true); expect(status.incidents[0].closedAt).toBeUndefined()
    }, { timeout: 20000, interval: 250 })
    expect(await api('watch', 'acknowledgements', request)).toEqual(receipt)
    await watch.stop(true)
    // Both original process handles are terminal. Wait for their existing 30-second locks to expire; never delete a live lock.
    await new Promise(resolve => setTimeout(resolve, 31000))
    watch.start()
    await vi.waitFor(async () => {
      expect(watch.alive()).toBe(true); const status = await api('watch', 'status')
      expect(status.monitor.reachable).toBe(false); expect(status.incidents[0].acknowledged).toBe(true)
    }, { timeout: 40000, interval: 250 })
    expect(await api('watch', 'acknowledgements', request)).toEqual(receipt)
    expect((await api('watch', `history?incident=${incident.id}`)).items.filter((entry: any) => entry.kind === 'acknowledged')).toHaveLength(1)
    main.start(); await readyMain()
    await vi.waitFor(async () => {
      const status = await api('watch', 'status'); expect(status.monitor.reachable).toBe(true)
      expect(status.incidents[0].instance).not.toBe(incident.instance)
      expect(status.incidents[0].acknowledged).toBe(false)
    }, { timeout: 20000, interval: 250 })
    const current = await api('main', `inbox/${item.id}`)
    await api('main', `inbox/${item.id}/reply`, { requestId: 'watchdog-resume-task', revision: current.item.revision,
      text: 'The operator selects Linux. This qualification needs no files or commands. Use orchestrator_report with state ready, summary "Linux selected; review complete.", human_action null, then end your turn.' })
    await vi.waitFor(async () => expect((await api('main', `inbox/${item.id}`)).item.status).toBe('review'), { timeout: 90000, interval: 500 })
    await vi.waitFor(async () => expect((await api('watch', 'status')).counts.open).toBe(0), { timeout: 20000, interval: 250 })
    expect((await api('watch', `incidents/${incident.id}`)).closedAt).toBeTypeOf('number')
    expect((await api('watch', `history?incident=${incident.id}`)).items.some((entry: any) => entry.kind === 'resolved')).toBe(true)
  } finally {
    for (const dispose of cleanups.reverse()) await dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 300000)
