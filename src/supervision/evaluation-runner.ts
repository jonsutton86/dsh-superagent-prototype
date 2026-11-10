/** Explicit, isolated semantic evaluation through the installed production Harness watchdog. */
import { z } from 'zod'
import { createServer } from 'node:http'
import { createServer as portServer } from 'node:net'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { key } from '../core/ids.ts'
import { AssessmentSchema, InterventionSchema, type Assessment } from './protocol.ts'
import { type CaseOutcome, type EvaluationCase, EvaluationCaseSchema, scoreEvaluationCase, summarizeEvaluation } from './evaluation.ts'
import { evaluationCases, EVALUATION_SUITE_VERSION, EVALUATION_REFERENCE_TIME } from './evaluation-cases.ts'
import { watchdogContractDigest } from './assessment-contract.ts'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)
const modelId = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).refine(value => !['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'ENV', 'BASH_ENV', 'SHELL', 'LD_PRELOAD'].includes(value)
  && !/^(NODE_|DSH_|DYLD_|LD_)/.test(value))
const providerUrl = z.string().max(2000).refine(value => {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1')
  } catch { return false }
})
/** A provider definition only: arbitrary plugin patches, embedded credentials and retry-always policies are rejected. */
export const EvaluationProviderSchema = z.object({
  displayName: z.string().min(1).max(100), api: z.enum(['openai-completions', 'openai-responses']), baseURL: providerUrl,
  apiKeyEnv: environmentName.optional(),
  compat: z.object({ supportsDeveloperRole: z.boolean().optional(), maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    supportsStore: z.boolean().optional(), supportsReasoningEffort: z.boolean().optional() }).strict().optional(),
  retryPolicy: z.object({ mode: z.literal('normal'), maxRetries: z.number().int().min(0).max(5),
    backoff: z.object({ initialDelayMs: z.number().int().min(1).max(10000), maxDelayMs: z.number().int().min(1).max(10000),
      jitterRatio: z.number().min(0).max(1) }).strict().refine(value => value.initialDelayMs <= value.maxDelayMs).optional() }).strict().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(), streamIdleTimeoutMs: z.number().int().min(1000).max(300000).optional(),
  models: z.array(z.object({ id: modelId, name: z.string().min(1).max(120), contextWindow: z.number().int().min(1024).max(2000000),
    maxTokens: z.number().int().min(1).max(8192), input: z.array(z.enum(['text', 'image'])).min(1).max(2), reasoning: z.boolean().optional() }).strict()).min(1).max(32),
}).strict().refine(value => new Set(value.models.map(model => model.id)).size === value.models.length)
export type EvaluationProvider = z.infer<typeof EvaluationProviderSchema>

export function validateEvaluationProvider(value: unknown, provider: string, model: string, credentialEnv?: string): EvaluationProvider {
  if (!id.safeParse(provider).success || !modelId.safeParse(model).success
    || credentialEnv !== undefined && !environmentName.safeParse(credentialEnv).success) throw new Error('Invalid evaluation provider, model or credential environment name')
  const parsed = EvaluationProviderSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid evaluation provider definition; only bounded, key-free provider settings are accepted')
  if (!parsed.data.models.some(entry => entry.id === model)) throw new Error('Evaluation model is absent from the supplied provider definition')
  if (parsed.data.apiKeyEnv !== credentialEnv) throw new Error('Provider apiKeyEnv must match the explicitly selected credential environment name')
  return parsed.data
}

