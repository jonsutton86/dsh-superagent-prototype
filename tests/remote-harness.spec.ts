import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteFixture } from './fixtures/remote.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; vi.restoreAllMocks() })

/** Opt-in qualification against the operator's installed Harness and configured model; never copies or prints credential values. */
it.runIf(process.env.DSH_HARNESS_QUALIFICATION === '1')('runs a real Harness worker on the remote mission profile', async () => {
  const cli = process.env.DSH_QUALIFICATION_CLI!, home = process.env.DSH_QUALIFICATION_HOME!, source = process.env.DSH_QUALIFICATION_PROFILE!
  if (!cli || !home || !source) throw new Error('Supply the qualification CLI, DSH home and source profile paths')
  const native = process.env.DSH_REMOTE_ISOLATION === '1', h = await remoteFixture(cleanup, { native })
  // On macOS this test qualifies Harness composition only. Native confinement is independently mandatory in Linux CI.
  if (!native) vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const profile = `remote-qualification-${randomUUID().slice(0, 8)}`, directory = join(home, 'profiles', profile)
  await mkdir(directory, { mode: 0o700 })
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(source, file), join(directory, file))
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'))
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  const overlay = join(h.directory, 'remote-profile.json'), stateDir = join(h.directory, 'coordinator')
  await writeFile(overlay, JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    { id: 'dsh-superagent', config: { stateDir, executionMode: 'local' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: h.enrolled.grant.root } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access', presets: {
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Endpoint grant', description: 'Execution is bounded by the remote endpoint grant.' },
    } } },
    ...['fs-sandbox', 'subprocess', 'pwsh-sandbox', 'session-title-llm', 'dsh-superagent-worker-preset',
      'dsh-superagent-router-preset', 'preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'].map(id => ({ id, disabled: true })),
    { insert: [
      { id: 'qualification-remote-world', name: 'dsh-superagent/remote-world', config: {
        url: h.url, endpointId: h.endpoint.journal.id, credentialFile: h.client.connection.credentialFile, stateDir: join(h.directory, 'world') } },
    ] },
  ], null, 2), { mode: 0o600 })
  let log = '', child: ChildProcess | undefined
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const process = child
    const exited = new Promise<void>(resolve => process.once('exit', () => resolve()))
    process.kill('SIGINT')
    const timer = setTimeout(() => process.kill('SIGKILL'), 8000)
    try { await exited } finally { clearTimeout(timer) }
  }
  cleanup.push(stop)
  const start = () => {
    child = spawn(cli, ['--profile', profile, '--patch', overlay, '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.on('data', bytes => { log = (log + bytes.toString()).slice(-200_000) })
    child.stderr!.on('data', bytes => { log = (log + bytes.toString()).slice(-200_000) })
  }
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })
    const value = await response.json() as any
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`)
    return value
  }
  const ready = async () => vi.waitFor(async () => {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Harness exited during startup')
    expect((await api('state')).environment.ready).toBe(true)
  }, { timeout: 40_000, interval: 250 })
  try {
    start(); await ready()
    const request = { requestId: 'remote-live-proof', title: 'Remote Harness proof', text: 'In your assigned directory, use bash to create result.txt containing exactly remote-harness-proof (no newline). Read it back, publish that exact content as an artifact with workspace_publish, then report ready. Do not use external services or background work. If any tool fails, immediately report failed with the exact error and end the turn; do not attempt to repair the execution environment.' }
    const task = await api('inbox', request)
    const deadline = Date.now() + 120_000
    for (;;) {
      const view = await api(`inbox/${task.id}`)
      if (view.item.status === 'blocked') throw new Error(`Remote worker blocked: ${view.item.preview}`)
      if (view.item.status === 'review') { expect(view.artifacts).toHaveLength(1); break }
      if (Date.now() > deadline) throw new Error(`Remote worker did not finish: ${view.item.status}`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const ticket = await api(`tickets/${task.id}`), conversation = await api(`inbox/${task.id}`), artifact = await api(`library/${conversation.artifacts[0].id}`)
    expect(ticket.executionEnvironment.world).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(join(ticket.directory, 'result.txt'), 'utf8')).toBe('remote-harness-proof')
    expect(artifact.content).toBe('remote-harness-proof')
    const command = h.endpoint.journal.jobs().find(job => job.request.cwd === ticket.directory && job.request.argv[0] === 'bash'
      && job.request.argv.some(arg => arg.includes('result.txt')) && job.outcome?.exitCode === 0)
    expect(command?.request.owner).toMatchObject({ kind: 'assignment', ticketId: task.id,
      assignmentId: ticket.assignments.at(-1).id, sessionId: ticket.sessionId, tool: 'bash' })
    const receipts = await api(`tickets/${task.id}/execution`)
    expect(receipts.items.find((item: { id: string }) => item.id === command!.id)).toMatchObject({ owner: command!.request.owner, quiescent: true })
    await stop(); start(); await ready()
    expect((await api(`tickets/${task.id}`)).executionEnvironment).toEqual(ticket.executionEnvironment)
    expect((await api('inbox', request)).id).toBe(task.id)
    expect((await api(`tickets/${task.id}`)).assignments).toHaveLength(1)
    expect((await api(`tickets/${task.id}/execution`)).items.find((item: { id: string }) => item.id === command!.id)).toMatchObject({
      owner: command!.request.owner, quiescent: true })
  } catch (error) {
    const redacted = log.split('\n').filter(line => !/api.?key|authorization|secret|credential|token/i.test(line)).slice(-65).join('\n')
    throw new Error(`${String(error)}\nHarness qualification log (sensitive lines omitted):\n${redacted}`)
  }
}, 190_000)
