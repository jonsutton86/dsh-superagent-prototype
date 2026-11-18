/** Versioned evaluation records; curated agreement is distinct from runtime validity and human-reviewed evidence quality. */
import { z } from 'zod'
import { AssessmentSchema, ObservationSchema } from './protocol.ts'

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const finding = AssessmentSchema.shape.finding
const rubric = z.array(z.string().min(1).max(1000)).min(1).max(20)
export const EvaluationCaseSchema = z.object({
  id, title: z.string().min(1).max(200), tags: z.array(id).min(1).max(12),
  sourceReferences: z.array(z.string().min(1).max(500)).min(1).max(20), description: z.string().min(1).max(2000),
  scenario: z.discriminatedUnion('kind', [z.object({ kind: z.literal('snapshot'), observation: ObservationSchema }).strict(),
    z.object({ kind: z.literal('unavailable') }).strict()]),
  expectation: z.discriminatedUnion('kind', [z.object({ kind: z.literal('assessment'), acceptableFindings: z.array(finding).min(1).max(5),
    preferredFindings: z.array(finding).min(1).max(5).optional(), statusRequest: z.enum(['forbidden', 'at_most_once']), evidenceRubric: rubric }).strict(),
  z.object({ kind: z.literal('no_assessment'), evidenceRubric: rubric }).strict()]),
}).strict().superRefine((value, ctx) => {
  if ((value.scenario.kind === 'unavailable') !== (value.expectation.kind === 'no_assessment'))
    ctx.addIssue({ code: 'custom', message: 'An initial outage is operational coverage, not a semantic assessment case' })
  if (value.expectation.kind === 'assessment') {
    const expectation = value.expectation
    if (new Set(expectation.acceptableFindings).size !== expectation.acceptableFindings.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate acceptable finding' })
    if (expectation.preferredFindings?.some(item => !expectation.acceptableFindings.includes(item)))
      ctx.addIssue({ code: 'custom', message: 'Preferred findings must be acceptable' })
    if (value.expectation.statusRequest === 'at_most_once' && value.scenario.kind === 'snapshot' && !value.scenario.observation.canNudge)
      ctx.addIssue({ code: 'custom', message: 'Status requests require an eligible observation' })
  }
})
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>
export const EvaluationUsageSchema = z.object({ availability: z.enum(['reported', 'partial', 'unavailable']),
  inputTokens: count.nullable(), outputTokens: count.nullable(), cacheReadTokens: count.nullable(), cacheWriteTokens: count.nullable(),
}).strict()
export type EvaluationUsage = z.infer<typeof EvaluationUsageSchema>
export const CaseOutcomeSchema = z.object({
  caseId: id, status: z.enum(['assessed', 'no_assessment', 'provider_error', 'deadline', 'request_limit', 'response_limit', 'turn_incomplete', 'startup_error', 'cancelled']),
  turnEnd: z.enum(['completed', 'error', 'blocked', 'max-tokens', 'aborted', 'interrupted', 'forked', 'unknown']).nullable().optional(),
  incident: z.object({ id: z.string().min(1).max(200), revision: z.string().min(1).max(100) }).strict().nullable(),
  assessment: AssessmentSchema.nullable(), monitorReachable: z.boolean().nullable(), modelAttempts: count, turns: count,
  statusRequests: z.object({ attempted: count, accepted: count }).strict(), otherToolCalls: count,
  usage: EvaluationUsageSchema, latencyMs: count, assessmentLatencyMs: count.nullable(), redacted: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.statusRequests.accepted > value.statusRequests.attempted)
    ctx.addIssue({ code: 'custom', message: 'Accepted status requests exceed recorded tool requests' })
  if (value.status === 'assessed' && (!value.assessment || !value.incident))
    ctx.addIssue({ code: 'custom', message: 'An assessed outcome needs a durable assessment and original incident' })
  if (value.assessmentLatencyMs !== null && value.assessmentLatencyMs > value.latencyMs)
    ctx.addIssue({ code: 'custom', message: 'Assessment latency exceeds case duration' })
  if (value.usage.availability === 'reported' && (value.usage.inputTokens === null || value.usage.outputTokens === null))
    ctx.addIssue({ code: 'custom', message: 'Reported usage needs input/output counters' })
  if (value.usage.availability === 'unavailable' && Object.entries(value.usage).some(([name, number]) => name !== 'availability' && number !== null))
    ctx.addIssue({ code: 'custom', message: 'Unavailable usage cannot be represented by known counters' })
})
export type CaseOutcome = z.infer<typeof CaseOutcomeSchema>
export interface EvaluationScore {
  caseId: string
  provenance: 'curated_synthetic'
  assessmentRequired: boolean
  assessmentRecorded: boolean
  assessmentCompleted: boolean
  findingAgreement: boolean | null
  preferredAgreement: boolean | null
  statusPolicyPassed: boolean
  toolBoundaryPassed: boolean
  operationalControlPassed: boolean | null
  evidenceReview: 'pending' | 'not_available'
  evidenceRubric: string[]
}
/** Scores only recorded protocol facts and curated label agreement; prose grounding always needs an explicit reviewer. */
export function scoreEvaluationCase(input: EvaluationCase, result: CaseOutcome): EvaluationScore {
  const test = EvaluationCaseSchema.parse(input), outcome = CaseOutcomeSchema.parse(result)
  if (test.id !== outcome.caseId) throw new Error('Evaluation case identity mismatch')
  const recorded = !!outcome.assessment && !!outcome.incident && outcome.assessment.incidentId === outcome.incident.id
    && outcome.assessment.incidentRevision === outcome.incident.revision
  const completed = recorded && outcome.status === 'assessed' && outcome.turnEnd === 'completed'
  const required = test.expectation.kind === 'assessment'
  const permits = test.expectation.kind === 'assessment' && test.expectation.statusRequest === 'at_most_once'
    && test.scenario.kind === 'snapshot' && test.scenario.observation.canNudge && recorded && outcome.assessment?.finding === 'stalled'
  return {
    caseId: test.id, provenance: 'curated_synthetic', assessmentRequired: required, assessmentRecorded: recorded, assessmentCompleted: completed,
    findingAgreement: test.expectation.kind === 'assessment' && completed ? test.expectation.acceptableFindings.includes(outcome.assessment!.finding) : null,
    preferredAgreement: test.expectation.kind === 'assessment' && test.expectation.preferredFindings && completed
      ? test.expectation.preferredFindings.includes(outcome.assessment!.finding) : null,
    statusPolicyPassed: permits ? outcome.statusRequests.attempted <= 1 && outcome.statusRequests.accepted === outcome.statusRequests.attempted
      : outcome.statusRequests.attempted === 0 && outcome.statusRequests.accepted === 0,
    toolBoundaryPassed: outcome.otherToolCalls === 0,
    operationalControlPassed: required ? null : outcome.status === 'no_assessment' && !outcome.assessment && outcome.monitorReachable === false
      && outcome.modelAttempts === 0 && outcome.statusRequests.attempted === 0 && outcome.otherToolCalls === 0,
    evidenceReview: recorded ? 'pending' : 'not_available', evidenceRubric: [...test.expectation.evidenceRubric],
  }
}
/** Partial evaluations keep missing cases in the denominator and never turn provider failures into successful abstention. */
export function summarizeEvaluation(cases: readonly EvaluationCase[], outcomes: readonly CaseOutcome[], unsettledCaseIds: readonly string[] = []) {
  if (cases.length < 1 || cases.length > 100 || new Set(cases.map(test => test.id)).size !== cases.length) throw new Error('Invalid evaluation case selection')
  const selected = new Map(cases.map(test => [test.id, EvaluationCaseSchema.parse(test)]))
  const seen = new Set<string>(), scores: EvaluationScore[] = []
  const statuses: Partial<Record<CaseOutcome['status'], number>> = {}
  for (const result of outcomes) {
    const outcome = CaseOutcomeSchema.parse(result), test = selected.get(outcome.caseId)
    if (!test || seen.has(outcome.caseId)) throw new Error('Unknown or duplicate evaluation outcome')
    seen.add(outcome.caseId); scores.push(scoreEvaluationCase(test, outcome)); statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1
  }
  if (new Set(unsettledCaseIds).size !== unsettledCaseIds.length || unsettledCaseIds.some(id => !selected.has(id) || seen.has(id))) {
    throw new Error('Unknown, duplicate or already settled evaluation case')
  }
  const required = cases.filter(test => test.expectation.kind === 'assessment').length
  const completed = scores.filter(score => score.assessmentRequired && score.assessmentCompleted).length
  const matched = scores.filter(score => score.findingAgreement === true).length
  const distribution = Object.fromEntries(finding.options.map(value => [value, outcomes.filter(outcome => outcome.status === 'assessed'
    && scores.find(score => score.caseId === outcome.caseId)?.assessmentCompleted && outcome.assessment?.finding === value).length]))
  const total = (field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => {
    if (unsettledCaseIds.length) return null
    const called = outcomes.filter(outcome => outcome.modelAttempts > 0)
    if (!called.length) return 0
    if (called.some(outcome => outcome.usage[field] === null)) return null
    const sum = called.reduce((value, outcome) => value + outcome.usage[field]!, 0)
    return Number.isSafeInteger(sum) ? sum : null
  }
  return {
    provenance: 'curated_synthetic' as const, selected: cases.length, recordedOutcomes: outcomes.length, unrecordedOutcomes: cases.length - outcomes.length,
    unsettledOutcomes: unsettledCaseIds.length,
    requiredAssessments: required, completedAssessments: completed, assessmentCoverage: required ? completed / required : null,
    findingAgreement: { matched, completed, rateAmongCompleted: completed ? matched / completed : null, rateAmongRequired: required ? matched / required : null },
    preferredAgreement: { selected: cases.filter(test => test.expectation.kind === 'assessment' && test.expectation.preferredFindings).length,
      completed: scores.filter(score => score.preferredAgreement !== null).length, matched: scores.filter(score => score.preferredAgreement === true).length },
    findingDistribution: distribution, abstentionRate: completed ? distribution.unknown! / completed : null,
    operationalControls: { selected: cases.length - required, passed: scores.filter(score => score.operationalControlPassed === true).length },
    statusPolicyViolations: scores.filter(score => !score.statusPolicyPassed).length,
    toolBoundaryViolations: scores.filter(score => !score.toolBoundaryPassed).length,
    pendingEvidenceReviews: scores.filter(score => score.evidenceReview === 'pending').length,
    statuses, usage: { inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), cacheReadTokens: total('cacheReadTokens'), cacheWriteTokens: total('cacheWriteTokens'),
      casesWithIncompleteUsage: unsettledCaseIds.length + outcomes.filter(outcome => outcome.modelAttempts > 0 && outcome.usage.availability !== 'reported').length },
    semanticQualityQualified: false as const,
  }
}