export interface EvaluationRunOptions {
  dsh: string; checkout: string; provider: string; model: string; providerConfig: unknown; credentialEnv?: string; output: string
  cases?: readonly EvaluationCase[]; caseDeadlineMs?: number; maxRequestsPerCase?: number; signal?: AbortSignal
}
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const traceUsage = z.object({ inputTokens: counter, outputTokens: counter, cacheReadTokens: counter.optional(), cacheWriteTokens: counter.optional() }).strict()
const ProbeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), at: counter, ordinal: counter.min(1) }).strict(),
  z.object({ type: z.literal('settled'), at: counter, ordinal: counter.min(1), terminal: z.boolean(), usage: traceUsage.nullable() }).strict(),
  ...(['request_limit', 'stream_limit', 'scope_refused', 'agent/error'] as const).map(type => z.object({ type: z.literal(type), at: counter }).strict()),
  ...(['contract_verified', 'contract_refused'] as const).map(type => z.object({ type: z.literal(type), at: counter,
    version: counter.optional(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()),
  z.object({ type: z.literal('turn/start'), at: counter, turn: counter.min(1) }).strict(),
  z.object({ type: z.literal('turn/end'), at: counter, turn: counter.min(1), reason: z.enum(['completed', 'error', 'blocked', 'max-tokens', 'aborted', 'interrupted', 'forked', 'unknown']) }).strict(),
  z.object({ type: z.literal('tool'), at: counter, name: z.enum(['watchdog_observe', 'watchdog_assess', 'watchdog_request_status', 'other']) }).strict(),
])
type ProbeEvent = z.infer<typeof ProbeEventSchema>
interface CaseRecord { caseId: string; attemptId: string; startedAt: string; trace: string; harnessVersion: string | null }
/** Keeps unreadable or incomplete post-dispatch evidence unsettled instead of inventing a zero-attempt outcome. */
class EvaluationTraceError extends Error {}
export function parseEvaluationTrace(data: string, writerActive: boolean): ProbeEvent[] {
  if (Buffer.byteLength(data) > 1024 * 1024) throw new EvaluationTraceError('Evaluation trace exceeded its bound')
  const lines = data.split('\n')
  if (lines.at(-1) === '') lines.pop()
  else if (writerActive) lines.pop()
  else throw new EvaluationTraceError('Evaluation trace has an incomplete final record')
  try {
    const events = lines.map(line => ProbeEventSchema.parse(JSON.parse(line))), requests = new Set<number>(), settled = new Set<number>()
    for (const event of events) {
      if (event.type === 'request') { if (event.ordinal !== requests.size + 1) throw new Error(); requests.add(event.ordinal) }
      if (event.type === 'settled') { if (!requests.has(event.ordinal) || settled.has(event.ordinal)) throw new Error(); settled.add(event.ordinal) }
    }
    return events
  } catch { throw new EvaluationTraceError('Evaluation trace metadata is invalid') }
}
/** Reconcile the sealed probe with a poll result: HTTP failure may arrive after that poll's trace snapshot. */
export function evaluationStatusFromFinalTrace(status: CaseOutcome['status'], events: readonly ProbeEvent[]): CaseOutcome['status'] {
  if (status === 'cancelled') return status
  if (!events.some(event => event.type === 'contract_verified' && event.digest === watchdogContractDigest())
    || events.some(event => event.type === 'scope_refused' || event.type === 'contract_refused')) return 'startup_error'
  if (status === 'deadline') return status
  if (events.some(event => event.type === 'stream_limit')) return 'response_limit'
  if (events.some(event => event.type === 'request_limit')) return 'request_limit'
  return status
}
export function selectSupervisionEvaluationCases(ids?: readonly string[]): readonly EvaluationCase[] {
  if (ids === undefined) return evaluationCases
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Evaluation case selection must be nonempty and distinct')
  return ids.map(id => { const value = evaluationCases.find(value => value.id === id); if (!value) throw new Error('Unknown evaluation case'); return value })
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const syncDirectory = async (path: string) => { const directory = await open(path, 'r'); try { await directory.sync() } finally { await directory.close() } }
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const boundedInteger = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max
export function supervisionEvaluationPlan(cases: readonly EvaluationCase[] = evaluationCases, maxRequestsPerCase = 6) {
  if (!boundedInteger(maxRequestsPerCase, 1, 20)) throw new Error('Evaluation request limit must be between 1 and 20')
  return { version: 1, mode: 'plan', suiteVersion: EVALUATION_SUITE_VERSION, provenance: 'curated_synthetic', cases: cases.map(value => ({ id: value.id, title: value.title })),
    caseCount: cases.length, maxModelAttemptsPerCase: maxRequestsPerCase, maximumModelAttempts: cases.length * maxRequestsPerCase, modelTraffic: false,
    executionRequires: '--execute, --dsh, --provider-config, --provider, --model and a new --output directory',
    interpretation: 'A curated evaluation with manual evidence review; it does not establish universal diagnosis quality.' }
}
function usageOf(events: ProbeEvent[]): CaseOutcome['usage'] {
  const requests = events.filter(event => event.type === 'request'), settled = new Map(events.filter(event => event.type === 'settled').map(event => [event.ordinal, event]))
  const records = requests.map(event => settled.get(event.ordinal)), reported = records.filter(event => event?.usage)
  const sum = (field: keyof z.infer<typeof traceUsage>) => records.length && records.every(event => typeof event?.usage?.[field] === 'number')
    ? records.reduce((total, event) => total + (event!.usage![field] as number), 0) : null
  return { availability: records.length && records.every(event => event?.terminal && event.usage) ? 'reported' : reported.length ? 'partial' : 'unavailable',
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens') }
}
function redactAssessment(value: Assessment | null, secrets: string[]): { assessment: Assessment | null; redacted: boolean } {
  if (!value) return { assessment: null, redacted: false }
  let evidence = value.evidence
  for (const secret of secrets.filter(value => value.length > 0)) evidence = evidence.split(secret).join('[redacted]')
  evidence = evidence.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*["']?[^\s,"'}]+/gi, '[credential redacted]')
  return { assessment: { ...value, evidence }, redacted: evidence !== value.evidence }
}
async function unusedPort(): Promise<number> {
  const server = portServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve())); return port
}
function rebaseCase(value: EvaluationCase, now: number): EvaluationCase {
  const result = structuredClone(value)
  if (result.scenario.kind === 'snapshot') {
    const delta = now - Date.parse(EVALUATION_REFERENCE_TIME), shift = (value: string) => new Date(Date.parse(value) + delta).toISOString()
    result.scenario.observation.updatedAt = shift(result.scenario.observation.updatedAt)
    if (result.scenario.observation.report) result.scenario.observation.report.at = shift(result.scenario.observation.report.at)
  }
  return result
}
async function runCase(original: EvaluationCase, options: EvaluationRunOptions, definition: EvaluationProvider,
  credential: string | undefined, limits: { caseDeadlineMs: number; maxRequestsPerCase: number }, record: CaseRecord, metadataChanged: () => Promise<void>): Promise<CaseOutcome> {
  const started = Date.now(), value = rebaseCase(original, started), directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh supervision evaluation ')))
  const home = join(directory, 'user-home'), root = join(directory, 'runtime'), state = join(directory, 'watchdog'), trace = join(options.output, record.trace)
  const profile = 'supervision-evaluation-' + randomUUID(), token = randomUUID() + randomUUID(), tokenFile = join(directory, 'main.token')
  const environment = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
  const lifetime = new AbortController(), timeout = setTimeout(() => lifetime.abort(), limits.caseDeadlineMs)
  const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])])
  let child: ChildProcess | undefined, status: CaseOutcome['status'] = 'startup_error', observations = 0, interventions = 0
  let monitorReachable: boolean | null = null, incident: CaseOutcome['incident'] = null, assessment: Assessment | null = null, assessmentAt: number | null = null
  let events: ProbeEvent[] = [], ready = false, spawnFailed = false, statusUrl: string | undefined
  const observation = value.scenario.kind === 'snapshot' ? value.scenario.observation : null
  const main = createServer(async (request, response) => { try {
    if (request.headers.authorization !== `Bearer ${token}` || request.headers['x-orchestrator-request'] !== '1') { response.writeHead(403); response.end(); return }
    if (request.method === 'GET' && request.url === '/orchestrator/api/supervision') {
      observations++
      if (!observation) { response.writeHead(503); response.end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ instance: 'synthetic-main', at: new Date().toISOString(),
        configured: true, paused: false, version: 'synthetic-snapshot', tickets: [observation], nextOffset: null, total: 1, health: { runtime: { state: 'ready' } } })); return
    }
    if (request.method === 'POST' && request.url === '/orchestrator/api/supervision/intervene') {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8192) { response.writeHead(413); response.end(); return } }
      let accepted = false
      try { const input = InterventionSchema.parse(JSON.parse(body)); accepted = input.instance === 'synthetic-main' && input.ticketId === observation?.id && input.revision === observation?.revision }
      catch { /* The inert endpoint cannot acquire real worker authority. */ }
      if (accepted) interventions++
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ accepted, reason: accepted ? 'synthetic_status_recorded' : 'synthetic_request_refused' })); return
    }
    response.writeHead(404); response.end()
  } catch { if (!response.headersSent) response.writeHead(400); response.end() }
  })
  const stop = async () => {
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return
    const active = child, done = new Promise<void>(resolve => active.once('exit', () => resolve()))
    active.kill('SIGINT'); const kill = setTimeout(() => active.kill('SIGKILL'), 5000)
    try { await done } finally { clearTimeout(kill) }
  }
  const readTrace = async (writerActive = true) => {
    const data = await readFile(trace, 'utf8').catch(() => { throw new EvaluationTraceError('Evaluation trace unavailable') })
    return parseEvaluationTrace(data, writerActive)
  }
  const readStatus = async () => {
    if (!statusUrl) return
    const response = await fetch(statusUrl, { headers: { 'x-orchestrator-request': '1' }, redirect: 'error', signal: AbortSignal.timeout(1500) })
    if (!response.ok || !response.body) { await response.body?.cancel(); return }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length
        if (size > 1024 * 1024) throw new Error('Evaluation status exceeds its bound'); chunks.push(part.value) }
      const current = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { monitor?: { reachable?: boolean; modelError?: string }; incidents?: { id: string; revision: string; assessment?: unknown }[] }
      ready = true; monitorReachable = current.monitor?.reachable ?? null
      const entry = current.incidents?.find(entry => entry.assessment !== undefined) ?? current.incidents?.[0]
      if (entry) {
        incident = { id: entry.id, revision: entry.revision }
        const parsed = AssessmentSchema.safeParse(entry.assessment)
        if (parsed.success) { assessment = parsed.data; assessmentAt ??= Date.now() }
      }
      return current
    } finally { await reader.cancel() }
  }
  try {
    await mkdir(home, { mode: 0o700 }); await writeFile(tokenFile, token, { mode: 0o600 })
    await new Promise<void>(resolve => main.listen(0, '127.0.0.1', resolve))
    const mainUrl = `http://127.0.0.1:${(main.address() as { port: number }).port}`, port = await unusedPort()
    const installed = await promisify(execFile)('python3', [join(options.checkout, 'scripts/agentic-os'), 'init', '--directory', root, '--role', 'workspace', '--checkout', options.checkout,
      '--dsh', options.dsh, '--profile', profile, '--port', String(port)], { cwd: directory, env: { ...environment, HOME: home }, signal, timeout: limits.caseDeadlineMs, maxBuffer: 1024 * 1024 })
    const installation = JSON.parse(installed.stdout) as { installed?: boolean; version?: string }
    if (installation.installed !== true || installation.version !== '0.2.1-rc.3') throw new Error('Evaluation requires the qualified installed Harness version')
    record.harnessVersion = installation.version; await metadataChanged()
    const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')) as unknown[], patch = join(directory, 'evaluation.json'), shim = join(directory, 'network-boundary.mjs')
    const providerOrigin = new URL(definition.baseURL).origin
    await writeFile(shim, `const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==${JSON.stringify(providerOrigin)}&&!(url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw new Error('Evaluation blocked unrelated fetch');return original(input,{...init,redirect:'error'})};\n`, { mode: 0o600 })
    await writeFile(patch, JSON.stringify([...launch,
      { id: 'dsh-superagent', disabled: true }, { id: 'dsh-superagent-sources', disabled: true }, { id: 'session-title-llm', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { [options.provider]: { ...definition, retryPolicy: definition.retryPolicy ?? { mode: 'normal', maxRetries: 0 } } } } },
      { id: 'agent-default-model', config: { provider: options.provider, model: options.model } },
      { insert: [
        { id: 'evaluation-probe', name: pathToFileURL(join(options.checkout, 'lib/supervision-evaluation-probe.js')).href,
          config: { sessionId: `watchdog-${key(state)}`, trace, maxRequests: limits.maxRequestsPerCase, expectedContract: watchdogContractDigest() } },
        { id: 'watchdog-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'dsh-superagent-watchdog', name: 'Isolated evaluation assessor', plugins: [] } },
        { id: 'watchdog', name: 'dsh-superagent/watchdog', config: { stateDir: state, tokenFile, url: mainUrl, pollMs: 1000, staleMs: 1000,
          evaluationContract: watchdogContractDigest(), reviewEveryMs: 86400000, retryMs: 3600000,
          assessmentTimeoutMs: Math.min(300000, limits.caseDeadlineMs), model: { provider: options.provider, model: options.model } } },
      ] },
    ]), { mode: 0o600 })
    child = spawn(options.dsh, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: directory,
      env: { ...environment, HOME: home, DSH_HOME: join(root, 'home'), NODE_OPTIONS: `--import=${pathToFileURL(shim).href}`,
        ...(options.credentialEnv && credential ? { [options.credentialEnv]: credential } : {}) }, stdio: 'ignore' })
    child.on('error', () => { spawnFailed = true })
    statusUrl = `http://127.0.0.1:${port}/watchdog/api/status`
    while (!signal.aborted) {
      events = await readTrace()
      const current = await readStatus().catch(() => undefined)
      if (events.some(event => event.type === 'stream_limit')) { status = 'response_limit'; break }
      if (events.some(event => event.type === 'request_limit')) { status = 'request_limit'; break }
      if (events.some(event => event.type === 'scope_refused' || event.type === 'contract_refused')) { status = 'startup_error'; break }
      if (events.some(event => event.type === 'agent/error')) { status = 'provider_error'; break }
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) { status = ready ? 'provider_error' : 'startup_error'; break }
      if (current) {
          if (current.monitor?.modelError) { status = 'provider_error'; break }
          if (value.scenario.kind === 'unavailable' && observations >= 2 && monitorReachable === false
            && events.some(event => event.type === 'contract_verified' && event.digest === watchdogContractDigest())) { status = 'no_assessment'; break }
          const ended = events.findLast(event => event.type === 'turn/end')
          if (ended) { status = ended.reason === 'completed' ? assessment ? 'assessed' : 'no_assessment' : 'turn_incomplete'; break }
      }
      await pause(50)
    }
    if (signal.aborted) status = options.signal?.aborted ? 'cancelled' : 'deadline'
  } catch (error) {
    if (error instanceof EvaluationTraceError) throw error
    status = options.signal?.aborted ? 'cancelled' : lifetime.signal.aborted ? 'deadline' : 'startup_error'
  }
  finally {
    clearTimeout(timeout); await readStatus().catch(() => undefined); await stop()
    let traceInvalid = false
    try { events = await readTrace(false) } catch { traceInvalid = true }
    main.closeAllConnections(); await new Promise<void>(resolve => main.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    if (traceInvalid) throw new EvaluationTraceError('Evaluation outcome remains unsettled because its trace is invalid')
  }
  status = evaluationStatusFromFinalTrace(status, events)
  const redacted = redactAssessment(assessment, [token, ...(credential ? [credential] : [])])
  return { caseId: value.id, status, turnEnd: events.findLast(event => event.type === 'turn/end')?.reason ?? null,
    incident, assessment: redacted.assessment, monitorReachable, modelAttempts: events.filter(event => event.type === 'request').length,
    turns: events.filter(event => event.type === 'turn/start').length,
    statusRequests: { attempted: events.filter(event => event.type === 'tool' && event.name === 'watchdog_request_status').length, accepted: interventions },
    otherToolCalls: events.filter(event => event.type === 'tool' && event.name === 'other').length, usage: usageOf(events),
    latencyMs: Date.now() - started, assessmentLatencyMs: assessmentAt === null ? null : assessmentAt - started, redacted: redacted.redacted }
}

