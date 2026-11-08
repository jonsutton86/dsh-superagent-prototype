import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFile, copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteFixture } from './fixtures/remote.ts'
import { Store } from '../src/app/store.ts'
import { Endpoints } from '../src/environments/endpoints.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; vi.restoreAllMocks() })

/** Opt-in qualification against the operator's installed Harness and configured model; never copies or prints credential values. */
it.runIf(process.env.DSH_HARNESS_QUALIFICATION === '1')('runs a persona-bound real Harness worker on the remote mission profile', async () => {
  const cli = process.env.DSH_QUALIFICATION_CLI!, home = process.env.DSH_QUALIFICATION_HOME!, source = process.env.DSH_QUALIFICATION_PROFILE!
  if (!cli || !home || !source) throw new Error('Supply the qualification CLI, DSH home and source profile paths')
  const native = process.env.DSH_REMOTE_ISOLATION === '1', h = await remoteFixture(cleanup, { native })
  // Synthetic service credential exercises endpoint binding; the operator's inference credential remains on the coordinator.
  const secret = randomUUID(), secretDigest = createHash('sha256').update(secret).digest('hex')
  await writeFile(join(h.endpoint.credentials.imports, 'qualification'), secret, { mode: 0o600 })
  const store = new Store(join(h.directory, 'operator.sqlite')), endpoints = new Endpoints({ store, stateDir: join(h.directory, 'operator'),
    lifetime: new AbortController().signal, workerRoots: () => [] })
  cleanup.push(async () => { await endpoints.stop(); store.close() })
  const registration = await endpoints.register({ requestId: 'qualification-enrollment', endpointId: h.endpoint.journal.id,
    url: h.url, name: 'Qualification endpoint', credentialFile: h.connection.credentialFile, revision: 0 })
  const imported = await endpoints.submit(registration.id, { revision: registration.revision, request: {
    op: 'credential.import', requestId: 'qualification-credential', id: 'qualification', revision: 0,
    variable: 'SERVICE_API_KEY', mode: 'env', file: 'qualification', reason: 'Synthetic qualification credential' } })
  expect(imported.phase).toBe('done')
  const binding = imported.result!.credential!
  const enrollment = await endpoints.submit(registration.id, { revision: registration.revision, request: {
    op: 'grant.create', requestId: 'qualification-grant', owner: 'coordinator', workspace: 'credential-proof',
    operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300_000, credentials: [{ id: binding.id, version: binding.version }] } })
  expect(enrollment.phase).toBe('done')
  const enrolled = { grant: enrollment.result!.grant! }
  // On macOS this test qualifies Harness composition only. Native confinement is independently mandatory in Linux CI.
  if (!native) vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const profile = `remote-qualification-${randomUUID().slice(0, 8)}`, directory = join(home, 'profiles', profile)
  await mkdir(directory, { mode: 0o700 })
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) await copyFile(join(source, file), join(directory, file))
  // Select the qualification model in this temporary base profile. The operator-generated overlay stays byte-for-byte unchanged.
  await appendFile(join(directory, 'cordis.patch.yml'), '\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n')
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'))
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  const generated = await endpoints.profile(registration.id, enrollment.id, { port })
  const overlay = generated.patchFile
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
  const api = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, { method,
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
    const proof = `persona-proof-${randomUUID()}`
    const definition = { name: 'Qualification researcher', description: 'Proves pinned persona instructions and embedded skills',
      instructions: 'Before performing the mission, load your persona evidence skill using the skill tool. Follow its output instructions. Do not guess the proof value.',
      model: { provider: 'deepseek-official', model: 'deepseek-flash' }, capabilities: ['read', 'write', 'commands', 'skills'],
      skills: [{ name: 'evidence', description: 'Required proof instructions for this qualification mission', content: `After verifying the service credential, result.txt and the published artifact must contain exactly ${proof} with no newline. Do not put the credential in any output.` }] }
    const persona = await api('personas', { requestId: 'persona-proof-create', definition })
    let mission = await api('missions', { requestId: 'remote-live-mission', title: 'Remote Harness proof', objective: 'Prove persona-bound execution', acceptance: 'The artifact follows the persona skill and the service credential check passes' })
    mission = await api(`missions/${mission.id}/actions`, { requestId: 'remote-live-action', revision: mission.revision, title: 'Produce proof', owner: 'agent',
      persona: { id: persona.id, version: 1 }, instructions: `In your assigned directory, use bash to verify that the SHA256 of the endpoint-provided SERVICE_API_KEY equals ${secretDigest}, without printing the credential itself. Only after that check succeeds, create result.txt following your persona instructions. Read it back, publish that exact content as an artifact with workspace_publish, then report ready. Do not use external services or background work. If any tool fails, immediately report failed with the exact error and end the turn; do not attempt to repair the execution environment.` })
    const request = { requestId: 'remote-live-proof', revision: mission.revision, command: 'run' }
    const runPath = `missions/${mission.id}/actions/${mission.actions[0].id}`
    const running = await api(runPath, request), task = { id: running.actions[0].runs[0] }
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
    expect(ticket.executionPersona).toMatchObject({ id: persona.id, version: 1, digest: persona.digest, definition })
    expect(await readFile(join(ticket.directory, 'result.txt'), 'utf8')).toBe(proof)
    expect(artifact.content).toBe(proof)
    const command = h.endpoint.journal.jobs().find(job => job.request.cwd === ticket.directory && job.request.argv[0] === 'bash'
      && job.request.argv.some(arg => arg.includes('result.txt')) && job.outcome?.exitCode === 0)
    expect(command?.request.owner).toMatchObject({ kind: 'assignment', ticketId: task.id,
      assignmentId: ticket.assignments.at(-1).id, sessionId: ticket.sessionId, tool: 'bash' })
    expect(command?.credentials).toEqual(enrolled.grant.credentials)
    expect(h.endpoint.journal.jobs().some(job => job.request.cwd === ticket.directory
      && job.request.argv.some(arg => arg.includes('SERVICE_API_KEY')) && job.outcome?.exitCode === 0)).toBe(true)
    expect(JSON.stringify(h.endpoint.journal.jobs())).not.toContain(secret)
    const receipts = await api(`tickets/${task.id}/execution`)
    expect(receipts.items.find((item: { id: string }) => item.id === command!.id)).toMatchObject({ owner: command!.request.owner, quiescent: true })
    const updated = await api(`personas/${persona.id}`, { requestId: 'persona-proof-update', revision: 1,
      definition: { ...definition, instructions: 'A future run uses this version.' } }, 'PUT')
    await api(`personas/${persona.id}/archive`, { requestId: 'persona-proof-archive', revision: updated.revision, archived: true, reason: 'Qualification finished; preserve original execution' })
    await stop(); start(); await ready()
    expect((await api(`tickets/${task.id}`)).executionEnvironment).toEqual(ticket.executionEnvironment)
    expect((await api(`tickets/${task.id}`)).executionPersona).toEqual(ticket.executionPersona)
    expect((await api(runPath, request)).actions[0].runs).toEqual([task.id])
    expect((await api(`tickets/${task.id}`)).assignments).toHaveLength(1)
    expect((await api(`tickets/${task.id}/execution`)).items.find((item: { id: string }) => item.id === command!.id)).toMatchObject({
      owner: command!.request.owner, quiescent: true })
  } catch (error) {
    const redacted = log.split('\n').filter(line => !/api.?key|authorization|secret|credential|token/i.test(line)).slice(-65).join('\n')
    throw new Error(`${String(error)}\nHarness qualification log (sensitive lines omitted):\n${redacted}`)
  }
}, 190_000)
