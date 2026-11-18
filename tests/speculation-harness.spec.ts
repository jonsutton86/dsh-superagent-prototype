import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'

/** Opt-in real configured API; the synthetic source has no real recipients. */
it.runIf(process.env.DSH_HARNESS_QUALIFICATION === '1')('qualifies speculative preparation, separate publication and restart with installed Harness', async () => {
  const cli = process.env.DSH_QUALIFICATION_CLI!, home = process.env.DSH_QUALIFICATION_HOME!, source = process.env.DSH_QUALIFICATION_PROFILE!
  if (!cli || !home || !source) throw new Error('Supply qualification CLI, home and profile paths')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-speculative-live-')), profile = `speculation-${randomUUID().slice(0, 8)}`, profileDir = join(home, 'profiles', profile)
  let child: ChildProcess | undefined
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>(done => child!.once('exit', () => done())); child.kill('SIGTERM')
    await Promise.race([exited, new Promise<void>(done => { const timer = setTimeout(() => { child?.kill('SIGKILL'); done() }, 10000); timer.unref(); void exited.then(() => clearTimeout(timer)) })])
  }
  try {
    await mkdir(profileDir, { mode: 0o700 })
    for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(source, file), join(profileDir, file))
    await symlink(join(source, 'node_modules'), join(profileDir, 'node_modules'))
    await appendFile(join(profileDir, 'cordis.patch.yml'), '\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n')
    const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done)); const port = (listener.address() as { port: number }).port
    await new Promise<void>(done => listener.close(() => done()))
    const sink = join(directory, 'sink.jsonl'), proof = `prepared-${randomUUID()}`, token = randomUUID(), overlay = join(directory, 'profile.json')
    await writeFile(sink, '')
    await writeFile(overlay, JSON.stringify([{ id: 'webserver', config: { host: '127.0.0.1', port } },
      { id: 'dsh-superagent', config: { stateDir: join(directory, 'coordinator'), executionMode: 'local' } },
      { id: 'session-title-llm', disabled: true }, { id: 'session-persistence-jsonl', config: { root: join(directory, 'sessions'), compression: 'none' } },
      { insert: [{ id: 'qualification-speculation', name: pathToFileURL(resolve('tests/fixtures/speculation-harness.mjs')).href, config: { sink, token, proof } }] }]))
    const start = () => { child = spawn(cli, ['--profile', profile, '--patch', overlay, '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: home }, stdio: 'ignore' }) }
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })
      const value = await response.json() as any
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`)
      return value
    }
    const ready = () => vi.waitFor(async () => { expect(child?.exitCode).toBeNull(); expect((await api('state')).health.runtime.state).toBe('ready') }, { timeout: 40000, interval: 250 })
    start(); await ready()
    const response = await fetch(`http://127.0.0.1:${port}/qualification`, { method: 'POST', headers: { 'x-qualification-token': token }, signal: AbortSignal.timeout(10000) })
    expect(response.status, await response.clone().text()).toBe(200); const decision = await response.json() as any
    expect(decision).toMatchObject({ kind: 'accept', strength: 'inferred' })
    let run: any, ticket: any
    await vi.waitFor(async () => {
      run = (await api('speculation')).items[0]; expect(run).toBeDefined(); run = await api(`speculation/${run.id}`)
      ticket = await api(`tickets/${decision.ticketId}`)
      expect(run, JSON.stringify({ state: run.state, problem: run.problem })).toMatchObject({ state: 'ready', releasedAt: expect.any(String), evidence: expect.any(String) })
    }, { timeout: 120000, interval: 1000 })
    expect(await readFile(join(ticket.directory, 'result.txt'), 'utf8')).toBe(proof)
    expect(run.usage.calls).toBeGreaterThan(0); expect(run.usage.tokens).toBeGreaterThan(0)
    const records = await api('library'); const artifact = records.items.find((item: any) => item.provenance.ticketId === decision.ticketId)
    expect(artifact).toBeDefined(); expect((await api(`library/${artifact.id}`)).content).toBe(proof)
    expect(await readFile(sink, 'utf8')).toBe('')
    const command = { requestId: 'promote-live', revision: run.revision, evidence: run.evidence, command: 'promote', note: 'Read original file, artifact and actual usage receipts' }
    const promoted = await api(`speculation/${run.id}/review`, command)
    expect(promoted.state).toBe('promoted'); expect(await readFile(sink, 'utf8')).toBe('')
    const message = promoted.messages[0]; expect(message).toBeDefined()
    const approval = { requestId: 'send-live', revision: promoted.revision, receiptId: message.id, fingerprint: message.fingerprint, note: 'Reviewed exact synthetic destination and text' }
    await api(`speculation/${run.id}/messages`, approval)
    await vi.waitFor(async () => { expect((await readFile(sink, 'utf8')).trim().split('\n')).toHaveLength(1); expect(JSON.parse(await readFile(sink, 'utf8')).id).toBe(message.id) }, { timeout: 15000, interval: 500 })
    await stop(); start(); await ready()
    const restored = await api(`speculation/${run.id}`)
    expect(restored).toMatchObject({ state: 'promoted', evidence: run.evidence, usage: run.usage })
    await api(`speculation/${run.id}/review`, command); await api(`speculation/${run.id}/messages`, approval)
    expect((await api(`tickets/${decision.ticketId}`)).assignments).toHaveLength(1)
    expect((await readFile(sink, 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally { await stop(); await rm(profileDir, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }) }
}, 240000)
