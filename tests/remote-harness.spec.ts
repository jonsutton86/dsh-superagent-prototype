import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFile, copyFile, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteFixture } from './fixtures/remote.ts'
import { qualifyRecovery } from './fixtures/recovery.ts'
import { qualifyOwnership } from './fixtures/ownership.ts'
import { Store } from '../src/app/store.ts'
import { Endpoints } from '../src/environments/endpoints.ts'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { RemoteClient } from '../src/remote/client.ts'
import { publicationFixture } from './fixtures/publication.ts'
import { worldBinding } from '../src/remote/world-journal.ts'
import { qualifyPublication } from './fixtures/publication-harness.ts'
import { qualifySchedules } from './fixtures/schedules.ts'
import type { RemoteJob } from '../src/remote/protocol.ts'
import { HostProcessIsolation } from '../src/verification/local.ts'
import type { CheckRun } from '../src/verification/contracts.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; vi.restoreAllMocks() })

/** Opt-in qualification against the operator's installed Harness and configured model; never copies or prints credential values. */
it.runIf(process.env.DSH_HARNESS_QUALIFICATION === '1').each(['dedicated', 'managed', 'owned-dedicated', 'owned-managed'] as const)('runs persona-bound real Harness work through %s execution worlds', async variant => {
  const owned = variant.startsWith('owned-'), mode = variant.endsWith('dedicated') ? 'dedicated' : 'managed'
  const cli = process.env.DSH_QUALIFICATION_CLI!, home = process.env.DSH_QUALIFICATION_HOME!, source = process.env.DSH_QUALIFICATION_PROFILE!
  if (!cli || !home || !source) throw new Error('Supply the qualification CLI, DSH home and source profile paths')
  const authority = owned ? await ownershipAuthority(cleanup, ['endpoint', 'publication']) : undefined
  const publisher = authority ? await publicationFixture(cleanup, authority.resourceFor('publication')) : undefined
  if (publisher) await publisher.restart([...publisher.config.destinations, { id: 'checked-pr', name: 'Checked PR review', kind: 'github-pr-review',
    repository: 'acme/project', issue: 7, login: 'agent-bot', event: 'APPROVE', maxBytes: 30_000, credentialFile: publisher.destination.credentialFile }])
  const ownershipConfig = authority && { ...authority.config, leaseMs: 10_000, prepareTimeoutMs: 30_000 }
  const bootstrap = ownershipConfig && new CoordinatorOwnership(ownershipConfig)
  if (bootstrap) cleanup.push(() => bootstrap.close())
  const native = process.env.DSH_REMOTE_ISOLATION === '1', h = await remoteFixture(cleanup, { native,
    ownership: authority?.resource, access: bootstrap, beforeEnroll: async () => { await bootstrap?.start() } })
  const stale = bootstrap && new RemoteClient({ ...h.connection, ownership: {
    authorityId: bootstrap.authorityId, coordinatorId: bootstrap.coordinatorId, proof: (() => { const proof = bootstrap.proof(); return () => proof })() } })
  // Synthetic service credential exercises endpoint binding; the operator's inference credential remains on the coordinator.
  const secret = randomUUID(), secretDigest = createHash('sha256').update(secret).digest('hex')
  await writeFile(join(h.endpoint.credentials.imports, 'qualification'), secret, { mode: 0o600 })
  const store = new Store(join(h.directory, 'operator.sqlite')), endpoints = new Endpoints({ store, stateDir: join(h.directory, 'operator'),
    lifetime: new AbortController().signal, workerRoots: () => [], ownership: bootstrap, ownershipConfig, publicationConfig: publisher?.connection })
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
  const routerProbeToken = randomUUID()
  await appendFile(join(directory, 'cordis.patch.yml'), '\n- insert: ' + JSON.stringify([{ id: 'qualification-router',
    name: pathToFileURL(resolve('tests/fixtures/router-harness.mjs')).href,
    config: { token: routerProbeToken, canary: join(h.directory, 'router-execution-canary') } }]) + '\n')
  const sessionRoot = join(h.directory, 'sessions')
  await appendFile(join(directory, 'cordis.patch.yml'), '\n- id: session-persistence-jsonl\n  config:\n    root: ' + JSON.stringify(sessionRoot) + '\n    compression: none\n')
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'))
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  let overlay: string
  if (mode === 'dedicated') overlay = (await endpoints.profile(registration.id, enrollment.id, { port })).patchFile
  else {
    overlay = join(directory, 'managed-worlds.json')
    await writeFile(overlay, JSON.stringify([{ id: 'webserver', config: { host: '127.0.0.1', port } },
      { id: 'dsh-superagent', config: { stateDir: join(h.directory, 'coordinator'), executionMode: 'local', ...(ownershipConfig ? { ownership: ownershipConfig } : {}),
        ...(publisher ? { publication: publisher.connection } : {}) } },
      { id: 'session-title-llm', disabled: true }]))
  }
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
    if (!response.ok) throw new Error(`HTTP ${response.status} at ${method} ${path}: ${JSON.stringify(value)}`)
    return value
  }
  const ready = async (environment = true) => vi.waitFor(async () => {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Harness exited during startup')
    const state = await api('state')
    expect(state.environment.ready).toBe(environment)
    expect(state.health.runtime.state, state.health.runtime.detail).toBe('ready')
    if (owned) expect(state.ownership.phase).toBe('active')
  }, { timeout: 40_000, interval: 250 })
  const qualifyRouter = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/qualification-router`, { method: 'POST',
      headers: { 'x-qualification-token': routerProbeToken }, signal: AbortSignal.timeout(10000) })
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ denied: true, contextRead: true, canary: false })
  }
  try {
    await bootstrap?.close()
    start(); await ready(!(owned && mode === 'managed'))
    await qualifyRouter()
    if (stale) await expect(stale.call({ op: 'grant.create', requestId: 'stale-bootstrap', owner: 'coordinator', workspace: 'must-not-exist',
      operations: ['fs.read', 'process.spawn'], leaseMs: 300_000 })).rejects.toThrow()
    let managed: any, alternate: any
    if (mode === 'managed') {
      await api('endpoints', { requestId: 'managed-enrollment', endpointId: h.endpoint.journal.id, url: h.url,
        credentialFile: h.connection.credentialFile, revision: 0, name: 'Managed endpoint' })
      for (const [workspace, credentials] of [['managed-a', [{ id: binding.id, version: binding.version }]], ['managed-b', []]] as const) {
        const command = await api(`endpoints/${h.endpoint.journal.id}/commands`, { revision: 1, request: { op: 'grant.create', requestId: workspace,
          owner: 'coordinator', workspace, operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300_000, credentials } })
        expect(command.phase).toBe('done')
        const activated = await api('worlds', { requestId: `activate-${workspace}`, endpointId: h.endpoint.journal.id, commandId: command.id, name: workspace })
        expect(activated.ready, activated.problem).toBe(true)
        if (workspace === 'managed-a') { managed = activated; enrolled.grant = command.result.grant }
        else alternate = activated
      }
      await stop(); start(); await ready()
      for (const value of (await api('worlds')).items) expect(value.ready, value.problem ?? 'World did not prepare after restart').toBe(true)
    }
    const proof = `persona-proof-${randomUUID()}`, otherProof = `independent-${randomUUID()}`
    const definition = { name: 'Qualification researcher', description: 'Proves pinned persona instructions and embedded skills',
      instructions: 'Before performing the mission, load your persona evidence skill using the skill tool. Follow its output instructions. Do not guess the proof value.',
      model: { provider: 'deepseek-official', model: 'deepseek-flash' }, capabilities: ['read', 'write', 'commands', 'skills'],
      skills: [{ name: 'evidence', description: 'Required proof instructions for this qualification mission', content: `After verifying the service credential, result.txt and the published artifact must contain exactly ${proof} with no newline. Do not put the credential in any output.` }] }
    const persona = await api('personas', { requestId: 'persona-proof-create', definition })
    let mission = await api('missions', { requestId: 'remote-live-mission', title: 'Remote Harness proof', objective: 'Prove persona-bound execution', acceptance: 'The artifact follows the persona skill and the service credential check passes' })
    mission = await api(`missions/${mission.id}/actions`, { requestId: 'remote-live-action', revision: mission.revision, title: 'Produce proof', owner: 'agent',
      persona: { id: persona.id, version: 1 }, ...(managed ? { environment: managed.id } : {}), instructions: `${publisher ? 'First use orchestrator_ack with the original trigger_id from your assignment and the exact text "Mission delivery qualification started." The host supplied publication Channel is explicitly authorized. ' : ''}In your assigned directory, use bash to verify that the SHA256 of the endpoint-provided SERVICE_API_KEY equals ${secretDigest}, without printing the credential itself. Only after that check succeeds, create result.txt following your persona instructions. Read it back, publish that exact content as an artifact with workspace_publish, then report ready. Do not use external services or background work. If any tool fails, immediately report failed with the exact error and end the turn; do not attempt to repair the execution environment.` })
    if (alternate) mission = await api(`missions/${mission.id}/actions`, { requestId: 'other-action', revision: mission.revision, title: 'Independent proof', owner: 'agent', environment: alternate.id,
      instructions: `Delegate this check to exactly one subagent using the subagent tool: in your assigned working directory, use one bash call to confirm SERVICE_API_KEY is unset or empty without printing it, then write exactly ${otherProof} to result.txt with no newline and return a brief completion message. Wait for the child to finish, read result.txt yourself, publish that exact content with workspace_publish and report ready. This is a small qualification: do not add todo lists, extra checks or other work. No external services; report failed immediately if a tool fails.` })
    if (publisher) {
      const target = (await api('publication/destinations')).items.find((item: { id: string }) => item.id === 'checked-pr')
      const pull = await api(`publication/destinations/${target.id}/pull?hash=${target.hash}`)
      mission = await api(`missions/${mission.id}/actions/${mission.actions[0].id}/pull`, { requestId: randomUUID(), revision: mission.revision, enabled: true,
        destination: target.id, destinationHash: target.hash, pullHash: pull.hash }, 'PUT')
      const destination = (await api('publication/destinations')).items[0]
      await api(`missions/${mission.id}/delivery`, { requestId: randomUUID(), revision: 0, missionRevision: mission.revision,
        enabled: true, destination: destination.id, destinationHash: destination.hash }, 'PUT')
    }
    const request = { requestId: 'remote-live-proof', revision: mission.revision, command: 'run' }
    const runPath = `missions/${mission.id}/actions/${mission.actions[0].id}`
    const running = await api(runPath, request), task = { id: running.actions[0].runs[0] }
    let otherTask: string | undefined
    if (alternate) {
      let next = await api(`missions/${mission.id}`)
      const other = next.actions.at(-1)
      next = await api(`missions/${mission.id}/actions/${other.id}`, { requestId: 'other-run', revision: next.revision, command: 'run' })
      otherTask = next.actions.at(-1).runs[0]
    }
    const deadline = Date.now() + 120_000
    for (;;) {
      const view = await api(`inbox/${task.id}`)
      if (view.item.status === 'blocked') throw new Error(`Remote worker blocked: ${view.item.preview}`)
      if (view.item.status === 'review') { expect(view.artifacts.length).toBeGreaterThan(0); break }
      if (Date.now() > deadline) throw new Error(`Remote worker did not finish: ${view.item.status}`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const ticket = await api(`tickets/${task.id}`), conversation = await api(`inbox/${task.id}`)
    // Inbox includes mission-wide evidence, so concurrent actions may publish before this read. Match trusted task provenance.
    const artifacts = await Promise.all(conversation.artifacts.map((item: { id: string }) => api(`library/${item.id}`)))
    const artifact = artifacts.find(item => item.provenance.ticketId === task.id && item.content === proof)
    expect(ticket.executionEnvironment.world).toMatch(/^[a-f0-9]{64}$/)
    if (managed) expect(ticket.executionEnvironment.world).toBe(managed.id)
    expect(ticket.executionPersona).toMatchObject({ id: persona.id, version: 1, digest: persona.digest, definition })
    expect(await readFile(join(ticket.directory, 'result.txt'), 'utf8')).toBe(proof)
    expect(artifact?.content).toBe(proof)
    if (otherTask) await vi.waitFor(async () => expect((await api(`inbox/${otherTask}`)).item.status).toBe('review'), { timeout: 120_000, interval: 1000 })
    const inCheckWorld = async <T>(operation: () => Promise<T>): Promise<T> => {
      // Use the actual coordinator API, original artifact binding and production verification runner. Non-Linux
      // qualification explicitly selects the real host-process implementation; native CI supplies Linux confinement.
      h.host.snapshotHelper = resolve('lib/verification-snapshot-worker.js')
      const previousIsolation = h.host.isolation
      if (!native) h.host.isolation = new HostProcessIsolation()
      try { return await operation() } finally { h.host.isolation = previousIsolation }
    }
    if (publisher) {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: ticket.directory, encoding: 'utf8' }).trim()
      git('init', '-q'); git('add', '--', 'result.txt')
      git('-c', 'user.name=Qualification', '-c', 'user.email=qualification@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Live verified artifact')
      publisher.pull.head.sha = git('rev-parse', 'HEAD'); publisher.tree(git('rev-parse', 'HEAD^{tree}'))
    }
    const verification = await inCheckWorld(async () => {
        const check = await api('checks', { requestId: randomUUID(), enabled: true, definition: { name: 'Live artifact proof', description: 'Check exact bytes without service credentials',
          argv: ['/bin/sh', '-c', 'test "$(cat result.txt)" = "$1" && test -z "${SERVICE_API_KEY:-}" && printf verified', 'check', proof],
          artifactPath: 'result.txt', confinement: native ? 'linux-bubblewrap' : 'host-process' } })
        const request = { requestId: randomUUID(), check: { id: check.id, version: check.version }, artifactRevision: artifact.revision, artifactHash: artifact.hash }
        await api(`library/${artifact.id}/verification`, request)
        let result!: CheckRun
        await vi.waitFor(async () => { result = await api(`verification/${request.requestId}/refresh`, {}); expect(result.quiescent).toBe(true) }, { timeout: 10000 })
        expect(result, result.problem).toMatchObject({ status: 'passed', outcome: { exitCode: 0 }, owner: { kind: 'assignment', assignmentId: artifact.provenance.assignmentId },
          evidence: { kind: 'check', stage: 'finished', confinement: native ? 'linux-bubblewrap' : 'host-process', artifactHash: artifact.hash,
            snapshotUnchanged: true, storageReleased: true, output: { stdout: { bytes: 8 } } } })
        expect(result.evidence!.snapshot!.source).toBe(ticket.directory)
        const captured = await api(`verification/${result.id}/freshness`, { requestId: randomUUID() }); let capture!: CheckRun
        await vi.waitFor(async () => { capture = await api(`verification/${captured.id}/refresh`, {}); expect(capture.quiescent).toBe(true) }, { timeout: 10000 })
        expect(capture).toMatchObject({ status: 'captured', sourceCheckId: result.id, evidence: { kind: 'capture', snapshot: { hash: result.evidence!.snapshot!.hash } } })
        expect(capture.outcome).toBeUndefined()
        const raw = h.endpoint.journal.job(result.id) as RemoteJob; expect(raw.credentials).toBeUndefined()
        const choices = await api(`library/${artifact.id}/review-checks`)
        const selection = choices.items.find((item: any) => item.run.id === result.id).binding.selection
        const current = await api(`missions/${mission.id}`), action = current.actions[0]
        const pull = publisher ? await api(`${runPath}/pull/inspect`, {}) : undefined
        const accepted = await api(runPath, { requestId: randomUUID(), revision: current.revision, command: 'complete',
          ticketRevision: action.ticket.revision, text: 'Reviewed actual host-checked result bytes', reviewKind: 'checks', checks: [selection], ...(pull ? { pullHash: pull.hash } : {}) })
        expect(accepted.actions[0]).toMatchObject({ status: 'done', accepted: { basis: 'checks', evidence: [{ selection }] } })
        if (pull) expect(accepted.actions[0].accepted.pull.observation).toMatchObject({ hash: pull.hash, binding: pull.binding })
        return { request, result, capture, artifactId: artifact.id, selection, acceptance: accepted.actions[0].accepted }
    })
    if (otherTask) await inCheckWorld(async () => {
      const conversation = await api(`inbox/${otherTask}`), records = await Promise.all(conversation.artifacts.map((item: { id: string }) => api(`library/${item.id}`)))
      const artifact = records.find((item: any) => item.provenance.ticketId === otherTask && item.content === otherProof)
      expect(artifact).toBeTruthy()
      const check = await api('checks', { requestId: randomUUID(), enabled: true, definition: { name: 'Independent live result', description: 'Check the other mission output',
        argv: ['/bin/sh', '-c', 'test "$(cat result.txt)" = "$1"', 'check', otherProof], artifactPath: 'result.txt', confinement: native ? 'linux-bubblewrap' : 'host-process' } })
      const run = await api(`library/${artifact.id}/verification`, { requestId: randomUUID(), artifactRevision: artifact.revision, artifactHash: artifact.hash, check: { id: check.id, version: check.version } })
      await vi.waitFor(async () => expect((await api(`verification/${run.id}/refresh`, {})).status).toBe('passed'), { timeout: 10000 })
      const choices = await api(`library/${artifact.id}/review-checks`), selection = choices.items.find((item: any) => item.run.id === run.id).binding.selection
      const current = await api(`missions/${mission.id}`), action = current.actions.find((item: any) => item.ticket?.id === otherTask)
      await api(`missions/${mission.id}/actions/${action.id}`, { requestId: randomUUID(), revision: current.revision, command: 'complete', ticketRevision: action.ticket.revision,
        text: 'Reviewed the independent real output', reviewKind: 'checks', checks: [selection] })
    })
    const missionCompletionId = randomUUID()
    const finishedMission = await inCheckWorld(async () => {
      const current = await api(`missions/${mission.id}`)
      return api(`missions/${mission.id}`, { requestId: missionCompletionId, revision: current.revision, status: 'completed' }, 'PUT')
    })
    expect(finishedMission.status).toBe('completed'); expect(finishedMission.completion.actions).toHaveLength(otherTask ? 2 : 1)
    expect(finishedMission.completion.actions.every((item: any) => item.checks > 0 && /^[a-f0-9]{64}$/.test(item.evidenceHash))).toBe(true)
    await api(`missions/${mission.id}`, { requestId: randomUUID(), revision: finishedMission.revision, status: 'active' }, 'PUT')
    let publicationId: string | undefined, channelDelivery: any, inboundRecord: any, inboundDelivery: any
    if (publisher) {
      const deliveries = await api(`missions/${mission.id}/delivery`)
      channelDelivery = deliveries.items.find((item: any) => item.ticketId === task.id && publisher.comments.some(comment =>
        comment.body.startsWith('Mission delivery qualification started.\n') && comment.body.includes(`dsh-publication:${item.id}:`)))
      expect(channelDelivery?.receipt).toMatchObject({ phase: 'sent', message: { missionId: mission.id, ticketId: task.id } })
      const destination = (await api('publication/destinations')).items[0]
      publicationId = randomUUID()
      publisher.loseProviderReply(publicationId)
      const delivery = await inCheckWorld(() => api(`library/${artifact.id}/publications`, { requestId: publicationId, revision: artifact.revision, hash: artifact.hash,
        destination: destination.id, destinationHash: destination.hash, checks: [verification.selection] }))
      expect(delivery.verification.evidence[0].selection).toEqual(verification.selection)
      expect(delivery.receipt.phase).toBe('unknown')
      expect((await api(`publications/${publicationId}/refresh`, {})).receipt).toMatchObject({ phase: 'sent', hash: artifact.hash })
      expect(publisher.comments.filter(comment => comment.body.includes(`dsh-publication:${publicationId}:`))).toHaveLength(1)
      const pr = (await api('publication/destinations')).items.find((item: { id: string }) => item.id === 'checked-pr')
      const pull = await api(`publication/destinations/${pr.id}/pull?hash=${pr.hash}`), reviewId = randomUUID()
      publisher.loseProviderReply(reviewId)
      const review = await inCheckWorld(() => api(`library/${artifact.id}/publications`, { requestId: reviewId, revision: artifact.revision, hash: artifact.hash,
        destination: pr.id, destinationHash: pr.hash, checks: [verification.selection], pullHash: pull.hash }))
      expect(review.receipt.phase).toBe('unknown')
      expect((await api(`publications/${reviewId}/refresh`, {})).receipt).toMatchObject({ phase: 'sent', pull: pull.binding,
        external: { review: { state: 'APPROVED', commit: pull.binding.head.sha } } })
      expect(publisher.reviews.filter(item => item.body.includes(`dsh-publication:${reviewId}:`))).toHaveLength(1)
    }
    const command = h.endpoint.journal.jobs().find(job => job.request.cwd === ticket.directory && job.request.argv[0] === 'bash'
      && job.request.argv.some(arg => arg.includes('result.txt')) && job.outcome?.exitCode === 0)
    expect(command?.request.owner).toMatchObject({ kind: 'assignment', ticketId: task.id,
      assignmentId: ticket.assignments.at(-1).id, sessionId: ticket.sessionId, tool: 'bash' })
    expect(command?.credentials).toEqual(enrolled.grant.credentials)
    if (owned) expect(command?.ownership).toEqual((await api('state')).ownership.owner)
    expect(h.endpoint.journal.jobs().some(job => job.request.cwd === ticket.directory
      && job.request.argv.some(arg => arg.includes('SERVICE_API_KEY')) && job.outcome?.exitCode === 0), 'credential check receipt').toBe(true)
    expect(JSON.stringify(h.endpoint.journal.jobs())).not.toContain(secret)
    const receipts = await api(`tickets/${task.id}/execution`)
    expect(receipts.items.find((item: { id: string }) => item.id === command!.id)).toMatchObject({ owner: command!.request.owner, quiescent: true })
    if (publisher) {
      const delivery = await api(`missions/${mission.id}/delivery`)
      const listener = await api(`missions/${mission.id}/inbound`, { requestId: randomUUID(), revision: 0, enabled: true,
        grantId: delivery.grant.id, ticketId: task.id, senders: ['alice'] }, 'PUT')
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(listener.binding.startsAt)), { timeout: 1500, interval: 25 })
      publisher.receive('alice', 'First acknowledge this incoming conversation trigger with orchestrator_ack and exactly "Inbound reply qualification received." Then use bash to read result.txt and confirm it still matches the original artifact. Leave the file unchanged and report ready. Do not create other work or call external services.')
      const incoming = await api(`missions/${mission.id}/inbound/poll`, {})
      expect(incoming.binding.problem).toBeUndefined(); expect(incoming.items).toHaveLength(1); inboundRecord = incoming.items[0]
      await vi.waitFor(async () => {
        expect((await api(`tickets/${task.id}`)).assignments).toHaveLength(2)
        expect((await api(`inbox/${task.id}`)).item.status).toBe('review')
        inboundDelivery = (await api(`missions/${mission.id}/delivery`)).items.find((item: any) => publisher.comments.some(comment =>
          comment.body.startsWith('Inbound reply qualification received.\n') && comment.body.includes(`dsh-publication:${item.id}:`)))
        expect(inboundDelivery?.receipt.phase).toBe('sent')
      }, { timeout: 120_000, interval: 1000 })
      expect(await readFile(join(ticket.directory, 'result.txt'), 'utf8')).toBe(proof)
      expect((await api(`missions/${mission.id}/inbound/poll`, { rescan: true })).items).toEqual([inboundRecord])
    }
    if (otherTask) {
      expect((await api(`inbox/${otherTask}`)).item.status).toBe('done')
      const other = await api(`tickets/${otherTask}`)
      expect(other.executionEnvironment.world).toBe(alternate.id)
      expect(other.directory).not.toBe(ticket.directory)
      expect(await readFile(join(other.directory, 'result.txt'), 'utf8')).toBe(otherProof)
      const evidence = await api(`inbox/${otherTask}`)
      const published = await Promise.all(evidence.artifacts.map((item: { id: string }) => api(`library/${item.id}`)))
      expect(published.some(item => item.provenance.ticketId === otherTask && item.content === otherProof)).toBe(true)
      expect(h.endpoint.journal.jobs().some(job => job.request.owner?.kind === 'assignment' && job.request.owner.ticketId === otherTask
        && job.request.owner.sessionId !== other.sessionId && job.request.owner.tool === 'bash' && job.outcome?.exitCode === 0), 'delegated child command receipt').toBe(true)
      const revoked = await api(`worlds/${managed.id}/revoke`, { requestId: 'revoke-managed-a', revision: managed.revision, reason: 'Independent world lifecycle qualification' })
      expect(revoked.status.revocation).toMatchObject({ acknowledged: true, quiescent: true })
      const available = (await api('worlds')).items.find((item: any) => item.id === alternate.id)
      expect(available.ready, available.problem).toBe(true)
    }
    const updated = await api(`personas/${persona.id}`, { requestId: 'persona-proof-update', revision: 1,
      definition: { ...definition, instructions: 'A future run uses this version.' } }, 'PUT')
    await api(`personas/${persona.id}/archive`, { requestId: 'persona-proof-archive', revision: updated.revision, archived: true, reason: 'Qualification finished; preserve original execution' })
    const oldOwner = owned && (await api('state')).ownership.owner
    await stop(); start(); await ready()
    await qualifyRouter()
    if (owned) {
      const nextOwner = (await api('state')).ownership.owner
      expect(nextOwner.epoch).toBeGreaterThan(oldOwner.epoch)
      expect(nextOwner.instanceId).not.toBe(oldOwner.instanceId)
    }
    if (publisher && publicationId) {
      expect((await api(`missions/${mission.id}/completions`)).items.find((item: any) => item.id === missionCompletionId)?.status).toBe('completed')
      expect((await api(`library/${artifact.id}/publications`)).items[0].receipt).toMatchObject({ phase: 'sent', hash: artifact.hash })
      expect((await api(`publications/${publicationId}/retry`, {})).receipt.phase).toBe('sent')
      expect(publisher.comments.filter(comment => comment.body.includes(`dsh-publication:${publicationId}:`))).toHaveLength(1)
      expect((await api(`missions/${mission.id}/delivery`)).items.find((item: any) => item.id === channelDelivery.id).receipt).toEqual(channelDelivery.receipt)
      expect((await api(`deliveries/${channelDelivery.id}/refresh`, {})).receipt).toEqual(channelDelivery.receipt)
      expect(publisher.comments.filter(comment => comment.body.includes(`dsh-publication:${channelDelivery.id}:`))).toHaveLength(1)
      expect((await api(`missions/${mission.id}/inbound`)).items).toEqual([inboundRecord])
      expect((await api(`missions/${mission.id}/inbound/poll`, { rescan: true })).items).toEqual([inboundRecord])
      expect((await api(`deliveries/${inboundDelivery.id}/refresh`, {})).receipt).toEqual(inboundDelivery.receipt)
    }
    expect((await api(`tickets/${task.id}`)).executionEnvironment).toEqual(ticket.executionEnvironment)
    expect((await api(`tickets/${task.id}`)).executionPersona).toEqual(ticket.executionPersona)
    if (verification) {
      expect(await api(`library/${verification.artifactId}/verification`, verification.request)).toEqual(verification.result)
      expect(await api(`verification/${verification.capture.id}`)).toEqual(verification.capture)
      expect((await api(`verification/${verification.result.id}/refresh`, {})).evidence).toEqual(verification.result.evidence)
      expect(h.endpoint.journal.jobs().filter(job => [verification.result.id, verification.capture.id].includes(job.id))).toHaveLength(2)
      if (!publisher && mode === 'dedicated') expect((await api(`missions/${mission.id}`)).actions[0])
        .toMatchObject({ status: 'done', accepted: verification.acceptance })
    }
    expect((await api(runPath, request)).actions[0].runs).toEqual([task.id])
    expect((await api(`tickets/${task.id}`)).assignments).toHaveLength(publisher ? 2 : 1)
    expect((await api(`tickets/${task.id}/execution`)).items.find((item: { id: string }) => item.id === command!.id)).toMatchObject({
      owner: command!.request.owner, quiescent: true, ...(owned ? { ownership: command!.ownership } : {}) })
    if (otherTask) {
      expect((await api('worlds')).items.find((item: any) => item.id === alternate.id).ready).toBe(true)
      expect((await api('worlds')).items.find((item: any) => item.id === managed.id)).toMatchObject({ enabled: false, ready: false })
      expect((await api(`tickets/${otherTask}`)).executionEnvironment.world).toBe(alternate.id)
      const current = await api(`missions/${mission.id}`), action = current.actions.at(-1)
      await api(`missions/${mission.id}/actions/${action.id}`, { requestId: 'resume-other-world', revision: current.revision, command: 'steer',
        text: `Read result.txt and verify it contains exactly ${otherProof}. Then use bash to replace it with exactly ${otherProof}-resumed, with no newline, publish that exact content as a new artifact, and report ready. Report failed immediately if a tool fails.` })
      await vi.waitFor(async () => {
        const resumed = await api(`tickets/${otherTask}`)
        expect(resumed.assignments).toHaveLength(2)
        expect((await api(`inbox/${otherTask}`)).item.status).toBe('review')
        expect(await readFile(join(resumed.directory, 'result.txt'), 'utf8')).toBe(`${otherProof}-resumed`)
        expect(resumed.executionEnvironment.world).toBe(alternate.id)
      }, { timeout: 120_000, interval: 1000 })
    }
    if (owned && alternate) await qualifySchedules(api, alternate.id, async () => { await stop(); start(); await ready() })
    let lostRevocation: ReturnType<typeof vi.spyOn> | undefined, revocationCalls = 0
    if (owned && otherTask) {
      const spare = await api(`endpoints/${h.endpoint.journal.id}/commands`, { revision: 1, request: { op: 'grant.create', requestId: 'recovery-active-world',
        owner: 'coordinator', workspace: 'recovery-active-world', operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300_000,
        credentials: [{ id: binding.id, version: binding.version }] } })
      expect(spare.phase).toBe('done')
      const active = await api('worlds', { requestId: 'activate-recovery-active', endpointId: h.endpoint.journal.id, commandId: spare.id, name: 'Recovery credential qualification' })
      expect(active.ready, active.problem).toBe(true)
      const rpc = h.endpoint.rpc.bind(h.endpoint)
      lostRevocation = vi.spyOn(h.endpoint, 'rpc').mockImplementation(async (...args) => {
        const result = await rpc(...args), request = args[1] as { op: string; requestId?: string }
        if (request.op === 'grant.revoke' && request.requestId === 'revoke-managed-b-lost') {
          revocationCalls++
          throw new Error('Qualification lost original revocation acknowledgement')
        }
        return result
      })
      const revoked = await api(`worlds/${alternate.id}/revoke`, { requestId: 'revoke-managed-b-lost', revision: alternate.revision, reason: 'Qualification interrupted revocation acknowledgement' })
      expect(revoked).toMatchObject({ enabled: false, ready: false, status: { phase: 'revoking', revocation: { acknowledged: false } } })
      expect(revocationCalls).toBeGreaterThanOrEqual(2) // Live retry/maintenance retain the identical original request.
    }
    await stop()
    const liveRevocationCalls = revocationCalls
    const executionProfile = JSON.parse(await readFile(overlay, 'utf8')) as any[]
    const stateDir = executionProfile.find(entry => entry.id === 'dsh-superagent').config.stateDir
    const dedicated = executionProfile.flatMap(entry => entry.insert ?? []).filter(entry => entry.id === 'operator-remote-world').map(entry => entry.config)
    const worldDirectories = dedicated.map(config => config.stateDir)
    const worldConnections = dedicated.map(config => ({ binding: worldBinding(config.endpointId, enrolled.grant), endpointId: config.endpointId,
      url: config.url, credentialFile: config.credentialFile }))
    const unrecordedPublications = mode === 'dedicated' && publisher && ownershipConfig
      ? await qualifyPublication({ cli, home, profile, directory, port, publisher, ownership: ownershipConfig }) : []
    await qualifyRecovery({ cli, home, profile, directory, temporary: h.directory, port, stateDir, sessionRoot, executionProfile,
      worldDirectories, worker: ticket.sessionId, worlds: mode === 'managed' ? owned ? 3 : 2 : 1, unrecordedPublications, expectedRecoveredRevocations: lostRevocation ? 1 : 0,
      expectedPublicationDestinations: publisher?.config.destinations.length,
      ...(authority ? { authority: { ...authority.admin.connection, coordinatorId: authority.config.coordinatorId }, originalClaimantFile: authority.config.credentialFile,
        audit: { endpoints: [{ url: h.url, endpointId: h.endpoint.journal.id, credentialFile: await realpath(h.connection.credentialFile) }], worlds: worldConnections, publication: publisher!.admin.config } } : {}) })
    if (lostRevocation) { expect(revocationCalls).toBe(liveRevocationCalls); lostRevocation.mockRestore() }
    if (mode === 'dedicated' && !owned) await qualifyOwnership({ cli, home, profile, directory, temporary: h.directory, port, native })
  } catch (error) {
    const diagnostics: unknown[] = []
    try {
      diagnostics.push({ worlds: (await api('worlds')).items })
      const inbox = await api('inbox')
      for (const item of inbox.items) {
        const conversation = await api(`inbox/${item.id}`)
        diagnostics.push({ id: item.id, status: item.status, messages: conversation.messages.filter((message: any) => message.role === 'agent' || message.role === 'status')
          .map((message: any) => String(message.text).replaceAll(secret, '[redacted]').slice(-2000)).slice(-6) })
      }
      diagnostics.push({ jobs: h.endpoint.journal.jobs().map(job => ({ id: job.id, phase: job.phase, quiescent: job.quiescent,
        owner: job.request.owner, program: job.request.argv[0], outcome: job.outcome })) })
    } catch { /* The process may have exited before read-only diagnostics. */ }
    const redacted = log.split('\n').filter(line => !/api.?key|authorization|secret|credential|token/i.test(line)).slice(-65).join('\n')
    throw new Error(`${String(error)}\nHarness qualification log (sensitive lines omitted):\n${redacted}\nQualification status: ${JSON.stringify(diagnostics)}`, { cause: error })
  }
}, 450_000)
