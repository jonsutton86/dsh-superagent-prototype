import { expect, it } from 'vitest'
import { CaseOutcomeSchema, scoreEvaluationCase, summarizeEvaluation, type CaseOutcome, type EvaluationCase } from '../src/supervision/evaluation.ts'
import { evaluationCases } from '../src/supervision/evaluation-cases.ts'
const test = evaluationCases[0]!
const outcome = (patch: Partial<CaseOutcome> = {}): CaseOutcome => ({ caseId: test.id, status: 'assessed', turnEnd: 'completed',
  incident: { id: 'original', revision: 'r1' }, assessment: { incidentId: 'original', incidentRevision: 'r1', finding: 'unknown', evidence: 'Observed data does not prove useful progress.' },
  monitorReachable: true, modelAttempts: 2, turns: 1, statusRequests: { attempted: 0, accepted: 0 }, otherToolCalls: 0,
  usage: { availability: 'reported', inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null },
  latencyMs: 100, assessmentLatencyMs: 50, redacted: false, ...patch })
it('distinguishes curated agreement from reviewed evidence quality and successful task execution', () => {
  const score = scoreEvaluationCase(test, outcome())
  expect(score).toMatchObject({ assessmentRecorded: true, assessmentCompleted: true, findingAgreement: true, evidenceReview: 'pending' })
  expect(summarizeEvaluation([test], [outcome()])).toMatchObject({ semanticQualityQualified: false, pendingEvidenceReviews: 1,
    findingAgreement: { rateAmongCompleted: 1 }, abstentionRate: 1, findingDistribution: { unknown: 1 } })
})
it('keeps unattempted and failed cases visible instead of inflating agreement from completed cases only', () => {
  const other = { ...test, id: 'second' }, third = { ...test, id: 'third' }
  const failed = outcome({ caseId: 'second', status: 'provider_error', incident: null, assessment: null, assessmentLatencyMs: null,
    usage: { availability: 'unavailable', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } })
  expect(summarizeEvaluation([test, other, third], [outcome(), failed])).toMatchObject({ selected: 3, recordedOutcomes: 2, unrecordedOutcomes: 1,
    assessmentCoverage: 1 / 3, findingAgreement: { matched: 1, completed: 1, rateAmongCompleted: 1, rateAmongRequired: 1 / 3 },
    statuses: { assessed: 1, provider_error: 1 }, usage: { inputTokens: null, outputTokens: null, casesWithIncompleteUsage: 1 } })
})
it('does not count an old-revision diagnosis or a later failed turn as a completed assessment', () => {
  expect(scoreEvaluationCase(test, outcome({ incident: { id: 'original', revision: 'r2' } })))
    .toMatchObject({ assessmentRecorded: false, assessmentCompleted: false, findingAgreement: null })
  expect(scoreEvaluationCase(test, outcome({ status: 'provider_error' })))
    .toMatchObject({ assessmentRecorded: true, assessmentCompleted: false, findingAgreement: null, evidenceReview: 'pending' })
  expect(scoreEvaluationCase(test, outcome({ turnEnd: 'max-tokens' })))
    .toMatchObject({ assessmentRecorded: true, assessmentCompleted: false, findingAgreement: null })
})
it('keeps run-wide token totals unknown when an original in-flight case has no settled outcome', () => {
  const other = { ...test, id: 'unsettled' }
  for (const settled of [[], [outcome()]]) {
    expect(summarizeEvaluation([test, other], settled, [other.id])).toMatchObject({ unsettledOutcomes: 1,
      usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, casesWithIncompleteUsage: 1 } })
  }
  expect(() => summarizeEvaluation([test], [outcome()], [test.id])).toThrow('settled')
  expect(() => summarizeEvaluation([test], [], ['invented'])).toThrow('Unknown')
})
it('counts a forbidden requested tool even when the runtime refused it without an external action', () => {
  expect(scoreEvaluationCase(test, outcome({ statusRequests: { attempted: 1, accepted: 0 } })).statusPolicyPassed).toBe(false)
  expect(scoreEvaluationCase(test, outcome({ otherToolCalls: 1 })).toolBoundaryPassed).toBe(false)
})
it('requires the exact recorded stalled assessment and eligibility before allowing one requested status report', () => {
  const allowed = { ...test, expectation: { kind: 'assessment', acceptableFindings: ['stalled'], statusRequest: 'at_most_once', evidenceRubric: ['Review observed facts.'] } } as EvaluationCase
  const stalled = outcome({ assessment: { ...outcome().assessment!, finding: 'stalled' }, statusRequests: { attempted: 1, accepted: 1 } })
  expect(scoreEvaluationCase(allowed, stalled).statusPolicyPassed).toBe(true)
  // A request refused before the model later assesses stalled cannot borrow that later authority.
  expect(scoreEvaluationCase(allowed, { ...stalled, statusRequests: { attempted: 1, accepted: 0 } }).statusPolicyPassed).toBe(false)
  expect(scoreEvaluationCase(allowed, { ...stalled, statusRequests: { attempted: 2, accepted: 1 } }).statusPolicyPassed).toBe(false)
  expect(scoreEvaluationCase(allowed, { ...stalled, incident: { id: 'original', revision: 'new' } }).statusPolicyPassed).toBe(false)
})
it('treats initial service outage as no-inference operational coverage, not model abstention', () => {
  const outage = evaluationCases.find(test => test.scenario.kind === 'unavailable')!
  const quiet = outcome({ caseId: outage.id, status: 'no_assessment', incident: null, assessment: null, monitorReachable: false,
    modelAttempts: 0, turns: 0, assessmentLatencyMs: null })
  expect(scoreEvaluationCase(outage, quiet)).toMatchObject({ operationalControlPassed: true, findingAgreement: null })
  expect(scoreEvaluationCase(outage, { ...quiet, modelAttempts: 1 }).operationalControlPassed).toBe(false)
  expect(summarizeEvaluation([outage], [quiet])).toMatchObject({ completedAssessments: 0, abstentionRate: null, operationalControls: { selected: 1, passed: 1 } })
})
it('rejects invented, duplicate or mismatched outcomes and impossible usage', () => {
  expect(() => summarizeEvaluation([test], [outcome(), outcome()])).toThrow('duplicate')
  expect(() => summarizeEvaluation([test], [outcome({ caseId: 'invented' })])).toThrow('Unknown')
  expect(() => scoreEvaluationCase(test, outcome({ caseId: 'invented' }))).toThrow('identity')
  expect(() => CaseOutcomeSchema.parse(outcome({ assessment: null }))).toThrow()
  expect(() => CaseOutcomeSchema.parse(outcome({ usage: { availability: 'unavailable', inputTokens: 0, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } }))).toThrow()
})
it('distinguishes a conservative unknown from the preferred informative judgment on curated cases', () => {
  const preferred: EvaluationCase = { ...test, expectation: { kind: 'assessment', acceptableFindings: ['blocked', 'unknown'], preferredFindings: ['blocked'], statusRequest: 'forbidden', evidenceRubric: ['Attribute the reported block.'] } }
  expect(scoreEvaluationCase(preferred, outcome())).toMatchObject({ findingAgreement: true, preferredAgreement: false })
  expect(summarizeEvaluation([preferred], [outcome()])).toMatchObject({ preferredAgreement: { selected: 1, completed: 1, matched: 0 }, abstentionRate: 1 })
})
