/** Opt-in real Harness stop barrier: one explicit kill fault, actual process progress, and original-identity release. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { key } from '../src/core/ids.ts'
import { executorStopProvider } from './fixtures/executor-stop-provider.ts'

type Identity = { runId: string; pid: number; pgid: number; birth: string; wallNs: string; monotonicNs: string }
type Heartbeat = { index: number; wallNs: string; monotonicNs: string; sha256: string }
type Trace = { type: string; at: number; sessionId?: string; jobId?: string; ignored?: boolean; timeoutMs?: number; elapsedMs?: number;
  status?: string; awaited?: boolean | null; stopHeld?: boolean; messageId?: string; source?: string; name?: string; cause?: string | null }

it.runIf(process.env.DSH_EXECUTOR_STOP_QUALIFICATION === '1')('holds replacement and queued input past an uncertain real job stop, then releases original identities exactly once', async () => {
  const cli = process.env.DSH_EXECUTOR_STOP_QUALIFICATION_CLI ?? process.env.DSH_ENDPOINT_QUALIFICATION_CLI
  if (!cli) throw new Error('Supply the installed Harness qualification CLI')
  const checkout = resolve('.'), directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh executor stop ')))
  const home = join(directory, 'private-home'), root = join(directory, 'workspace'), trace = join(directory, 'events.jsonl'), lease = join(directory, 'lease.json')
  const runId = randomUUID(), inputMarker = 'queued-stop-input-' + runId, profile = 'executor-stop-' + runId
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const builtManifest = async () => {
    const entries: Record<string, string> = {}
    const visit = async (path: string, prefix = ''): Promise<void> => {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) await visit(join(path, entry.name), prefix + entry.name + '/')
        else if (entry.isFile()) entries[prefix + entry.name] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex')
        else throw new Error('Qualification refuses linked build artifacts')
      }
    }
    await visit(join(checkout, 'lib')); return entries
  }
  const builtBefore = await builtManifest(), builtDigest = sha(JSON.stringify(builtBefore))

  const env = { ...Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])), HOME: home, PYTHONDONTWRITEBYTECODE: '1' }
  await mkdir(home, { mode: 0o700 }); await writeFile(trace, '', { mode: 0o600 })
  const python = [
    'from pathlib import Path', 'import hashlib,json,os,subprocess,time,sys',
    'run_id=' + JSON.stringify(runId) + ';lease=Path(' + JSON.stringify(lease) + ')',
    "birth=subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip()",
    'start=time.monotonic_ns();wall=time.time_ns()',
    "identity={'runId':run_id,'pid':os.getpid(),'pgid':os.getpgrp(),'birth':birth,'wallNs':str(wall),'monotonicNs':str(start)}",
    "with Path('original-start.json').open('x') as f:json.dump(identity,f);f.flush();os.fsync(f.fileno())",
    "previous='';i=0;completed=False;f=Path('original-heartbeat.jsonl').open('x')",
    'try:', ' while True:',
    '  value=json.loads(lease.read_text())',
    "  if value.get('runId')!=run_id or not value.get('active') or time.time()*1000-value.get('at',0)>10000:sys.exit(3)",
    '  mono=time.monotonic_ns();wall=time.time_ns()', "  digest=hashlib.sha256((str(i)+':'+previous).encode()).hexdigest()",
    "  f.write(json.dumps({'index':i,'wallNs':str(wall),'monotonicNs':str(mono),'sha256':digest})+'\\n');f.flush()",
    '  previous=digest;i+=1', '  if mono-start>=45000000000:completed=True;break', '  time.sleep(.25)',
    'finally:', " f.close();Path('original-exit.json').write_text(json.dumps({'runId':run_id,'pid':os.getpid(),'completed':completed,'count':i,'lastSha256':previous,'wallNs':str(time.time_ns()),'monotonicNs':str(time.monotonic_ns())}))",
    "print('ORIGINAL_STOP_JOB_DONE',flush=True)",
  ].join('\n')
  const replacement = [
    'from pathlib import Path', 'import json,time,os,subprocess',
    "value={'runId':" + JSON.stringify(runId) + ",'pid':os.getpid(),'pgid':os.getpgrp(),'birth':subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip(),'wallNs':str(time.time_ns()),'monotonicNs':str(time.monotonic_ns())}",
    "with Path('replacement.json').open('x') as f:json.dump(value,f)",
    "print('REPLACEMENT_ONCE',flush=True)",
  ].join('\n')
  const provider = await executorStopProvider('exec python3 -c ' + quote(python), 'exec python3 -c ' + quote(replacement), inputMarker)
  let child: ChildProcess | undefined, identity: Identity | undefined, workspace: string | undefined, stage = 'fresh isolated installation'
  let leaseActive = true, leaseWrites = Promise.resolve(), leaseError = false, safeToRemove = false, qualification: Record<string, unknown> | undefined, sealedFiles: Record<string, string> | undefined
  const saveLease = () => leaseWrites = leaseWrites.then(async () => {
    const temporary = lease + '.tmp'
    await writeFile(temporary, JSON.stringify({ runId, active: leaseActive, at: Date.now() }), { mode: 0o600 })
    await rename(temporary, lease)
  }).catch(() => { leaseError = true })
  await saveLease(); const leaseTimer = setInterval(() => { void saveLease() }, 1000)
  const events = async (): Promise<Trace[]> => {
    expect((await stat(trace)).size).toBeLessThanOrEqual(1024 * 1024)
    const content = await readFile(trace, 'utf8')
    const lines = content.split('\n'); if (lines.at(-1) !== '') lines.pop()
    return lines.filter(Boolean).map(line => JSON.parse(line))
  }
  const heartbeats = async (): Promise<Heartbeat[]> => {
    const path = join(workspace!, 'original-heartbeat.jsonl')
    expect((await stat(path)).size).toBeLessThan(128 * 1024)
    const content = await readFile(path, 'utf8'), lines = content.split('\n')
    if (lines.at(-1) !== '') lines.pop()
    return lines.filter(Boolean).map(line => JSON.parse(line))
  }
  const stop = async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    const running = child, done = new Promise<void>(resolve => running.once('exit', () => resolve()))
    running.kill('SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
    try { await done } finally { clearTimeout(timer) }
  }
  try {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve()))
    const installed = await promisify(execFile)('python3', [join(checkout, 'scripts/agentic-os'), 'init', '--directory', root, '--role', 'workspace',
      '--checkout', checkout, '--dsh', cli, '--profile', profile, '--port', String(port)], { cwd: directory, env, timeout: 120000, maxBuffer: 1024 * 1024 })
    expect(JSON.parse(installed.stdout)).toMatchObject({ installed: true, version: '0.2.1-rc.3' })
    const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')), patch = join(root, 'qualification.json'), shim = join(directory, 'loopback-only.mjs')
    await writeFile(shim, "const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw new Error('Qualification blocked external fetch');return original(input,{...init,redirect:'error'})};\n", { mode: 0o600 })
    const model = { provider: 'stop-fixture', model: 'scripted' }
    await writeFile(patch, JSON.stringify([...launch,
      { id: 'llm-pi-ai', config: { providers: { 'stop-fixture': { displayName: 'Synthetic stop qualification', api: 'openai-completions',
        baseURL: provider.url, apiKeyEnv: 'EXECUTOR_STOP_FIXTURE_KEY', compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        retryPolicy: { mode: 'normal', maxRetries: 0 }, timeoutMs: 60000, streamIdleTimeoutMs: 60000,
        models: [{ id: 'scripted', name: 'Synthetic stop fixture', contextWindow: 131072, maxTokens: 1024, input: ['text'] }] } } } },
      { id: 'agent-default-model', config: model },
      { insert: [{ id: 'stop-probe', name: pathToFileURL(join(checkout, 'tests/fixtures/executor-stop-probe.mjs')).href, config: { trace } }] },
    ]), { mode: 0o600 })
    child = spawn(cli, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: directory, env: { ...env, DSH_HOME: join(root, 'home'),
      EXECUTOR_STOP_FIXTURE_KEY: provider.providerKey, NODE_OPTIONS: '--import=' + pathToFileURL(shim).href }, stdio: 'ignore' })
    let spawnFailed = false; child.on('error', () => { spawnFailed = true })
    const api = async (path: string, body?: unknown): Promise<any> => {
      expect(leaseError).toBe(false); expect(spawnFailed).toBe(false)
      const response = await fetch('http://127.0.0.1:' + port + '/orchestrator/api/' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(5000) })
      expect(response.ok, 'local endpoint status ' + response.status).toBe(true)
      const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0
      try {
        for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; expect(size).toBeLessThanOrEqual(1024 * 1024); chunks.push(part.value) }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } finally { await reader.cancel() }
    }
    await vi.waitFor(async () => {
      expect(child?.exitCode).toBeNull(); expect((await api('state')).health.runtime.state).toBe('ready')
      expect((await events()).some(event => event.type === 'probe/ready')).toBe(true)
    }, { timeout: 40000, interval: 200 })
    const persona = await api('personas', { requestId: randomUUID(), definition: { name: 'Stop boundary fixture', description: 'Synthetic original execution ownership test',
      instructions: 'Use the one synthetic owned local job and report blocked. Only explicit operator retry may start replacement work. Do not delegate or contact external services.',
      model, capabilities: ['read', 'write', 'commands'], skills: [] } })
    const item = await api('inbox', { requestId: randomUUID(), title: 'Original stop boundary', persona: { id: persona.id, version: 1 }, text: 'Run the synthetic local stop qualification.' })
    let original: any
    await vi.waitFor(async () => {
      expect(provider.failures).toEqual([]); original = await api('tickets/' + item.id); expect(original.assignments).toHaveLength(1)
      expect(original.assignments[0].report?.state).toBe('blocked')
      expect(provider.requests).toHaveLength(3)
      workspace = original.directory; identity = JSON.parse(await readFile(join(workspace!, 'original-start.json'), 'utf8'))
      expect(identity).toMatchObject({ runId, pid: expect.any(Number), pgid: expect.any(Number), birth: expect.any(String) })
      expect(identity!.pid).toBeGreaterThan(1); expect(identity!.pgid).toBe(identity!.pid)
      expect((await events()).some(event => event.type === 'turn/end' && event.sessionId === 'worker-' + item.id)).toBe(true)
    }, { timeout: 20000, interval: 100 })
    const originalAssignment = original.assignments[0].id, originalIdentityHash = sha(await readFile(join(workspace!, 'original-start.json'), 'utf8'))
    stage = 'operator retry and held replacement/input'
    await api('tickets/' + item.id + '/retry', {})
    let pending = await api('tickets/' + item.id)
    expect(pending.assignments).toHaveLength(2)
    const replacementId = pending.assignments[1].id
    expect(pending.assignments[1]).toMatchObject({ state: 'pending' })
    const conversation = await api('inbox/' + item.id)
    const replyId = randomUUID()
    await api('inbox/' + item.id + '/reply', { requestId: replyId, revision: conversation.item.revision, text: inputMarker })
    pending = await api('tickets/' + item.id)
    const queued = pending.inputs.find((value: any) => value.trigger?.preview?.includes(inputMarker))
    expect(queued).toBeDefined()
    const inputId = queued.id, assignmentMessageId = 'dsh-superagent:' + key('assignment:' + item.id + ':' + replacementId), inputMessageId = 'dsh-superagent:' + key(inputId)
    let held: any
    await vi.waitFor(async () => {
      const rows = await api('tickets/' + item.id + '/stops')
      const originals = rows.items.filter((value: any) => value.assignmentId === originalAssignment && value.scope === 'all')
      expect(originals).toHaveLength(1); held = originals[0]
      expect(held).toBeDefined()
      expect(['prepared', 'observing', 'unknown']).toContain(held.state)
      const trace = await events(), killed = trace.filter(value => value.type === 'job/kill')
      expect(killed).toHaveLength(1); expect(killed[0]?.ignored).toBe(true)
      expect(trace.some(value => value.type === 'job/wait-return' && value.jobId === killed[0]?.jobId && value.timeoutMs === 10000
        && value.status === 'running' && (value.elapsedMs ?? 0) >= 9900)).toBe(true)
    }, { timeout: 18000, interval: 100 })
    const stopPath = 'tickets/' + item.id + '/assignments/' + originalAssignment + '/stops/' + held.id
    const first = (await heartbeats()).at(-1)!, heldAt = Date.now(), wireCount = provider.requests.length
    expect(wireCount).toBe(3)
    const recheck = await api(stopPath + '/recheck', { expectedRevision: held.revision,
      executionBindingHash: held.executionBindingHash, scopeHash: held.scopeHash })
    expect(recheck).toMatchObject({ observationRequested: true, current: { id: held.id, state: 'unknown', proof: null } })
    while (Date.now() - heldAt < 12100) {
      const current = await api('tickets/' + item.id), detail = await api(stopPath)
      expect(current.assignments).toHaveLength(2); expect(current.assignments[1]).toMatchObject({ id: replacementId, state: 'pending' })
      const input = current.inputs.find((value: any) => value.id === inputId)
      expect(input).toMatchObject({ delivered: false }); expect(input.readAt ?? null).toBeNull()
      expect(input.deliveredTo).toBeUndefined()
      expect(detail).toMatchObject({ id: held.id, ticketId: item.id, assignmentId: originalAssignment, executionBindingHash: held.executionBindingHash, scopeHash: held.scopeHash, proof: null })
      expect(['prepared', 'observing', 'unknown']).toContain(detail.state)
      expect(provider.requests).toHaveLength(wireCount); expect(provider.failures).toEqual([])
      expect((await events()).filter(value => value.type === 'job/kill')).toHaveLength(1)
      expect((await events()).filter(value => value.type === 'user/message' && [assignmentMessageId, inputMessageId].includes(value.messageId ?? ''))).toHaveLength(0)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const last = (await heartbeats()).at(-1)!
    expect(Number(BigInt(last.monotonicNs) - BigInt(first.monotonicNs)) / 1e9).toBeGreaterThanOrEqual(11.9)
    expect(last.index - first.index).toBeGreaterThanOrEqual(24)
    expect(await promisify(execFile)('ps', ['-p', String(identity!.pid), '-o', 'lstart='], { timeout: 5000 }).then(value => value.stdout.trim())).toBe(identity!.birth)
    stage = 'natural original settlement and exactly-once release'
    let quiet: any, completed: any
    await vi.waitFor(async () => {
      expect(provider.failures).toEqual([]); quiet = await api(stopPath)
      expect(quiet).toMatchObject({ id: held.id, state: 'quiet', proof: 'registry', assignmentId: originalAssignment })
      completed = await api('tickets/' + item.id)
      expect(completed.assignments).toHaveLength(2); expect(completed.assignments[1]).toMatchObject({ id: replacementId, state: 'running', report: { state: 'ready' } })
      expect(completed.inputs.filter((value: any) => value.id === inputId)).toHaveLength(1)
      expect(completed.inputs.find((value: any) => value.id === inputId)).toMatchObject({ delivered: true, deliveredTo: replacementId, readAt: expect.any(String) })
    }, { timeout: 45000, interval: 100 })
    const end = JSON.parse(await readFile(join(workspace!, 'original-exit.json'), 'utf8')), replacementReceipt = JSON.parse(await readFile(join(workspace!, 'replacement.json'), 'utf8'))
    expect(end).toMatchObject({ runId, pid: identity!.pid, completed: true })
    expect(replacementReceipt.runId).toBe(runId); expect(replacementReceipt.pid).toBeGreaterThan(1); expect(replacementReceipt.pgid).toBe(replacementReceipt.pid)
    expect(BigInt(replacementReceipt.monotonicNs)).toBeGreaterThan(BigInt(end.monotonicNs))
    expect(Number(BigInt(end.monotonicNs) - BigInt(identity!.monotonicNs)) / 1e9).toBeGreaterThanOrEqual(45)
    const beats = await heartbeats(); let previous = '', priorMono = BigInt(identity!.monotonicNs), priorWall = BigInt(identity!.wallNs)
    for (const [index, beat] of beats.entries()) {
      const digest = sha(String(index) + ':' + previous)
      expect(beat.index).toBe(index); expect(beat.sha256).toBe(digest)
      expect(BigInt(beat.monotonicNs)).toBeGreaterThan(priorMono)
      expect(Number(BigInt(beat.monotonicNs) - priorMono) / 1e9).toBeLessThan(3)
      expect(BigInt(beat.wallNs)).toBeGreaterThan(priorWall)
      expect(Number(BigInt(beat.wallNs) - priorWall) / 1e9).toBeLessThan(3)
      previous = digest; priorMono = BigInt(beat.monotonicNs); priorWall = BigInt(beat.wallNs)
    }
    expect(BigInt(end.monotonicNs)).toBeGreaterThanOrEqual(priorMono); expect(BigInt(end.wallNs)).toBeGreaterThanOrEqual(priorWall)
    expect(Number(BigInt(end.monotonicNs) - priorMono) / 1e9).toBeLessThan(3); expect(Number(BigInt(end.wallNs) - priorWall) / 1e9).toBeLessThan(3)
    expect(beats.length).toBe(end.count); expect(previous).toBe(end.lastSha256)
    expect(sha(await readFile(join(workspace!, 'original-start.json'), 'utf8'))).toBe(originalIdentityHash)
    const originalStops = (await api('tickets/' + item.id + '/stops')).items.filter((value: any) => value.assignmentId === originalAssignment && value.scope === 'all')
    expect(originalStops).toHaveLength(1); expect(originalStops[0].id).toBe(held.id)
    const finalEvents = await events(), kill = finalEvents.find(value => value.type === 'job/kill')!
    const settled = finalEvents.find(value => value.type === 'job/settled' && value.jobId === kill.jobId)!
    expect(settled).toMatchObject({ status: 'completed', awaited: false, cause: 'producer' })
    const registered = finalEvents.filter(value => value.type === 'job/registered')
    expect(registered).toHaveLength(2); expect(registered[0]?.jobId).toBe(kill.jobId)
    expect(registered[1]?.stopHeld).toBe(false)
    expect(quiet.targets.jobIds).toContain(kill.jobId)

    expect(finalEvents.filter(value => value.type === 'job/kill')).toHaveLength(1)
    for (const messageId of [assignmentMessageId, inputMessageId]) expect(finalEvents.filter(value => value.type === 'user/message' && value.messageId === messageId)).toHaveLength(1)
    expect(finalEvents.filter(value => value.type === 'tool/call' && value.stopHeld)).toHaveLength(0)
    const firstReleased = provider.requests.find(value => value.phase === 'held')!
    expect(firstReleased.replacementCard).toBe(true)
    expect(firstReleased.at).toBeGreaterThanOrEqual(Date.parse(quiet.settledAt))
    expect(provider.calls.filter(value => value.name === 'bash')).toHaveLength(2)
    expect(provider.calls.filter(value => value.name === 'orchestrator_report')).toHaveLength(2)
    const nativeMessages = finalEvents.filter(value => value.source === 'tool-jobs' && value.at >= settled.at)
    const nativeHeld = nativeMessages.some(value => value.stopHeld)
    sealedFiles = Object.fromEntries(await Promise.all(['original-start.json', 'original-exit.json', 'original-heartbeat.jsonl', 'replacement.json'].map(async name => [name, sha(await readFile(join(workspace!, name), 'utf8'))])))
    await writeFile(join(directory, 'qualification.json'), JSON.stringify({ runId, originalAssignment, replacementId, inputId, stopId: held.id,
      injectedFault: 'One ignored original jobs.kill; no claim that a process resisted native SIGKILL.',
      waitedRunning: finalEvents.filter(value => value.type === 'job/wait-return' && value.status === 'running'),
      continuedHeartbeatSeconds: Number(BigInt(last.monotonicNs) - BigInt(first.monotonicNs)) / 1e9, samples: beats.length,
      nativeCompletion: { awaited: settled.awaited, observedMessages: nativeMessages.length, heldMessageObserved: nativeHeld,
        interpretation: nativeHeld ? 'Native completion message observed while stop still held; no model/tool work admitted.' : 'No held native message was observed; quiet observation may have won the race. No interception claim.' },
      quiet, originalIdentityHash, builtDigest, builtManifest: builtBefore, sourceDirty: Boolean((await promisify(execFile)('git', ['status', '--porcelain'], { cwd: checkout })).stdout.trim()), sourceRevision: (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim() }, null, 2), { mode: 0o600 })
    expect(await builtManifest()).toEqual(builtBefore)
    qualification = { builtDigest, originalAssignment, replacementId, inputId, stopId: held.id,
      waitReturnedRunning: true, continuedHeartbeatSeconds: Number(BigInt(last.monotonicNs) - BigInt(first.monotonicNs)) / 1e9,
      originalKillDispatches: 1, originalSamples: beats.length, nativeUnawaitedSettlement: true, nativeHeldMessageObserved: nativeHeld,
      replacementLaunches: 1, queuedInputDeliveries: 1, quietProof: quiet.proof }
  } catch (error) {
    throw new Error('Installed stop boundary failed during ' + stage + '; retained private evidence: ' + directory, { cause: error })
  } finally {
    clearInterval(leaseTimer); leaseActive = false; await saveLease()
    await stop(); await provider.close()
    const identities: Identity[] = identity ? [identity] : []
    let identitiesKnown = provider.calls.filter(value => value.name === 'bash').length === identities.length
    if (workspace && provider.calls.filter(value => value.name === 'bash').length === 2) {
      try {
        const replacementIdentity = JSON.parse(await readFile(join(workspace, 'replacement.json'), 'utf8')) as Identity
        identities.push(replacementIdentity); identitiesKnown = true
      } catch { identitiesKnown = false }
    }
    identitiesKnown &&= identities.every(value => value.runId === runId && Number.isSafeInteger(value.pid) && value.pid > 1
      && value.pid === value.pgid && typeof value.birth === 'string')
    let absent = identitiesKnown && identities.length === 0
    if (identitiesKnown && identities.length) for (let attempt = 0; attempt < 50; attempt++) {
      absent = identities.every(value => { try { process.kill(-value.pgid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' } })
      if (absent) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (sealedFiles) for (const [name, digest] of Object.entries(sealedFiles)) {
      if (sha(await readFile(join(workspace!, name), 'utf8')) !== digest) absent = false
    }
    safeToRemove = absent && !leaseError
    if (safeToRemove && qualification) {
      process.stdout.write('EXECUTOR_STOP_QUALIFICATION ' + JSON.stringify({ ...qualification, cleanup: 'confirmed_owned_group_absent' }) + '\n')
      await rm(directory, { recursive: true, force: true })
    } else if (!safeToRemove) throw new Error('Stop qualification cleanup is unknown; retained private evidence: ' + directory)
  }
}, 180000)