/** Never resumes old paid calls: a pre-existing output directory is always refused. */
export async function runSupervisionEvaluation(options: EvaluationRunOptions) {
  const definition = validateEvaluationProvider(options.providerConfig, options.provider, options.model, options.credentialEnv)
  const limits = { caseDeadlineMs: options.caseDeadlineMs ?? 60000, maxRequestsPerCase: options.maxRequestsPerCase ?? 6 }
  if (!boundedInteger(limits.caseDeadlineMs, 3000, 300000) || !boundedInteger(limits.maxRequestsPerCase, 1, 20)) throw new Error('Evaluation limits are outside their supported bounds')
  const cases = (options.cases ?? evaluationCases).map(value => EvaluationCaseSchema.parse(value))
  if (!cases.length || cases.length > 100 || new Set(cases.map(value => value.id)).size !== cases.length) throw new Error('Evaluation cases must have distinct identifiers and a bounded nonempty count')
  const credential = options.credentialEnv ? process.env[options.credentialEnv] : undefined
  if (options.credentialEnv && (!credential || credential.length > 8192)) throw new Error('The explicitly selected evaluation credential is unavailable')
  const checkout = await realpath(options.checkout), dsh = await realpath(options.dsh), output = resolve(options.output)
  const artifactHashes = async () => {
    const result: Record<string, string> = {}
    for (const file of (await readdir(join(checkout, 'lib'))).filter(file => file.endsWith('.js')).sort()) result[file] = digest(await readFile(join(checkout, 'lib', file)))
    return result
  }
  const artifacts = await artifactHashes()
  for (const required of ['watchdog.js', 'supervision-evaluation-probe.js']) if (!artifacts[required]) throw new Error('Build the evaluation and production watchdog artifacts before execution')
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: checkout, maxBuffer: 1024 * 1024 })).stdout.trim()
  const source = { revision: await git('rev-parse', 'HEAD'), dirty: Boolean(await git('status', '--porcelain', '--untracked-files=normal')) }
  await mkdir(output, { mode: 0o700 })
  const startedAt = new Date().toISOString(), outcomes: CaseOutcome[] = [], caseRecords: CaseRecord[] = []
  let inFlightCase: CaseRecord | null = null
  const integrity = { status: 'verified' as 'verified' | 'invalidated', checkedAt: new Date().toISOString(), reason: null as string | null }
  const checkIntegrity = async () => {
    integrity.checkedAt = new Date().toISOString()
    try { if (JSON.stringify(await artifactHashes()) === JSON.stringify(artifacts)) return true } catch { /* Missing artifacts invalidate the same run. */ }
    integrity.status = 'invalidated'; integrity.reason = 'Built JavaScript changed during evaluation; recorded outcomes are retained but not scored.'; return false
  }
  const sourceFiles = ['src/supervision/evaluation.ts', 'src/supervision/evaluation-cases.ts', 'src/supervision/evaluation-runner.ts',
    'src/supervision/evaluation-probe.ts', 'src/supervision/assessment-contract.ts', 'src/supervision/plugin.ts']
  const progress = () => ({ startedCases: caseRecords.length, settledCases: outcomes.length, unsettledCases: caseRecords.length - outcomes.length, notStartedCases: cases.length - caseRecords.length })
  const report = (completed = false) => ({ version: 1, suiteVersion: EVALUATION_SUITE_VERSION, provenance: 'curated_synthetic', startedAt,
    completedAt: completed ? new Date().toISOString() : null, state: integrity.status === 'invalidated' ? 'invalidated' : completed ? 'completed' : 'partial', source, builtArtifacts: artifacts, integrity,
    sourceFiles, suiteSha256: digest(JSON.stringify(cases)), providerConfigurationSha256: digest(JSON.stringify(definition)), caseDefinitions: cases,
    watchdogContractDigest: watchdogContractDigest(), model: { provider: options.provider, model: options.model },
    limits: { caseDeadlineMs: limits.caseDeadlineMs, maxModelAttemptsPerCase: limits.maxRequestsPerCase },
    runProgress: progress(),
    inFlightCase, caseRecords, recovery: 'An in-flight case after interruption has an unknown outcome. Retained traces are evidence only; this runner never resumes or replays a previous output directory.',
    plannedCaseIds: cases.map(value => value.id), outcomes, scoredCases: integrity.status === 'verified' ? outcomes.map(outcome => scoreEvaluationCase(cases.find(value => value.id === outcome.caseId)!, outcome)) : [],
    summary: integrity.status === 'verified' ? summarizeEvaluation(cases, outcomes, inFlightCase ? [inFlightCase.caseId] : []) : null, manualEvidenceReview: 'pending',
    interpretation: 'Curated synthetic cases measure this run only. Rubric evidence needs manual review; no universal diagnosis-quality pass is claimed.' })
  const persist = async (completed = false) => {
    const temporary = join(output, 'report.json.tmp'), destination = join(output, 'report.json'), file = await open(temporary, 'w', 0o600)
    try { await file.writeFile(JSON.stringify(report(completed), null, 2) + '\n'); await file.sync() } finally { await file.close() }
    await rename(temporary, destination)
    await syncDirectory(output)
  }
  await mkdir(join(output, 'cases'), { mode: 0o700 }); await persist()
  for (const value of cases) {
    if (options.signal?.aborted) break
    if (!await checkIntegrity()) { await persist(); break }
    const attemptId = randomUUID(), record: CaseRecord = { caseId: value.id, attemptId, startedAt: new Date().toISOString(), trace: `cases/${attemptId}/trace.jsonl`, harnessVersion: null }
    await mkdir(join(output, 'cases', attemptId), { mode: 0o700 }); await writeFile(join(output, record.trace), '', { mode: 0o600 })
    await syncDirectory(join(output, 'cases', attemptId)); await syncDirectory(join(output, 'cases'))
    inFlightCase = record; caseRecords.push(record); await persist()
    try { outcomes.push(await runCase(value, { ...options, checkout, dsh, output }, definition, credential, limits, record, () => persist())) }
    catch { await persist(); break } // Retain the original in-flight intent and trace: a failed collector/cleanup cannot invent zero calls.
    inFlightCase = null; await persist()
    if (outcomes.at(-1)?.status === 'cancelled') break
  }
  await checkIntegrity()
  const completed = outcomes.length === cases.length && !options.signal?.aborted && integrity.status === 'verified'
  await persist(completed)
  return { ...report(completed), output: join(output, 'report.json') }
}
