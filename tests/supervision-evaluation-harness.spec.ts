import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { runSupervisionEvaluation, supervisionEvaluationPlan, validateEvaluationProvider, parseEvaluationTrace, selectSupervisionEvaluationCases, evaluationStatusFromFinalTrace } from '../src/supervision/evaluation-runner.ts'
import { watchdogContractDigest } from '../src/supervision/assessment-contract.ts'
import { type EvaluationCase, CaseOutcomeSchema } from '../src/supervision/evaluation.ts'
import { EVALUATION_REFERENCE_TIME } from '../src/supervision/evaluation-cases.ts'
import { supervisionEvaluationProvider } from './fixtures/supervision-evaluation-provider.ts'

const definition = (url = 'https://provider.invalid/v1') => ({ displayName: 'Synthetic fixture', api: 'openai-completions', baseURL: url,
  apiKeyEnv: 'SUPERVISION_EVALUATION_FIXTURE_KEY', compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }, retryPolicy: { mode: 'normal', maxRetries: 0 },
  models: ['scripted', 'looping', 'provider-error', 'post-assessment-error', 'incomplete', 'oversized', 'hanging'].map(id => ({ id, name: 'Synthetic model', contextWindow: 131072, maxTokens: 1024, input: ['text'] })) })
const testCase: EvaluationCase = { id: 'acceptance-hidden-id', title: 'HIDDEN_EXPECTATION_TITLE', tags: ['hidden-rubric-tag'], description: 'HIDDEN_DESCRIPTION',
  sourceReferences: ['HIDDEN_REFERENCE'], scenario: { kind: 'snapshot', observation: { id: 't-fixture', assignmentId: 'a-fixture', revision: 'observation-fixture',
    title: 'Prepare the local report', scope: 'Summarize the supplied measurements.', stage: 'working',
    updatedAt: new Date(Date.parse(EVALUATION_REFERENCE_TIME) - 1800000).toISOString(), canNudge: true,
    report: { state: 'waiting', summary: 'The worker reports it is idle awaiting a status check, with no work continuing.', at: new Date(Date.parse(EVALUATION_REFERENCE_TIME) - 1800000).toISOString() } } },
  expectation: { kind: 'assessment', acceptableFindings: ['stalled'], statusRequest: 'at_most_once', evidenceRubric: ['HIDDEN_EVIDENCE_RUBRIC'] } }
const outage: EvaluationCase = { id: 'acceptance-outage', title: 'Outage control', tags: ['outage'], description: 'Initial service unavailable', sourceReferences: ['src/supervision/client.ts'],
  scenario: { kind: 'unavailable' }, expectation: { kind: 'no_assessment', evidenceRubric: ['No inference while the service is unavailable.'] } }

