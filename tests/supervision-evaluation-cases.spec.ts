/** Dataset/schema and real journal-delivery checks, not claims that a model diagnosed these cases correctly. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvaluationCaseSchema, scoreEvaluationCase } from '../src/supervision/evaluation.ts'
import { EVALUATION_REFERENCE_TIME, EVALUATION_SUITE_VERSION, evaluationCases } from '../src/supervision/evaluation-cases.ts'
import { WatchdogJournal } from '../src/supervision/journal.ts'
import { WatchdogMonitor } from '../src/supervision/monitor.ts'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const now = Date.parse(EVALUATION_REFERENCE_TIME)
let directory: string, journal: WatchdogJournal
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'supervision-cases-'))
  journal = new WatchdogJournal(join(directory, 'watchdog.sqlite'))
})
afterEach(() => { journal.close(); rmSync(directory, { recursive: true, force: true }) })

it('versions and validates the curated suite against the runner contract with repository-relative source references', () => {
  expect(EVALUATION_SUITE_VERSION).toBe('1')
  expect(evaluationCases).toHaveLength(16)
  expect(new Set(evaluationCases.map(item => item.id)).size).toBe(evaluationCases.length)
  for (const item of evaluationCases) {
    expect(EvaluationCaseSchema.parse(item)).toEqual(item)
    expect(item.sourceReferences.length).toBeGreaterThan(0)
    for (const reference of item.sourceReferences) {
      expect(reference).not.toMatch(/^(?:\/|\.\.|[a-z]+:)/i)
      expect(existsSync(join(repository, reference)), reference).toBe(true)
    }
  }
})

describe('real incident delivery contains only the synthetic scenario', () => {
  for (const item of evaluationCases) if (item.scenario.kind === 'snapshot') it(item.id, () => {
    if (item.scenario.kind !== 'snapshot') throw new Error('Expected a snapshot case')
    const observation = structuredClone(item.scenario.observation)
    journal.reconcile({ instance: 'test-instance', at: EVALUATION_REFERENCE_TIME, configured: true, paused: false,
      version: 'test-snapshot', tickets: [observation], health: {} }, now, 15 * 60_000, 60 * 60_000)
    expect(journal.open()).toHaveLength(1)
    const incident = journal.open()[0]!, reserved = journal.reserve(incident.id, now, 300_000)!
    const text = reserved.delivery!.text
    expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toEqual({ id: incident.id, revision: incident.revision, observation })
    expect(text).not.toContain(item.id)
    expect(text).not.toContain(item.description)
    expect(text).not.toContain(JSON.stringify(item.expectation))
    for (const rubric of item.expectation.evidenceRubric) expect(text).not.toContain(rubric)
    expect(journal.open()[0]!.assessment).toBeUndefined()
  })
})

it('changes only the static output-byte count in the paired running-job cases', () => {
  const low = evaluationCases.find(item => item.id === 'running-job-silent')!
  const high = evaluationCases.find(item => item.id === 'running-job-large-output')!
  if (low.scenario.kind !== 'snapshot' || high.scenario.kind !== 'snapshot') throw new Error('Expected snapshot pair')
  const before = structuredClone(low.scenario.observation), after = structuredClone(high.scenario.observation)
  expect(before.execution!.jobs.outputBytes).toBe(0)
  expect(after.execution!.jobs.outputBytes).toBeGreaterThan(0)
  after.execution!.jobs.outputBytes = before.execution!.jobs.outputBytes
  expect(after).toEqual(before)
  expect(high.expectation).toEqual(low.expectation)
})

it('keeps synthetic available sample totals internally consistent and unknown attribution explicit', () => {
  const sum = (value: Record<string, number>) => Object.values(value).reduce((total, count) => total + count, 0)
  for (const item of evaluationCases) {
    const evidence = item.scenario.kind === 'snapshot' && item.scenario.observation.execution
    if (!evidence) continue
    expect(evidence.jobs.assignmentAttribution).toBe('unknown')
    expect(evidence.jobs.lifecycleAttribution).toBe('unknown')
    expect(sum(evidence.jobs.counts)).toBe(evidence.jobs.sampled)
    expect(sum(evidence.subagents.counts)).toBe(evidence.subagents.sampled)
    expect(sum(evidence.remoteEffects.phases)).toBe(evidence.remoteEffects.sampled)
    expect(sum(evidence.remoteEffects.quiescence)).toBe(evidence.remoteEffects.sampled)
    expect(sum(evidence.remoteEffects.outcomes)).toBe(evidence.remoteEffects.sampled)
  }
})

it('does not count an always-unknown result as the preferred judgment on the four discriminative curated cases', () => {
  const discriminative = evaluationCases.filter(item => item.expectation.kind === 'assessment' && item.expectation.preferredFindings?.length)
  expect(discriminative).toHaveLength(4)
  for (const item of discriminative) {
    // A scorer fixture only: this is not a provider response or evidence of a successful semantic evaluation.
    const score = scoreEvaluationCase(item, {
      caseId: item.id, status: 'assessed', incident: { id: 'incident', revision: 'current' },
      assessment: { incidentId: 'incident', incidentRevision: 'current', finding: 'unknown', evidence: 'Synthetic scorer test abstention.' },
      monitorReachable: true, modelAttempts: 1, turns: 1, turnEnd: 'completed', statusRequests: { attempted: 0, accepted: 0 }, otherToolCalls: 0,
      usage: { availability: 'unavailable', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
      latencyMs: 1, assessmentLatencyMs: 1, redacted: false,
    })
    expect(score.findingAgreement).toBe(true)
    expect(score.preferredAgreement).toBe(false)
    expect(score.evidenceReview).toBe('pending')
  }
})

it('treats initial unavailability as an operational control with no invented model assessment', async () => {
  const item = evaluationCases.find(value => value.scenario.kind === 'unavailable')!
  expect(item.expectation.kind).toBe('no_assessment')
  const send = vi.fn(), intervene = vi.fn()
  const monitor = new WatchdogMonitor(journal, { observe: async () => { throw new Error('Synthetic main-service transport unavailable') }, intervene },
    { busy: () => false, send, cancel: vi.fn() },
    { pollMs: 30_000, staleMs: 15 * 60_000, reviewEveryMs: 60 * 60_000, retryMs: 300_000, assessmentTimeoutMs: 90_000 }, () => now)
  await monitor.poll()
  expect(journal.status()).toMatchObject({ reachable: false })
  expect(journal.open()).toEqual([])
  expect(send).not.toHaveBeenCalled(); expect(intervene).not.toHaveBeenCalled()
})
