#!/usr/bin/env node
/** Isolated, scripted endurance operator. Execution is explicit; existing runs are evidence, never resumable instructions. */
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { enduranceProvider } from '../tests/fixtures/supervision-endurance-provider.mjs'

const exec = promisify(execFile), checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), sha = value => createHash('sha256').update(value).digest('hex')
const fileSha = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
const settings = { pollMs: 1000, staleMs: 1000, reviewEveryMs: 3600000, retryMs: 5000, assessmentTimeoutMs: 2000 }
const requireFact = (value, code) => { if (!value) throw new Error(code) }
export function enduranceCompletionState({ verified, failed, aborted, cancelled, cleanupConfirmed }) {
  return !cleanupConfirmed ? 'failed' : cancelled ? 'cancelled' : verified && !failed && !aborted ? 'completed' : 'failed'
}
const syncDirectory = async path => { const fd = await open(path, 'r'); try { await fd.sync() } finally { await fd.close() } }
export function endurancePlan(durationSeconds = 28800, chunkSeconds = 1200) {
  requireFact(Number.isSafeInteger(durationSeconds) && durationSeconds >= 120 && durationSeconds <= 86400, 'duration_outside_120_to_86400_seconds')
  requireFact(Number.isSafeInteger(chunkSeconds) && chunkSeconds >= 60 && chunkSeconds <= 1200, 'chunk_outside_60_to_1200_seconds')
  const chunks = Array.from({ length: Math.ceil(durationSeconds / chunkSeconds) }, (_, index) => ({ index, seconds: Math.min(chunkSeconds, durationSeconds - index * chunkSeconds) }))
  return { schema: 1, mode: 'plan', modelTraffic: false, durationSeconds, chunkSeconds, chunks, productiveCadenceSeconds: 1, sampleCadenceSeconds: 10,
    limits: { providerRequests: chunks.length * 4 + Math.ceil(durationSeconds / 3600) * 12 + 200,
      providerRequestBytes: 2 * 1024 * 1024, httpResponseBytes: 1024 * 1024, sampleRecords: Math.ceil((durationSeconds + chunks.length * 10) / 10) + 100, sampleRecordBytes: 8192,
      productiveFileBytes: 16 * 1024 * 1024, sampledStateStopBytes: 256 * 1024 * 1024, workerMaxGapSeconds: 10, sampleMaxGapSeconds: 60, globalGraceSeconds: 120 + chunks.length * 10, transitionGraceSecondsPerChunk: 10 },
    watchdog: settings, jobCompletion: 'native_notice_then_one_nonwaiting_read', effectiveJobWaitCapMs: 5000, singleIdleJobLimitSeconds: 1800, watchdogRestartFraction: 0.45,
    interpretation: 'Scripted local endurance, not semantic model quality or a confinement claim. A sampled disk stop threshold permits overshoot between measurements.' }
}
export async function enduranceStatus(output) {
  const path = resolve(output), metadata = await stat(join(path, 'report.json'))
  requireFact(metadata.isFile() && metadata.size <= 2 * 1024 * 1024, 'invalid_report')
  const report = JSON.parse(await readFile(join(path, 'report.json'), 'utf8'))
  return { schema: 1, runId: report.runId, state: report.state, stage: report.stage, outcome: report.outcome,
    startedAt: report.startedAt, completedAt: report.completedAt, heartbeatAt: report.heartbeatAt,
    heartbeatAgeMs: Date.now() - Date.parse(report.heartbeatAt), liveness: 'unknown_from_report_only',
    progress: report.progress, chunks: { planned: report.plan?.chunks?.length ?? null, started: report.latestObservation?.startedChunks ?? null,
      completed: report.provider?.completedChunks ?? null, nativeWakes: report.provider?.nativeWakes ?? null, outputReads: report.provider?.jobOutput ?? null },
    provider: report.provider ?? null, latestObservation: report.latestObservation ?? null, cleanup: report.cleanup, report: join(path, 'report.json'), recovery: 'Never automatically resume or replay this run.' }
}
async function port() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value
}
async function tree(path, { hashes = false, limit = Infinity, ownedLinks = false } = {}) {
  let bytes = 0, files = 0, symlinks = 0; const manifest = {}, canonical = await realpath(path)
  const visit = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        symlinks++
        if (hashes) {
          requireFact(ownedLinks, 'symlink_in_sealed_runtime_assets')
          const target = await realpath(full); requireFact(target.startsWith(canonical + '/'), 'dependency_link_outside_snapshot')
          manifest[relative(path, full)] = 'link:' + relative(canonical, target)
        }
        continue // State scans report excluded links; immutable dependency bytes are measured separately.
      }
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) {
        const value = await stat(full); bytes += value.size; files++; requireFact(bytes <= limit, 'retained_state_stop_threshold')
        if (hashes) manifest[relative(path, full)] = sha(await readFile(full))
      } else throw new Error('unexpected_snapshot_entry')
    }
  }
  await visit(path); return { bytes, files, symlinks, ...(hashes ? { manifest } : {}) }
}
async function boundedJson(url, body, signal) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('local_endpoint_unavailable') }
  const reader = response.body.getReader(), chunks = []; let size = 0
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; requireFact(size <= 1024 * 1024, 'http_response_limit'); chunks.push(part.value) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) } finally { await reader.cancel() }
}
/** Uses only freshly installed profiles and loopback scripted inference; it never reads a user's provider credential. */
export async function runEndurance({ dsh, output, durationSeconds = 28800, chunkSeconds = 1200, signal }) {
  const plan = endurancePlan(durationSeconds, chunkSeconds), root = resolve(output), runId = randomUUID(), started = Date.now(), controller = new AbortController()
  const lifetime = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), cleanups = [], processes = []
  await mkdir(root, { mode: 0o700 }) // Atomic refusal of an existing output directory is the no-replay boundary.
  const report = { schema: 1, runId, state: 'running', stage: 'preparing_snapshot', outcome: 'unknown', startedAt: new Date(started).toISOString(), completedAt: null,
    heartbeatAt: new Date().toISOString(), runnerPid: process.pid, plan, source: {}, snapshot: {}, dependencies: {}, processes,
    progress: {}, phases: [], observations: { samples: 0, currentAssessments: 0, historicalAssessments: 0, absentAssessments: 0,
      mainUnreachable: 0, watchdogUnreachable: 0, maximumSampleGapMs: 0, maximumRssKiB: {}, maximumRetainedStateBytes: 0 },
    original: { intentId: runId, ticketId: null, assignmentId: null, artifactRequestId: 'endurance-artifact', acknowledgement: null, deliveryId: null },
    cleanup: { state: 'pending' }, interpretation: plan.interpretation,
    recovery: 'Abrupt runner loss leaves the original outcome unknown. Inspect retained evidence and owned processes; never rerun using this directory.' }
  let writes = Promise.resolve(), sampleTimer, sampling = false, provider, main, watch, ticket, acknowledgement, receipt, incidentId
  let sampleFd, lastSample = 0, samplingError, workerStart, workerObservedAt, watchOutage = true, mainOutage = false, runFailed = false, leaseActive = true, globalTimer, globalDeadline, verified = false, ownershipDigests, identities = []
  const leasePath = join(root, 'worker-lease.json')
  const saveLease = async () => { const path = join(root, 'worker-lease.json.tmp'), fd = await open(path, 'w', 0o600)
    try { await fd.writeFile(JSON.stringify({ runId, active: leaseActive, heartbeatAt: Date.now() })); await fd.sync() } finally { await fd.close() }
    await rename(path, leasePath); await syncDirectory(root) }
  const save = () => writes = writes.then(async () => {
    report.heartbeatAt = new Date().toISOString()
    const temporary = join(root, 'report.json.tmp'), fd = await open(temporary, 'w', 0o600)
    try { await fd.writeFile(JSON.stringify(report, null, 2) + '\n'); await fd.sync() } finally { await fd.close() }
    await rename(temporary, join(root, 'report.json')); await saveLease(); await syncDirectory(root)
  })
  const phase = async (name, details = {}) => { report.stage = name; report.phases.push({ name, at: new Date().toISOString(), ...details }); await save() }
  const guard = () => { lifetime.throwIfAborted(); if (samplingError) throw samplingError; requireFact(!provider?.snapshot().failures.length, 'scripted_provider_failed') }
  const wait = async (check, timeoutMs, code) => {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) { guard(); const result = await check().catch(() => false); if (result) return result; await sleep(200) }
    throw new Error(code)
  }
  const readIdentities = async () => {
    const path = join(ticket.directory, 'invocations.jsonl'); requireFact((await stat(path)).size <= 1024 * 1024, 'invocation_metadata_limit')
    const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    requireFact(records.length <= plan.chunks.length && records.length >= identities.length, 'unexpected_chunk_invocation_count')
    for (const [index, record] of records.entries()) {
      requireFact(record.runId === runId && record.chunk === index && record.chunkId === runId + ':' + index
        && Number.isSafeInteger(record.pid) && record.pid > 1 && record.pid === record.pgid && typeof record.startIdentity === 'string', 'worker_identity_invalid')
      const name = `chunk-${index}-start.json`, digest = await fileSha(join(ticket.directory, name))
      requireFact(JSON.stringify(JSON.parse(await readFile(join(ticket.directory, name), 'utf8'))) === JSON.stringify(record), 'worker_identity_evidence_changed')
      if (identities[index]) requireFact(JSON.stringify(identities[index]) === JSON.stringify(record), 'worker_identity_evidence_changed')
      if (ownershipDigests?.[name]) requireFact(ownershipDigests[name] === digest, 'worker_identity_evidence_changed')
      ownershipDigests ??= {}; ownershipDigests[name] = digest
    }
    identities = records; report.workerProcesses = records; return records
  }
  await save() // Persist the original run intent before any process or model request.
  try {
    const sourceSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim()
    report.source = { revision: sourceSha, dirty: Boolean((await exec('git', ['status', '--porcelain'], { cwd: checkout })).stdout.trim()) }
    const snapshot = join(root, 'snapshot'); await mkdir(snapshot, { mode: 0o700 })
    await cp(join(checkout, 'lib'), join(snapshot, 'lib'), { recursive: true, verbatimSymlinks: true })
    const tracked = (await exec('git', ['ls-files', '-z', '--', 'scripts', 'prompts', 'skills', 'locale', 'package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'], { cwd: checkout })).stdout.split('\0').filter(Boolean)
    for (const name of new Set([...tracked, 'scripts/supervision-endurance.mjs', 'tests/fixtures/supervision-endurance-provider.mjs'])) {
      await mkdir(dirname(join(snapshot, name)), { recursive: true, mode: 0o700 }); await cp(join(checkout, name), join(snapshot, name), { verbatimSymlinks: true })
    }
    // Relative pnpm links stay inside this copied dependency tree; unlike a link to checkout, later builds/installations cannot rewrite it.
    await cp(join(checkout, 'node_modules'), join(snapshot, 'node_modules'), { recursive: true, verbatimSymlinks: true })
    const built = await tree(join(snapshot, 'lib'), { hashes: true, limit: 16 * 1024 * 1024 })
    const assets = {}
    for (const name of ['lib', 'prompts', 'skills', 'locale', 'scripts', 'tests']) assets[name] = await tree(join(snapshot, name), { hashes: true, limit: 32 * 1024 * 1024 })
    const dependencyTree = await tree(join(snapshot, 'node_modules'), { hashes: true, ownedLinks: true, limit: 512 * 1024 * 1024 })
    const manifest = JSON.stringify({ assets, dependencies: dependencyTree })
    requireFact(Buffer.byteLength(manifest) < 16 * 1024 * 1024, 'snapshot_manifest_limit')
    await writeFile(join(root, 'snapshot-manifest.json'), manifest, { mode: 0o600 })
    report.snapshot = { directory: snapshot, built, packageSha256: sha(await readFile(join(snapshot, 'package.json'))), lockfileSha256: sha(await readFile(join(snapshot, 'pnpm-lock.yaml'))),
      installerSha256: sha(await readFile(join(snapshot, 'scripts/agentic-os'))), operatorSha256: sha(await readFile(fileURLToPath(import.meta.url))),
      providerSha256: sha(await readFile(join(checkout, 'tests/fixtures/supervision-endurance-provider.mjs'))), manifestSha256: sha(manifest),
      copiedDependencies: { bytes: dependencyTree.bytes, files: dependencyTree.files, containedSymlinks: dependencyTree.symlinks } }
    const cli = await realpath(dsh), version = (await exec(cli, ['--version'], { timeout: 10000 })).stdout.trim()
    requireFact(version === '0.2.1-rc.3', 'unqualified_harness_version')
    report.dependencies = { harness: { version, cli, shared: true, assumption: 'The external pinned Harness installation must remain unchanged during this run.' },
      node: process.version, platform: process.platform, architecture: process.arch, checkoutDependencies: 'Copied with the snapshot; no link to the active checkout dependency tree.' }
    const home = join(root, 'private-home'), work = join(root, 'invocation'); await mkdir(home, { mode: 0o700 }); await mkdir(work, { mode: 0o700 })
    const env = { ...Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : [])), HOME: home, PYTHONDONTWRITEBYTECODE: '1' }
    const pythonInfo = JSON.parse((await exec('python3', ['-c', 'import json,sys;print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0]}))'], { cwd: work, env, timeout: 10000 })).stdout)
    const pythonExecutable = await realpath(pythonInfo.executable)
    report.dependencies.python = { executable: pythonExecutable, version: pythonInfo.version, shared: true, assumption: 'This resolved external Python installation must remain unchanged during the run.' }
    const proof = 'endurance-' + runId, quote = text => "'" + text.replaceAll("'", "'\\''") + "'"
    const commands = plan.chunks.map(({ index, seconds }) => {
      const python = [
        'from pathlib import Path', 'import hashlib,json,os,time,subprocess,sys',
        `run_id=${JSON.stringify(runId)}; lease_path=Path(${JSON.stringify(leasePath)}); chunk=${index}; seconds=${seconds}; final=${index === plan.chunks.length - 1 ? 'True' : 'False'}`,
        "identity=subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip()",
        'start=time.monotonic_ns(); wall=time.time_ns()',
        "record={'pid':os.getpid(),'pgid':os.getpgrp(),'startIdentity':identity,'runId':run_id,'chunkId':run_id+':'+str(chunk),'chunk':chunk,'wallNs':str(wall),'monotonicNs':str(start)}",
        "def exclusive(name,value):",
        " with Path(name).open('x') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())",
        "exclusive('chunk-'+str(chunk)+'-start.json',record)",
        "if chunk==0:",
        " exclusive('job-start.json',record);previous='';i=0",
        "else:",
        " tail=json.loads(Path('chunk-'+str(chunk-1)+'-end.json').read_text());previous=tail['lastSha256'];i=tail['count']",
        "with Path('invocations.jsonl').open('x' if chunk==0 else 'a') as f:f.write(json.dumps(record)+'\\n');f.flush();os.fsync(f.fileno())",
        "f=Path('samples.jsonl').open('x' if chunk==0 else 'a');completed=False;first=i",
        'try:', ' while True:',
        '  try:', '   lease=json.loads(lease_path.read_text())',
        "   if lease.get('runId')!=run_id or not lease.get('active') or time.time()*1000-lease.get('heartbeatAt',0)>60000:raise RuntimeError('lease_expired')",
        "  except Exception: sys.exit(3)",
        '  now=time.monotonic_ns(); current=time.time_ns()', "  digest=hashlib.sha256((str(i)+':'+previous).encode()).hexdigest()",
        "  f.write(json.dumps({'index':i,'chunk':chunk,'wallNs':str(current),'monotonicNs':str(now),'sha256':digest})+'\\n');f.flush()",
        '  previous=digest;i+=1', '  if now-start>=seconds*1000000000:completed=True;break', '  time.sleep(1)',
        'finally:', " f.close();exclusive('chunk-'+str(chunk)+'-exit.json',{'runId':run_id,'chunk':chunk,'pid':os.getpid(),'completed':completed,'wallNs':str(time.time_ns())})",
        "end={'runId':run_id,'chunk':chunk,'wallNs':str(time.time_ns()),'monotonicNs':str(time.monotonic_ns()),'firstIndex':first,'count':i,'lastSha256':previous}",
        "exclusive('chunk-'+str(chunk)+'-end.json',end)",
        'if final:', ` Path('proof.txt').open('x').write(${JSON.stringify(proof)})`, " exclusive('job-end.json',end)",
        "print('ENDURANCE_CHUNK_DONE_'+str(chunk),flush=True)",
      ].join('\n')
      return 'exec ' + quote(pythonExecutable) + ' -c ' + quote(python)
    })
    provider = await enduranceProvider({ commands, proof, requestLimit: plan.limits.providerRequests }); cleanups.push(() => provider.close())
    const shim = join(root, 'loopback-only.mjs')
    await writeFile(shim, `const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw new Error('Endurance blocked external fetch');return original(input,{...init,redirect:'error'})};\n`, { mode: 0o600 })
    const model = { provider: 'endurance', model: 'scripted' }, modelPatch = [
      { id: 'llm-pi-ai', config: { providers: { endurance: { displayName: 'Synthetic endurance provider', api: 'openai-completions', baseURL: provider.url,
        apiKeyEnv: 'ENDURANCE_FIXTURE_KEY', compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }, retryPolicy: { mode: 'normal', maxRetries: 0 },
        timeoutMs: 60000, streamIdleTimeoutMs: 60000, models: [{ id: 'scripted', name: 'Synthetic endurance', contextWindow: 131072, maxTokens: 1024, input: ['text'] }] } } } },
      { id: 'agent-default-model', config: model } ]
    const install = async (kind, extra) => {
      const directory = join(root, kind), profile = 'endurance-' + kind + '-' + runId, webPort = await port()
      const initialized = await exec(pythonExecutable, [join(snapshot, 'scripts/agentic-os'), 'init', '--directory', directory, '--role', 'workspace', '--checkout', snapshot,
        '--dsh', cli, '--profile', profile, '--port', String(webPort)], { cwd: work, env, timeout: 120000, maxBuffer: 1024 * 1024 })
      requireFact(JSON.parse(initialized.stdout).version === version, 'installation_version_mismatch')
      const launch = JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8')), patch = join(directory, 'endurance.json')
      await writeFile(patch, JSON.stringify([...launch, ...modelPatch, ...extra]), { mode: 0o600 })
      let child, record
      const stop = async (hard = false) => {
        if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
        const active = child, done = new Promise(resolve => active.once('exit', resolve)); active.kill(hard ? 'SIGKILL' : 'SIGINT')
        const timer = setTimeout(() => active.kill('SIGKILL'), 8000)
        try { await done } finally { clearTimeout(timer) }
        record.stoppedAt = new Date().toISOString(); record.signal = active.signalCode; record.exitCode = active.exitCode
      }
      cleanups.push(() => stop())
      return { directory, state: join(directory, 'state'), port: webPort, stop, pid: () => child?.pid,
        alive: () => child?.exitCode === null && child?.signalCode === null,
        async start() {
          child = spawn(cli, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: work, env: { ...env, DSH_HOME: join(directory, 'home'),
            ENDURANCE_FIXTURE_KEY: provider.providerKey, NODE_OPTIONS: `--import=${pathToFileURL(shim).href}` }, stdio: 'ignore' })
          record = { role: kind, pid: child.pid ?? null, startedAt: new Date().toISOString(), stoppedAt: null }; processes.push(record)
          child.on('error', () => { record.spawnFailed = true; controller.abort() }); await save()
        },
      }
    }
    main = await install('main', [])
    watch = await install('watch', [{ id: 'dsh-superagent', disabled: true }, { id: 'dsh-superagent-sources', disabled: true },
      { insert: [{ id: 'watchdog-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'dsh-superagent-watchdog', name: 'Synthetic endurance watchdog', plugins: [] } },
        { id: 'watchdog', name: 'dsh-superagent/watchdog', config: { stateDir: join(root, 'watch/state'), tokenFile: join(main.state, 'watchdog.token'), url: `http://127.0.0.1:${main.port}`, ...settings, model } }] }])
    const api = (kind, path, body) => boundedJson(`http://127.0.0.1:${kind === 'main' ? main.port : watch.port}/${kind === 'main' ? 'orchestrator' : 'watchdog'}/api/${path}`, body, lifetime)
    const readyMain = () => wait(async () => main.alive() && (await api('main', 'state')).health.runtime.state === 'ready', 40000, 'main_startup_timeout')
    await main.start(); await readyMain()
    const persona = await api('main', 'personas', { requestId: runId + '-persona', definition: { name: 'Synthetic endurance worker', description: 'One sustained local assignment of bounded background chunks',
      instructions: 'Run each unique bounded hash chunk once. End your turn after launching a background chunk. Its native completion notice wakes you: read output once without waiting, then launch the next chunk. Publish final proof once after all chunks finish. Do not poll, delegate, contact external services, or replay chunks.',
      model, capabilities: ['read', 'write', 'commands'], skills: [] } })
    const item = await api('main', 'inbox', { requestId: runId + '-task', title: 'Synthetic productive endurance workload', persona: { id: persona.id, version: 1 },
      text: 'Run the synthetic local hash-producing mission as bounded chunks under this one assignment. Native job completion resumes work. Publish exact final proof and report ready only after every chunk finishes.' })
    report.original.ticketId = item.id; await save()
    ticket = await wait(async () => { const value = await api('main', `tickets/${item.id}`); return value.directory && value.assignments.length === 1 && value }, 20000, 'assignment_not_created')
    report.original.assignmentId = ticket.assignments[0].id
    workerStart = await wait(async () => JSON.parse(await readFile(join(ticket.directory, 'job-start.json'), 'utf8')), 20000, 'productive_job_not_started')
    requireFact(workerStart.runId === runId && Number.isSafeInteger(workerStart.pid) && workerStart.pid > 1 && workerStart.pgid === workerStart.pid && typeof workerStart.startIdentity === 'string', 'worker_identity_invalid')
    workerObservedAt = process.hrtime.bigint()
    identities = [workerStart]
    ownershipDigests = { 'job-start.json': await fileSha(join(ticket.directory, 'job-start.json')) }
    globalDeadline = Date.now() + (durationSeconds + plan.limits.globalGraceSeconds) * 1000
    globalTimer = setTimeout(() => { samplingError = new Error('global_run_deadline'); controller.abort() }, (durationSeconds + plan.limits.globalGraceSeconds) * 1000)
    report.progressDeadlineAt = new Date(globalDeadline).toISOString()
    report.progress = { workerStart, plannedSeconds: durationSeconds, completed: false }; await phase('productive_job_running')
    sampleFd = await open(join(root, 'observations.jsonl'), 'a', 0o600)
    const sample = async () => {
      if (sampling) return; sampling = true
      try {
        const at = Date.now(), row = { at: new Date(at).toISOString(), elapsedSeconds: (at - Number(BigInt(workerStart.wallNs) / 1000000n)) / 1000, plannedWatchOutage: watchOutage, plannedMainOutage: mainOutage }
        if (lastSample) { const gap = at - lastSample; report.observations.maximumSampleGapMs = Math.max(report.observations.maximumSampleGapMs, gap); requireFact(gap <= 60000, 'host_sample_gap_exceeded') }
        lastSample = at
        const [mainState, watchState] = await Promise.all([api('main', `tickets/${item.id}`).catch(() => null), api('watch', 'status').catch(() => null)])
        if (!mainState) report.observations.mainUnreachable++; else requireFact(mainState.assignments.length === 1 && mainState.assignments[0].id === report.original.assignmentId, 'assignment_changed')
        if (!watchState) report.observations.watchdogUnreachable++
        const observed = watchState?.incidents?.find(value => value.observation.id === item.id)
        const assessment = !observed?.assessment ? 'absent' : observed.assessment.incidentRevision === observed.revision ? 'current' : 'historical'
        report.observations[assessment + 'Assessments']++
        row.mainReachable = !!mainState; row.watchdogReachable = !!watchState; row.assessment = assessment
        row.monitorAt = watchState?.monitor?.at ?? null; row.monitorReachable = watchState?.monitor?.reachable ?? null
        row.monitorAgeMs = row.monitorAt === null ? null : at - row.monitorAt
        if (!mainOutage) requireFact(!!mainState, 'unplanned_main_observation_gap')
        if (!watchOutage) {
          requireFact(!!watchState && row.monitorAgeMs !== null && row.monitorAgeMs <= 10000, 'unplanned_watchdog_observation_gap')
          if (!mainOutage) requireFact(row.monitorReachable === true, 'main_not_freshly_supervised')
        }
        row.cycleAt = observed?.cycleAt ?? null; row.attempts = observed?.attempts ?? null
        row.observation = observed ? { revision: observed.observation.revision, stage: observed.observation.stage,
          assignmentId: observed.observation.assignmentId, execution: observed.observation.execution ?? null } : null
        await readIdentities(); row.startedChunks = identities.length; row.completedChunks = provider.snapshot().completedChunks
        row.productiveFileBytes = (await stat(join(ticket.directory, 'samples.jsonl'))).size
        requireFact(row.productiveFileBytes <= plan.limits.productiveFileBytes, 'productive_file_limit')
        if (observed) requireFact(!observed.intervention, 'unauthorized_watchdog_intervention')
        const pids = [process.pid, main.pid(), watch.pid()].filter(pid => Number.isSafeInteger(pid))
        const resources = await exec('ps', ['-o', 'pid=,rss=,%cpu=', '-p', pids.join(',')], { timeout: 5000, maxBuffer: 16384 }).catch(() => null)
        row.resources = resources ? resources.stdout.trim().split('\n').filter(Boolean).map(line => { const [pid, rssKiB, cpuPercent] = line.trim().split(/\s+/).map(Number); return { pid, rssKiB, cpuPercent } }) : null
        for (const resource of row.resources ?? []) report.observations.maximumRssKiB[resource.pid] = Math.max(report.observations.maximumRssKiB[resource.pid] ?? 0, resource.rssKiB)
        const sizes = await Promise.all([main.directory, watch.directory].map(path => tree(path, { limit: plan.limits.sampledStateStopBytes })))
        row.retainedStateBytes = sizes.reduce((sum, value) => sum + value.bytes, 0)
        row.excludedStateSymlinks = sizes.reduce((sum, value) => sum + value.symlinks, 0)
        requireFact(row.retainedStateBytes <= plan.limits.sampledStateStopBytes, 'retained_state_stop_threshold')
        report.observations.maximumRetainedStateBytes = Math.max(report.observations.maximumRetainedStateBytes, row.retainedStateBytes)
        requireFact(++report.observations.samples <= plan.limits.sampleRecords, 'observation_record_limit')
        report.provider = provider.snapshot(); report.latestObservation = row
        const line = JSON.stringify(row) + '\n'; requireFact(Buffer.byteLength(line) <= plan.limits.sampleRecordBytes, 'observation_record_bytes_limit')
        await sampleFd.write(line); await sampleFd.sync(); await save()
      } catch (error) { samplingError = error; controller.abort() } finally { sampling = false }
    }
    await sample(); sampleTimer = setInterval(() => { void sample() }, 10000)
    await watch.start(); await phase('watchdog_provider_error')
    await wait(async () => { const state = await api('watch', 'status'); return state.monitor?.reachable && state.monitor.modelError && provider.snapshot().errors === 1 }, 20000, 'provider_error_not_observed')
    watchOutage = false
    provider.mode('hang'); await phase('watchdog_provider_hang')
    await wait(async () => { const state = await api('watch', 'status'); return state.monitor?.modelError?.includes('timed out') && provider.snapshot().hangs === 1 && provider.snapshot().aborted === 1 }, 20000, 'provider_deadline_not_observed')
    provider.mode('assess'); await phase('watchdog_assessment_recovery')
    await wait(async () => { const state = await api('watch', 'status'), incident = state.incidents.find(value => value.observation.id === item.id)
      const ended = await stat(join(ticket.directory, 'job-end.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
      if (!ended && incident?.assessment?.incidentRevision === incident?.revision && !state.monitor.modelError && incident.observation.stage === 'working'
        && incident.observation.assignmentId === report.original.assignmentId && incident.observation.execution?.jobs?.counts?.running >= 1) { incidentId = incident.id; return true }
      return false }, 20000, 'assessment_not_recovered_while_productive')
    const nominalRestartSeconds = durationSeconds * 0.45
    const restartChunk = plan.chunks[Math.floor(nominalRestartSeconds / chunkSeconds)]
    const restartSeconds = Math.max(restartChunk.index * chunkSeconds + 15, Math.min(nominalRestartSeconds, restartChunk.index * chunkSeconds + restartChunk.seconds - 45))
    const restartAt = workerObservedAt + BigInt(Math.floor(restartSeconds * 1e9))
    report.restartSchedule = { nominalSeconds: nominalRestartSeconds, actualPlannedSeconds: restartSeconds, reason: 'Reserve a 45-second window before a chunk boundary for natural stale-lock recovery.' }
    // Schedule from this process's clock; the producer's clock origin is never compared to Node's.
    while (process.hrtime.bigint() < restartAt) { guard(); await sleep(500) }
    const before = await api('watch', `incidents/${incidentId}`)
    acknowledgement = { requestId: `wd-${Date.now()}-${randomUUID()}`, incidentId, revision: before.viewRevision, note: 'Synthetic endurance operator reviewed the retained incident; no worker intervention authorized.' }
    receipt = await api('watch', 'acknowledgements', acknowledgement)
    report.original.acknowledgement = { command: acknowledgement, receipt }; report.original.deliveryId = before.delivery.id
    await phase('watchdog_process_outage', { cycleAt: before.cycleAt, attempts: before.attempts, deliveryId: before.delivery.id })
    watchOutage = true; await watch.stop(true)
    await wait(async () => { const lock = await stat(watch.state + '.lock').catch(error => { if (error.code === 'ENOENT') return null; throw error }); return !lock || Date.now() - lock.mtimeMs > 30100 }, 40000, 'watchdog_lock_not_stale')
    await watch.start()
    await wait(async () => { const state = await api('watch', 'status'); return state.monitor?.reachable }, 40000, 'watchdog_not_restored')
    requireFact(JSON.stringify(await api('watch', 'acknowledgements', acknowledgement)) === JSON.stringify(receipt), 'acknowledgement_changed')
    const after = await api('watch', `incidents/${incidentId}`)
    requireFact(after.instance === before.instance && after.observation.assignmentId === before.observation.assignmentId
      && after.observation.episodeRevision === before.observation.episodeRevision, 'task_changed_during_watchdog_restart')
    const reviewExpired = Date.now() >= before.cycleAt + settings.reviewEveryMs
    if (!reviewExpired) requireFact(after.cycleAt === before.cycleAt && after.attempts === before.attempts && after.delivery.id === before.delivery.id, 'same_cycle_budget_or_delivery_changed')
    else requireFact(after.cycleAt >= before.cycleAt, 'review_cycle_regressed')
    watchOutage = false; await phase('watchdog_restored', { sameCycle: after.cycleAt === before.cycleAt, reviewExpired, cycleAt: after.cycleAt, attempts: after.attempts })
    await wait(async () => (await api('main', `inbox/${item.id}`)).item.status === 'review', Math.max(1000, globalDeadline - Date.now()), 'productive_job_not_settled')
    const verify = async () => {
      const current = await api('main', `tickets/${item.id}`); requireFact(current.assignments.length === 1 && current.assignments[0].id === report.original.assignmentId, 'assignment_changed')
      await readIdentities(); requireFact(identities.length === plan.chunks.length, 'productive_chunk_missing')
      requireFact(await readFile(join(current.directory, 'proof.txt'), 'utf8') === proof, 'proof_mismatch')
      const end = JSON.parse(await readFile(join(current.directory, 'job-end.json'), 'utf8')), chunks = []
      for (const planned of plan.chunks) {
        const start = identities[planned.index], finish = JSON.parse(await readFile(join(current.directory, `chunk-${planned.index}-end.json`), 'utf8'))
        const exit = JSON.parse(await readFile(join(current.directory, `chunk-${planned.index}-exit.json`), 'utf8'))
        requireFact(finish.runId === runId && finish.chunk === planned.index && exit.completed === true && exit.pid === start.pid
          && exit.runId === runId && exit.chunk === planned.index, 'chunk_completion_invalid')
        const monotonicSeconds = Number(BigInt(finish.monotonicNs) - BigInt(start.monotonicNs)) / 1e9
        const wallSeconds = Number(BigInt(finish.wallNs) - BigInt(start.wallNs)) / 1e9
        requireFact(monotonicSeconds >= planned.seconds && wallSeconds >= planned.seconds, 'chunk_productive_duration_short')
        requireFact(finish.firstIndex === (chunks.at(-1)?.end.count ?? 0) && finish.count > finish.firstIndex, 'chunk_sequence_invalid')
        chunks.push({ index: planned.index, plannedSeconds: planned.seconds, start, end: finish, monotonicSeconds, wallSeconds })
      }
      const file = join(current.directory, 'samples.jsonl'); requireFact((await stat(file)).size <= plan.limits.productiveFileBytes, 'productive_file_limit')
      let count = 0, previous = '', mono = BigInt(workerStart.monotonicNs), wall = BigInt(workerStart.wallNs), maximumMonotonicGapMs = 0, maximumWallGapMs = 0
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        requireFact(line.length <= 1024, 'productive_sample_line_limit')
        const sample = JSON.parse(line), next = sha(String(count) + ':' + previous), m = BigInt(sample.monotonicNs), w = BigInt(sample.wallNs), chunk = chunks[sample.chunk]
        requireFact(chunk && sample.index >= chunk.end.firstIndex && sample.index < chunk.end.count && m >= BigInt(chunk.start.monotonicNs)
          && m <= BigInt(chunk.end.monotonicNs) && w >= BigInt(chunk.start.wallNs) && w <= BigInt(chunk.end.wallNs), 'sample_outside_chunk')
        requireFact(sample.index === count && sample.sha256 === next && m > mono && w > wall, 'productive_sequence_invalid')
        maximumMonotonicGapMs = Math.max(maximumMonotonicGapMs, Number(m - mono) / 1e6)
        maximumWallGapMs = Math.max(maximumWallGapMs, Number(w - wall) / 1e6)
        if (sample.index === chunk.end.count - 1) requireFact(sample.sha256 === chunk.end.lastSha256, 'chunk_hash_tail_invalid')
        previous = next; count++; mono = m; wall = w; requireFact(count <= durationSeconds + plan.chunks.length * 2, 'productive_sample_count_limit')
      }
      const monotonicSeconds = Number(BigInt(end.monotonicNs) - BigInt(workerStart.monotonicNs)) / 1e9, wallSeconds = Number(BigInt(end.wallNs) - BigInt(workerStart.wallNs)) / 1e9
      const productiveMonotonicSeconds = chunks.reduce((sum, value) => sum + value.monotonicSeconds, 0), productiveWallSeconds = chunks.reduce((sum, value) => sum + value.wallSeconds, 0)
      requireFact(BigInt(end.monotonicNs) >= mono && BigInt(end.wallNs) >= wall && JSON.stringify(end) === JSON.stringify(chunks.at(-1).end), 'productive_end_precedes_sample')
      maximumMonotonicGapMs = Math.max(maximumMonotonicGapMs, Number(BigInt(end.monotonicNs) - mono) / 1e6)
      maximumWallGapMs = Math.max(maximumWallGapMs, Number(BigInt(end.wallNs) - wall) / 1e6)
      requireFact(productiveMonotonicSeconds >= durationSeconds && productiveWallSeconds >= durationSeconds && count === end.count && previous === end.lastSha256, 'productive_duration_or_tail_invalid')
      requireFact(count >= Math.floor(durationSeconds / 10), 'insufficient_productive_samples')
      requireFact(maximumMonotonicGapMs <= 10000 && maximumWallGapMs <= 10000, 'productive_gap_exceeded')
      const library = await api('main', 'library'), artifacts = library.items.filter(value => value.provenance.ticketId === item.id)
      requireFact(artifacts.length === 1, 'artifact_replayed_or_missing'); const artifact = artifacts[0]
      requireFact((await api('main', `library/${artifact.id}`)).content === proof && artifact.provenance.assignmentId === report.original.assignmentId, 'artifact_content_or_assignment_mismatch')
      requireFact(artifact.provenance.actor === 'worker' && artifact.provenance.trust === 'agent_submission' && artifact.provenance.sessionId === `worker-${item.id}`, 'artifact_provenance_mismatch')
      const fileSha256 = Object.fromEntries(await Promise.all(['job-start.json', 'job-end.json', 'invocations.jsonl', 'samples.jsonl', 'proof.txt', ...plan.chunks.flatMap(({ index }) => ['start', 'end', 'exit'].map(kind => `chunk-${index}-${kind}.json`))].map(async name => [name, await fileSha(join(current.directory, name))])))
      return { completed: true, workerStart, workerEnd: end, chunks, productiveMonotonicSeconds, productiveWallSeconds, monotonicSeconds, wallSeconds, samples: count, lastSha256: previous,
        maximumMonotonicGapMs, maximumWallGapMs, artifactId: artifact.id, fileSha256 }
    }
    report.progress = await verify(); await phase('productive_job_verified')
    requireFact(provider.snapshot().bash === plan.chunks.length && provider.snapshot().jobOutput === plan.chunks.length && provider.snapshot().nativeWakes === plan.chunks.length && provider.snapshot().publish === 1 && provider.snapshot().report === 1 && provider.snapshot().statusRequests === 0, 'unexpected_worker_actions')
    mainOutage = true; await main.stop(); await phase('settled_main_restart')
    await wait(async () => (await api('watch', 'status')).monitor?.reachable === false, 15000, 'main_outage_not_observed')
    await main.start(); await readyMain(); const repeated = await verify()
    await wait(async () => (await api('watch', 'status')).monitor?.reachable === true, 10000, 'supervision_not_restored'); mainOutage = false
    requireFact(repeated.artifactId === report.progress.artifactId, 'artifact_identity_changed')
    requireFact(JSON.stringify(repeated.fileSha256) === JSON.stringify(report.progress.fileSha256), 'productive_files_changed_during_restart')
    requireFact(JSON.stringify(await api('watch', 'acknowledgements', acknowledgement)) === JSON.stringify(receipt), 'acknowledgement_changed')
    const restored = await api('watch', `incidents/${incidentId}`)
    requireFact(restored.acknowledgement?.requestId === acknowledgement.requestId, 'original_acknowledgement_missing')
    let cursor = null, deliveryFound = false
    for (let page = 0; page < 20; page++) {
      const history = await api('watch', 'history?incident=' + encodeURIComponent(incidentId) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
      deliveryFound ||= history.items.some(value => value.kind === 'delivery_reserved' && value.data?.id === report.original.deliveryId)
      cursor = history.cursor; if (!cursor) break
    }
    requireFact(deliveryFound, 'original_delivery_history_missing'); report.original.deliveryHistoryFound = true
    const finalBuild = await tree(join(snapshot, 'lib'), { hashes: true, limit: 16 * 1024 * 1024 })
    requireFact(JSON.stringify(finalBuild) === JSON.stringify(built), 'snapshot_build_changed')
    const finalAssets = {}
    for (const name of Object.keys(assets)) finalAssets[name] = await tree(join(snapshot, name), { hashes: true, limit: 32 * 1024 * 1024 })
    const finalDependencies = await tree(join(snapshot, 'node_modules'), { hashes: true, ownedLinks: true, limit: 512 * 1024 * 1024 })
    requireFact(sha(JSON.stringify({ assets: finalAssets, dependencies: finalDependencies })) === report.snapshot.manifestSha256, 'snapshot_assets_or_dependencies_changed')
    guard(); report.provider = provider.snapshot(); verified = true; report.state = 'cleaning_up'; await phase('verification_complete_cleanup_pending')
  } catch (error) {
    runFailed = true; report.state = signal?.aborted ? 'cancelled' : 'failed'; report.outcome = 'incomplete_or_unknown'
    report.failure = { stage: report.stage, code: /^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'operator_interrupted_or_failed' }
  } finally {
    clearInterval(sampleTimer); clearTimeout(globalTimer); while (sampling) await sleep(25)
    const errors = []
    leaseActive = false; try { await saveLease() } catch { errors.push('worker_lease_stop_unknown') }
    for (const close of cleanups.reverse()) { try { await close() } catch { errors.push('owned_process_cleanup_failed') } }
    try { await sampleFd?.close() } catch { errors.push('sample_close_failed') }
    let workerQuiescence = workerStart ? 'unknown' : provider?.snapshot().bash ? 'unknown' : 'not_started'
    if (workerStart) {
      try {
        await readIdentities()
        requireFact(identities.length === provider.snapshot().bash, 'launched_worker_identity_missing')
        let absent = false
        for (let attempt = 0; attempt < 30; attempt++) {
          absent = identities.every(identity => { try { process.kill(-identity.pgid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
          if (absent) break
          await sleep(200)
        }
        if (absent) workerQuiescence = 'confirmed_group_absent'
      } catch { errors.push('worker_identity_evidence_changed') }
    }
    if (workerQuiescence === 'unknown') errors.push('fixture_process_quiescence_unknown')
    if (ownershipDigests) {
      try {
        for (const [name, digest] of Object.entries(ownershipDigests)) requireFact(await fileSha(join(ticket.directory, name)) === digest, 'worker_identity_evidence_changed')
      } catch { errors.push('worker_identity_evidence_changed'); workerQuiescence = 'unknown' }
    }
    if (verified) {
      try {
        const finalCounts = provider.snapshot()
        requireFact(finalCounts.bash === plan.chunks.length && finalCounts.jobOutput === plan.chunks.length && finalCounts.nativeWakes === plan.chunks.length && finalCounts.completedChunks === plan.chunks.length && finalCounts.publish === 1 && finalCounts.report === 1 && finalCounts.statusRequests === 0 && finalCounts.failures.length === 0, 'post_cleanup_action_counts_changed')
        for (const [name, digest] of Object.entries(report.progress.fileSha256)) requireFact(await fileSha(join(ticket.directory, name)) === digest, 'post_cleanup_productive_files_changed')
        report.provider = finalCounts; report.progress.postCleanupDigestsVerified = true
      } catch (error) { runFailed = true; report.failure = { stage: 'post_cleanup_verification', code: /^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'post_cleanup_verification_failed' }; verified = false }
    }
    report.cleanup = { state: errors.length ? 'unknown' : 'completed', workerQuiescence, errors }
    if (samplingError) { runFailed = true; report.failure = { stage: 'final_coverage_check', code: /^[a-z0-9_]{1,100}$/.test(samplingError.message) ? samplingError.message : 'internal_observation_failed' } }
    report.state = enduranceCompletionState({ verified, failed: runFailed, aborted: lifetime.aborted, cancelled: signal?.aborted, cleanupConfirmed: !errors.length })
    report.outcome = report.state === 'completed' ? 'qualified_scripted_duration' : 'incomplete_or_unknown'
    if (report.state === 'completed') report.stage = 'completed'
    report.completedAt = new Date().toISOString(); report.runnerElapsedSeconds = (Date.now() - started) / 1000
    await save()
  }
  return { ...report, report: join(root, 'report.json'), exitCode: runFailed || report.state !== 'completed' ? 1 : 0 }
}

async function cli() {
  const args = process.argv.slice(2), flags = new Map(), allowed = new Set(['--execute', '--dsh', '--output', '--duration-seconds', '--chunk-seconds', '--status'])
  for (let index = 0; index < args.length; index++) {
    const name = args[index]; requireFact(allowed.has(name) && !flags.has(name), 'invalid_option')
    if (name === '--execute') flags.set(name, true)
    else { const value = args[++index]; requireFact(value && !value.startsWith('--'), 'missing_option_value'); flags.set(name, value) }
  }
  if (flags.has('--status')) { requireFact(!flags.has('--execute'), 'status_cannot_execute'); console.log(JSON.stringify(await enduranceStatus(flags.get('--status')), null, 2)); return }
  const durationSeconds = flags.has('--duration-seconds') ? Number(flags.get('--duration-seconds')) : 28800
  const chunkSeconds = flags.has('--chunk-seconds') ? Number(flags.get('--chunk-seconds')) : 1200
  if (!flags.has('--execute')) { console.log(JSON.stringify(endurancePlan(durationSeconds, chunkSeconds), null, 2)); return }
  requireFact(flags.has('--dsh') && flags.has('--output'), 'execute_requires_dsh_and_new_output')
  const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try { const result = await runEndurance({ dsh: flags.get('--dsh'), output: flags.get('--output'), durationSeconds, chunkSeconds, signal: controller.signal }); console.log(JSON.stringify({ runId: result.runId, state: result.state, outcome: result.outcome, report: result.report })); process.exitCode = result.exitCode }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli().catch(() => { console.error('Endurance operator could not run. Check its options, qualified Harness CLI and a new output directory. Existing work was not resumed.'); process.exitCode = 1 })