it('plans evaluation without model traffic and labels model-attempt limits truthfully', () => {
  expect(supervisionEvaluationPlan([testCase, outage], 3)).toMatchObject({ mode: 'plan', modelTraffic: false, caseCount: 2, maxModelAttemptsPerCase: 3, maximumModelAttempts: 6 })
  expect(() => supervisionEvaluationPlan([testCase], 0)).toThrow()
  expect(selectSupervisionEvaluationCases(['stale-report-only']).map(value => value.id)).toEqual(['stale-report-only'])
  expect(() => selectSupervisionEvaluationCases(['missing'])).toThrow()
  expect(() => selectSupervisionEvaluationCases(['stale-report-only', 'stale-report-only'])).toThrow()
})
it('validates every complete trace record and preserves uncertainty for only an actively written final fragment', () => {
  const valid = JSON.stringify({ type: 'request', ordinal: 1, at: 1 }) + '\n'
  expect(parseEvaluationTrace(valid + '{"type":', true)).toHaveLength(1)
  for (const [data, active] of [[valid + '{"type":', false], [valid + 'invalid\n', true], [valid + valid, false],
    [JSON.stringify({ type: 'settled', ordinal: 1, at: 2, terminal: true, usage: null }) + '\n', false],
    [JSON.stringify({ type: 'request', ordinal: 1, at: 1, rawCredential: 'never accepted' }) + '\n', false]] as const)
    expect(() => parseEvaluationTrace(data, active)).toThrow()
})
it('retains the sealed limit cause when an HTTP error overtakes the trace poll without erasing cancellation, deadline or contract failure', () => {
  const verified = { type: 'contract_verified' as const, at: 1, digest: watchdogContractDigest() }
  const stream = { type: 'stream_limit' as const, at: 2 }, requests = { type: 'request_limit' as const, at: 2 }
  expect(evaluationStatusFromFinalTrace('provider_error', [verified, stream])).toBe('response_limit')
  expect(evaluationStatusFromFinalTrace('provider_error', [verified, requests])).toBe('request_limit')
  expect(evaluationStatusFromFinalTrace('provider_error', [verified])).toBe('provider_error')
  expect(evaluationStatusFromFinalTrace('provider_error', [stream])).toBe('startup_error')
  expect(evaluationStatusFromFinalTrace('provider_error', [verified, stream, { type: 'scope_refused', at: 3 }])).toBe('startup_error')
  expect(evaluationStatusFromFinalTrace('cancelled', [stream])).toBe('cancelled')
  expect(evaluationStatusFromFinalTrace('deadline', [verified, stream])).toBe('deadline')
})
it('accepts only a bounded key-free provider definition and the explicitly selected credential name', () => {
  expect(validateEvaluationProvider(definition(), 'fixture', 'scripted', 'SUPERVISION_EVALUATION_FIXTURE_KEY')).toMatchObject({ api: 'openai-completions' })
  for (const change of [{ apiKey: 'private' }, { insert: [] }, { baseURL: 'https://user:password@provider.invalid/v1' }, { baseURL: 'http://provider.invalid/v1' },
    { baseURL: 'https://provider.invalid/v1?key=secret' }, { retryPolicy: { mode: 'always' } }, { apiKeyEnv: 'NODE_OPTIONS' },
    { models: [{ id: 'scripted', name: 'Unbounded', contextWindow: 131072, maxTokens: 999999, input: ['text'] }] }])
    expect(() => validateEvaluationProvider({ ...definition(), ...change }, 'fixture', 'scripted', 'SUPERVISION_EVALUATION_FIXTURE_KEY')).toThrow()
  expect(() => validateEvaluationProvider(definition(), 'fixture', 'scripted', undefined)).toThrow()
  expect(() => validateEvaluationProvider(definition(), 'fixture', 'missing', 'SUPERVISION_EVALUATION_FIXTURE_KEY')).toThrow()
})

it.runIf(process.env.DSH_SUPERVISION_EVALUATION_QUALIFICATION === '1')('qualifies actual isolated watchdog assessment, limits, usage and incomplete outcomes using only a loopback provider', async () => {
  const cli = process.env.DSH_SUPERVISION_EVALUATION_QUALIFICATION_CLI ?? process.env.DSH_ENDPOINT_QUALIFICATION_CLI ?? process.env.DSH_WATCHDOG_QUALIFICATION_CLI
  if (!cli) throw new Error('Supply an installed Harness qualification CLI')
  const directory = await mkdtemp(join(tmpdir(), 'dsh evaluation acceptance ')), provider = await supervisionEvaluationProvider()
  const credentialEnv = 'SUPERVISION_EVALUATION_FIXTURE_KEY', previous = process.env[credentialEnv]
  let passed = false
  process.env[credentialEnv] = provider.providerKey
  try {
    const plan = await promisify(execFile)(process.execPath, [resolve('scripts/supervision-eval.mjs')], { cwd: directory, env: { PATH: process.env.PATH }, timeout: 10000 })
    expect(JSON.parse(plan.stdout)).toMatchObject({ mode: 'plan', modelTraffic: false }); expect(provider.requests).toHaveLength(0)
    const base = { checkout: resolve('.'), dsh: cli, provider: 'fixture', providerConfig: definition(provider.url), credentialEnv, caseDeadlineMs: 30000 }
    const output = join(directory, 'accepted'); let intent: Promise<any> | undefined
    provider.onRequest(() => { intent ??= readFile(join(output, 'report.json'), 'utf8').then(value => JSON.parse(value)) })
    const report = await runSupervisionEvaluation({ ...base, output, model: 'scripted', cases: [testCase, outage] })
    provider.onRequest()
    expect(await intent).toMatchObject({ state: 'partial', inFlightCase: { caseId: testCase.id, harnessVersion: '0.2.1-rc.3' } })
    expect(report.inFlightCase).toBeNull(); expect(report.integrity.status).toBe('verified'); expect(report.caseDefinitions).toEqual([testCase, outage])
    for (const record of report.caseRecords) {
      expect(record.harnessVersion).toBe('0.2.1-rc.3')
      const trace = await readFile(join(output, record.trace), 'utf8')
      expect(parseEvaluationTrace(trace, false).some(event => event.type === 'contract_verified')).toBe(true)
      expect(trace).not.toContain(provider.providerKey); expect((await stat(join(output, record.trace))).mode & 0o077).toBe(0)
    }
    expect(report.state).toBe('completed'); expect(report.summary?.semanticQualityQualified).toBe(false)
    expect(report.manualEvidenceReview).toBe('pending'); expect(report.summary?.pendingEvidenceReviews).toBe(1)
    expect(report.summary?.operationalControls).toEqual({ selected: 1, passed: 1 })
    const assessed = CaseOutcomeSchema.parse(report.outcomes[0]), unavailable = CaseOutcomeSchema.parse(report.outcomes[1])
    expect(assessed).toMatchObject({ status: 'assessed', modelAttempts: 4, turns: 1, monitorReachable: true, redacted: true,
      statusRequests: { attempted: 1, accepted: 1 }, otherToolCalls: 0, usage: { availability: 'reported', inputTokens: 80, outputTokens: 40 } })
    expect(assessed.assessment?.finding).toBe('stalled')
    expect(unavailable).toMatchObject({ status: 'no_assessment', modelAttempts: 0, monitorReachable: false, assessment: null,
      usage: { availability: 'unavailable', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } })
    const saved = await readFile(join(output, 'report.json'), 'utf8')
    expect(saved).not.toContain(provider.providerKey); expect(saved).not.toContain(provider.privateCanary)
    expect(JSON.parse(saved)).toMatchObject({ state: 'completed', provenance: 'curated_synthetic' })
    expect((await stat(output)).mode & 0o077).toBe(0); expect((await stat(join(output, 'report.json'))).mode & 0o077).toBe(0)
    for (const request of provider.requests) for (const secret of [testCase.title, testCase.description, testCase.id, ...testCase.tags, ...testCase.sourceReferences, ...testCase.expectation.evidenceRubric])
      expect(request.body).not.toContain(secret)
    const before = provider.requests.length
    await expect(runSupervisionEvaluation({ ...base, output, model: 'scripted', cases: [testCase] })).rejects.toThrow()
    expect(provider.requests).toHaveLength(before)
    const limited = await runSupervisionEvaluation({ ...base, output: join(directory, 'limited'), model: 'looping', cases: [testCase], maxRequestsPerCase: 2 })
    expect(limited.outcomes[0]).toMatchObject({ status: 'request_limit', modelAttempts: 2, assessment: null })
    expect(provider.requests.filter(request => request.model === 'looping')).toHaveLength(2)
    const failed = await runSupervisionEvaluation({ ...base, output: join(directory, 'failed'), model: 'provider-error', cases: [testCase] })
    expect(failed.outcomes[0]).toMatchObject({ status: 'provider_error', modelAttempts: 1, assessment: null, usage: { availability: 'unavailable', inputTokens: null, outputTokens: null } })
    expect(JSON.stringify(failed)).not.toContain(provider.providerKey); expect(JSON.stringify(failed)).not.toContain(provider.privateCanary)
    const laterFailure = await runSupervisionEvaluation({ ...base, output: join(directory, 'later-failure'), model: 'post-assessment-error', cases: [testCase] })
    expect(laterFailure.outcomes[0]).toMatchObject({ status: 'provider_error', modelAttempts: 3, assessment: { finding: 'stalled' }, redacted: true })
    expect(laterFailure.scoredCases[0]).toMatchObject({ assessmentRecorded: true, assessmentCompleted: false, findingAgreement: null })
    const incomplete = await runSupervisionEvaluation({ ...base, output: join(directory, 'incomplete'), model: 'incomplete', cases: [testCase] })
    expect(incomplete.outcomes[0]).toMatchObject({ status: 'turn_incomplete', turnEnd: 'max-tokens', modelAttempts: 3, assessment: { finding: 'stalled' } })
    expect(incomplete.scoredCases[0]?.assessmentCompleted).toBe(false)
    // Force the observed race: the status response sees the probe failure after this poll already read its trace.
    const fetch = globalThis.fetch; let errorStatusObserved = false, gateReleased = false, releaseOversized!: () => void
    const oversizedGate = new Promise<void>(resolve => { releaseOversized = resolve })
    provider.beforeOversized(() => oversizedGate)
    const delayedStatus = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      let response = await fetch(input, init)
      if (String(input).endsWith('/watchdog/api/status') && response.ok) {
        // No stream_limit can exist in the preceding trace read: its provider bytes are still gated here.
        gateReleased = true; releaseOversized()
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          const current = await response.clone().json() as { monitor?: { modelError?: string } }
          if (current.monitor?.modelError) { errorStatusObserved = true; return response }
          await response.body?.cancel()
          await new Promise(resolve => setTimeout(resolve, 25))
          response = await fetch(input, { ...init, signal: AbortSignal.timeout(2000) })
        }
        await response.body?.cancel(); throw new Error('Fixture did not observe the expected provider failure')
      }
      return response
    })
    try {
      const oversized = await runSupervisionEvaluation({ ...base, output: join(directory, 'oversized'), model: 'oversized', cases: [testCase] })
      expect(errorStatusObserved).toBe(true)
      expect(gateReleased).toBe(true)
      expect(oversized.outcomes[0]).toMatchObject({ status: 'response_limit', modelAttempts: 1, assessment: null })
    } finally { releaseOversized(); provider.beforeOversized(); delayedStatus.mockRestore() }
    const probeOutput = join(directory, 'probe-refused'), requestsBeforeProbe = provider.requests.length
    const refusedProbe = runSupervisionEvaluation({ ...base, output: probeOutput, model: 'scripted', cases: [testCase], caseDeadlineMs: 9000 })
    await vi.waitFor(async () => {
      const intent = JSON.parse(await readFile(join(probeOutput, 'report.json'), 'utf8'))
      expect(intent.inFlightCase?.trace).toBeTruthy()
      // Fault injection only in this owned disposable trace: the actual probe must refuse unsafe permissions.
      await chmod(join(probeOutput, intent.inFlightCase.trace), 0o644)
    }, { timeout: 5000, interval: 20 })
    const refusal = await refusedProbe
    expect(refusal.outcomes[0]).toMatchObject({ status: 'startup_error', modelAttempts: 0, assessment: null })
    expect(provider.requests).toHaveLength(requestsBeforeProbe)
    const deadline = await runSupervisionEvaluation({ ...base, output: join(directory, 'deadline'), model: 'hanging', cases: [testCase], caseDeadlineMs: 9000 })
    expect(deadline.outcomes[0]).toMatchObject({ status: 'deadline', modelAttempts: 1, assessment: null, usage: { availability: 'unavailable', inputTokens: null } })
    const controller = new AbortController(); provider.onRequest(() => controller.abort())
    const cancelled = await runSupervisionEvaluation({ ...base, output: join(directory, 'cancelled'), model: 'hanging', cases: [testCase, outage], signal: controller.signal })
    expect(cancelled.state).toBe('partial'); expect(cancelled.outcomes[0]?.status).toBe('cancelled'); expect(cancelled.runProgress.notStartedCases).toBe(1)
    expect(JSON.parse(await readFile(join(directory, 'cancelled/report.json'), 'utf8'))).toMatchObject({ state: 'partial', runProgress: { notStartedCases: 1 } })
    expect(provider.failures).toEqual([])
    passed = true
  } finally {
    if (previous === undefined) delete process.env[credentialEnv]; else process.env[credentialEnv] = previous
    await provider.close()
    if (passed) await rm(directory, { recursive: true, force: true })
    else console.warn('EVALUATION_ACCEPTANCE_RETAINED ' + JSON.stringify({ directory }))
  }
}, 240000)
