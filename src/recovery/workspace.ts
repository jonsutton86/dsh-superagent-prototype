/** Verify persisted product authority without dispatching missions, advancing schedules or approving proposals. */
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { key, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { definitionOf, PlanDefinition, type PlanVersion, type PlanProposal } from '../workspace/plan-model.ts'
import type { Mission } from '../workspace/model.ts'
import { ScheduleDefinition, type Schedule, type ScheduleOccurrence } from '../workspace/schedule-model.ts'
import { occurrenceAt, validateCadence } from '../workspace/cadence.ts'
import { ReflectionCandidate } from '../workspace/reflection-model.ts'

const id = z.string().min(1).max(4096), at = z.iso.datetime({ offset: true }), count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = count.min(1), text = z.string().max(128000), ids = z.array(id).max(100000).refine(value => new Set(value).size === value.length)
const origin = z.looseObject({ id, revision: positive, occurrence: id, due: at })
const action = z.looseObject({ id, title: text, instructions: text, owner: z.enum(['person', 'agent']), dependsOn: ids, runs: ids,
  definitionRevision: positive.optional(), executionRevision: positive.optional(), dependencyRevision: id.optional(),
  accepted: z.looseObject({ at, note: text, basis: z.enum(['operator', 'checks']).optional(), ticketRevision: id.optional() }).optional() })
const missionSchema = z.looseObject({ id, title: text, objective: text, acceptance: text, status: z.enum(['active', 'completed', 'archived']),
  revision: positive, planVersion: positive, createdAt: at, updatedAt: at, actions: z.array(action).max(200), schedule: origin.optional() })
const versionSchema = z.looseObject({ version: positive, at, reason: text, proposalId: id.optional(), plan: PlanDefinition,
  authority: z.array(z.object({ actionId: id, definitionRevision: positive }).strict()).max(200).optional() })
const proposalSchema = z.looseObject({ id, missionId: id, baseVersion: positive, rationale: text, plan: PlanDefinition, createdAt: at,
  author: z.discriminatedUnion('role', [z.object({ role: z.literal('operator') }), z.object({ role: z.literal('worker'), ticketId: id, sessionId: id })]),
  revision: positive, status: z.enum(['pending', 'approved', 'rejected']), review: z.looseObject({ at, note: text, version: positive.optional() }).optional() })
const scheduleSchema = z.looseObject({ id, revision: positive, definition: ScheduleDefinition, enabled: z.boolean(), runs: count,
  nextAt: at.optional(), createdAt: at, updatedAt: at })
const occurrenceSchema = z.looseObject({ id, scheduleId: id, revision: positive, due: at, through: at.optional(), createdAt: at,
  state: z.enum(['active', 'blocked', 'complete', 'archived', 'skipped']), missionId: id.optional(), error: text.optional() })
export interface WorkspaceStateVerification {
  version: 1; records: number; missions: number; actions: number; planVersions: number; proposals: number; schedules: number;
  scheduleVersions: number; occurrences: number; executions: number; scheduledExecutions: number; routedExecutions: number;
  legacyPlanVersions: number; legacyTriggers: number; digest: string
}
/** Product recovery failures name the conflicting relation, without including instructions or model content. */
export class WorkspaceStateError extends Error {
  constructor(readonly code: string, readonly record: string) { super(`recovery_workspace_${code}: ${record.slice(0, 200)}`) }
}

/** Read only an exclusively held prepared Store after its core Engine graph has been verified. */
export async function verifyWorkspaceState(db: DatabaseSync, signal: AbortSignal): Promise<WorkspaceStateVerification> {
  function fail(code: string, record: string): never { throw new WorkspaceStateError(code, record) }
  const hash = createHash('sha256'), tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
  let records = 0, bytes = 0, links = 0, ticks = 0, actions = 0, planVersions = 0, scheduleVersions = 0, legacyPlanVersions = 0,
    legacyTriggers = 0, executions = 0, scheduledExecutions = 0, routedExecutions = 0
  const checkpoint = async (weight = 1) => { signal.throwIfAborted(); links += weight; if (links > 2_000_000) fail('limit', 'relations'); if (++ticks % 64 === 0) await setImmediate(undefined, { signal }) }
  const parse = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => { const result = schema.safeParse(value); if (!result.success) fail('shape', label); return result.data }
  const same = (left: unknown, right: unknown, label: string) => { if (!isDeepStrictEqual(left, right)) fail('conflict', label) }
  async function* rows<T>(table: string, schema: z.ZodType<T>, where = '') {
    if (!tables.has(table)) return
    for (const row of db.prepare(`SELECT rowid,* FROM ${table} ${where} ORDER BY rowid`).iterate()) {
      await checkpoint(); const size = Buffer.byteLength(String(row.value)); bytes += size
      if (++records > 250000 || size > 8 * 1024 * 1024 || bytes > 128 * 1024 * 1024) fail('limit', table)
      let value: unknown
      try { value = JSON.parse(String(row.value)) } catch { fail('shape', table) }
      parse(schema, value, table); hash.update(JSON.stringify([table, row]) + '\n'); yield { row, value: value as T }
    }
  }
  const required = <T>(map: Map<string, T>, identity: string, label: string) => map.get(identity) ?? fail('reference', `${label}:${identity}`)
  const planKey = (mission: string, version: number) => JSON.stringify([mission, version])
  const missions = new Map<string, Mission>(), versions = new Map<string, PlanVersion>(), history = new Map<string, PlanVersion[]>(), proposals = new Map<string, PlanProposal>()
  const schedules = new Map<string, Schedule>(), scheduleHistory = new Map<string, Schedule[]>(), scheduleSnapshots = new Map<string, Schedule>(), occurrences = new Map<string, ScheduleOccurrence>()
  const triggers = new Map<string, Trigger>(), dispositions = new Map<string, TriggerDisposition>(), tickets = new Map<string, Ticket>(), origins = new Map<string, Ticket[]>()
  for await (const { row, value } of rows('workspace_mission', missionSchema)) {
    same(row.id, value.id, 'mission_identity'); parse(PlanDefinition, definitionOf(value as Mission), `mission:${value.id}`)
    missions.set(value.id, value as Mission); actions += value.actions.length; await checkpoint(value.actions.length)
  }
  for await (const { row, value } of rows('workspace_plan_version', versionSchema)) {
    const missionId = String(row.mission); required(missions, missionId, 'plan_mission'); same(value.version, row.version, 'plan_version')
    const list = history.get(missionId) ?? []; list.push(value); history.set(missionId, list)
    versions.set(planKey(missionId, value.version), value); planVersions++
    if (value.authority) {
      same(value.authority.map(item => item.actionId), value.plan.actions.map(item => item.id), `plan_authority:${missionId}:${value.version}`)
    } else legacyPlanVersions++
    await checkpoint(value.plan.actions.length)
  }
  for (const mission of missions.values()) {
    const list = history.get(mission.id) ?? []; list.sort((a, b) => a.version - b.version)
    if (list.length !== mission.planVersion || list.some((value, index) => value.version !== index + 1)) fail('plan_history', mission.id)
    const current = required(versions, planKey(mission.id, mission.planVersion), 'current_plan')
    same(definitionOf(mission), current.plan, `current_plan:${mission.id}`)
    if (current.authority) same(current.authority, mission.actions.map(item => ({ actionId: item.id, definitionRevision: item.definitionRevision ?? 1 })), `current_authority:${mission.id}`)
  }
  for await (const { row, value } of rows('workspace_plan_proposal', proposalSchema)) {
    same(row.id, value.id, 'proposal_identity'); same(row.mission, value.missionId, 'proposal_mission')
    required(versions, planKey(value.missionId, value.baseVersion), 'proposal_base'); proposals.set(value.id, value)
    if (value.status === 'pending' ? value.revision !== 1 || !!value.review : value.revision !== 2 || !value.review) fail('proposal_review', value.id)
    if (value.status === 'approved') {
      if (value.review?.version !== value.baseVersion + 1) fail('proposal_review', value.id)
      const applied = required(versions, planKey(value.missionId, value.review.version), 'approved_plan')
      same(applied.proposalId, value.id, `approved_plan:${value.id}`)
      mappedPlan(value.plan, applied.plan, required(versions, planKey(value.missionId, value.baseVersion), 'proposal_base').plan, `approved_plan:${value.id}`)
    } else if (value.review?.version !== undefined) fail('proposal_review', value.id)
  }
  const reflectionProposals = new Map<string, unknown>()
  for await (const { row, value } of rows('workspace_reflection_proposal', z.record(z.string(), z.unknown()))) reflectionProposals.set(String(row.id), value)
  for (const [missionId, list] of history) for (const version of list) if (version.proposalId) {
    await checkpoint(); const proposal = proposals.get(version.proposalId)
    if (proposal) {
      if (proposal.status !== 'approved' || proposal.missionId !== missionId || proposal.review?.version !== version.version) fail('proposal_review', version.proposalId)
    } else {
      const value = required(reflectionProposals, version.proposalId, 'plan_proposal')
      const reflection = parse(z.looseObject({ id, runId: id, status: z.literal('approved'), revision: z.literal(2), candidate: ReflectionCandidate,
        review: z.looseObject({ result: z.object({ kind: z.literal('mission'), id, version: positive }).strict() }) }), value, 'reflection_plan')
      if (reflection.id !== version.proposalId || reflection.review.result.id !== missionId || reflection.review.result.version !== version.version
        || reflection.candidate.kind === 'memory' || reflection.candidate.kind === 'plan' && reflection.candidate.missionId !== missionId) fail('proposal_review', version.proposalId)
      mappedPlan(reflection.candidate.plan, version.plan,
        required(versions, planKey(missionId, version.version - 1), 'reflection_base').plan, `reflection_plan:${version.proposalId}`)
    }
  }
  // New action IDs are chosen by the host, while definition order and dependency identity remain those the operator approved.
  function mappedPlan(original: PlanDefinition, applied: PlanDefinition, previous: PlanDefinition | undefined, label: string) {
    if (original.actions.length !== applied.actions.length) fail('plan_mapping', label)
    const kept = new Set(previous?.actions.map(item => item.id)), mapping = new Map(original.actions.map((item, index) => [item.id, applied.actions[index]!.id]))
    for (const item of original.actions) if (kept.has(item.id) && mapping.get(item.id) !== item.id) fail('plan_mapping', label)
    same({ ...original, actions: original.actions.map(item => ({ ...item, id: mapping.get(item.id), dependsOn: item.dependsOn.map(dependency => mapping.get(dependency)) })) }, applied, label)
  }
  for await (const { row, value } of rows('workspace_schedule', scheduleSchema)) { same(row.id, value.id, 'schedule_identity'); schedules.set(value.id, value) }
  for await (const { row, value } of rows('workspace_schedule_version', scheduleSchema)) {
    same(value.id, row.schedule, 'schedule_version'); same(value.revision, row.revision, 'schedule_version'); required(schedules, value.id, 'schedule_version')
    const list = scheduleHistory.get(value.id) ?? []; list.push(value); scheduleHistory.set(value.id, list)
    scheduleSnapshots.set(planKey(value.id, value.revision), value); scheduleVersions++
    try { validateCadence(value.definition.cadence); if (value.nextAt) same(occurrenceAt(value.definition.cadence, Date.parse(value.nextAt), 1), value.nextAt, `schedule_cursor:${value.id}`) }
    catch (error) { if (error instanceof WorkspaceStateError) throw error; fail('cadence', value.id) }
    if (value.definition.reflection) same(value.definition.plan.objective, value.definition.reflection.guidance, `reflection_authority:${value.id}`)
  }
  const totals = new Map<string, Map<number, { runs: number; latest?: string }>>(), cursors = new Map<string, string | undefined>()
  for await (const { row, value } of rows('workspace_occurrence', occurrenceSchema)) {
    same(row.id, value.id, 'occurrence_identity'); same(row.schedule, value.scheduleId, 'occurrence_schedule')
    const snapshot = required(scheduleSnapshots, planKey(value.scheduleId, value.revision), 'occurrence_authority')
    if (!snapshot.enabled) fail('occurrence_authority', value.id)
    const revisionKey = planKey(value.scheduleId, value.revision)
    same(value.due, cursors.has(revisionKey) ? cursors.get(revisionKey) : snapshot.nextAt, `occurrence_sequence:${value.id}`)
    const skipped = value.state === 'skipped'
    same(value.id, key(skipped ? 'schedule-skip' : 'schedule-run', value.scheduleId, String(value.revision), value.due), `occurrence_identity:${value.id}`)
    same(occurrenceAt(snapshot.definition.cadence, Date.parse(value.due), 1), value.due, `occurrence_due:${value.id}`)
    if (skipped) {
      if (snapshot.definition.missed === 'all' || !value.through || value.through < value.due || value.missionId) fail('occurrence_skip', value.id)
      same(occurrenceAt(snapshot.definition.cadence, Date.parse(value.through), 1), value.through, `occurrence_skip:${value.id}`)
    } else if (value.through || ['complete', 'archived'].includes(value.state) && !value.missionId) fail('occurrence_state', value.id)
    const byRevision = totals.get(value.scheduleId) ?? new Map<number, { runs: number; latest?: string }>(), tally = byRevision.get(value.revision) ?? { runs: 0 }
    if (!skipped && snapshot.runs + ++tally.runs > snapshot.definition.maxRuns) fail('occurrence_budget', value.id)
    const end = value.through ?? value.due; if (!tally.latest || end > tally.latest) tally.latest = end
    cursors.set(revisionKey, occurrenceAt(snapshot.definition.cadence, Date.parse(end) + 1, 1))
    byRevision.set(value.revision, tally); totals.set(value.scheduleId, byRevision); occurrences.set(value.id, value)
    if (value.missionId) {
      const mission = required(missions, value.missionId, 'occurrence_mission')
      same(mission.schedule, { id: value.scheduleId, revision: value.revision, occurrence: value.id, due: value.due }, `scheduled_origin:${mission.id}`)
      mappedPlan(snapshot.definition.plan, required(versions, planKey(mission.id, 1), 'scheduled_plan').plan, undefined, `scheduled_plan:${mission.id}`)
    }
  }
  for (const schedule of schedules.values()) {
    await checkpoint(); const list = scheduleHistory.get(schedule.id) ?? []; list.sort((a, b) => a.revision - b.revision)
    if (list.length !== schedule.revision || list.some((value, index) => value.revision !== index + 1)) fail('schedule_history', schedule.id)
    let runs = 0
    for (const version of list) { same(version.runs, runs, `schedule_runs:${schedule.id}:${version.revision}`); runs += totals.get(schedule.id)?.get(version.revision)?.runs ?? 0 }
    same(schedule.runs, runs, `schedule_runs:${schedule.id}`)
    const current = list.at(-1)!, { runs: _runs, nextAt: _next, ...original } = current, { runs: _currentRuns, nextAt: _currentNext, ...actual } = schedule
    same(actual, original, `schedule_definition:${schedule.id}`)
    const latest = totals.get(schedule.id)?.get(schedule.revision)?.latest
    same(schedule.nextAt, latest ? occurrenceAt(schedule.definition.cadence, Date.parse(latest) + 1, 1) : current.nextAt, `schedule_cursor:${schedule.id}`)
  }
  for (const mission of missions.values()) if (mission.schedule) {
    const occurrence = required(occurrences, mission.schedule.occurrence, 'mission_occurrence')
    same(occurrence.missionId, mission.id, `mission_occurrence:${mission.id}`)
  }
  const object = z.record(z.string(), z.unknown())
  for await (const { row, value } of rows('trigger', object, "WHERE json_extract(value,'$.source')='workspace'")) { same(value.id, row.id, 'trigger_identity'); triggers.set(String(row.id), value as unknown as Trigger) }
  for await (const { row, value } of rows('disposition', object, "WHERE id IN (SELECT id FROM trigger WHERE json_extract(value,'$.source')='workspace')")) dispositions.set(String(row.id), value as unknown as TriggerDisposition)
  for await (const { row, value } of rows('ticket', object)) {
    same(value.id, row.id, 'ticket_identity'); const ticket = value as unknown as Ticket; tickets.set(ticket.id, ticket)
    const list = origins.get(ticket.origin.triggerId) ?? []; list.push(ticket); origins.set(ticket.origin.triggerId, list)
  }
  for (const trigger of triggers.values()) {
    await checkpoint(); const accepted = origins.get(trigger.id) ?? [], disposition = required(dispositions, trigger.id, 'workspace_disposition'), meta = trigger.meta
    if (disposition.filtered) { if (accepted.length) fail('filtered_authority', trigger.id); continue }
    const operator = trigger.actor.source === 'workspace' && trigger.actor.id === 'local-operator' && trigger.addressed === 'direct'
    if (!operator || !trigger.human && typeof meta.schedule !== 'string') { if (accepted.length) fail('actor', trigger.id); continue }
    const mission = required(missions, parse(id, meta.mission, 'trigger_mission'), 'trigger_mission'), actionId = parse(id, meta.action, 'trigger_action')
    const actionRevision = parse(positive, meta.actionRevision ?? 1, 'trigger_action_revision')
    const stamped = meta.planVersion === undefined ? undefined : required(versions, planKey(mission.id, parse(positive, meta.planVersion, 'trigger_plan')), 'trigger_plan')
    const choices = stamped ? [stamped] : history.get(mission.id)!
    await checkpoint(choices.reduce((sum, version) => sum + version.plan.actions.length, 0))
    const candidates = choices.flatMap(version => version.plan.actions.filter(action => action.id === actionId && action.owner === 'agent'
      && isDeepStrictEqual(action.persona ?? null, meta.persona ?? null) && action.environment === meta.environment && action.pull === meta.pull
      && (!version.authority || version.authority.find(item => item.actionId === actionId)?.definitionRevision === actionRevision))
      .map(action => ({ version, action })))
    if (!candidates.length) fail('action_authority', trigger.id)
    if (!stamped?.authority) legacyTriggers++
    same(trigger.id, meta.intent, `intent:${trigger.id}`)
    const prefix = `workspace:${mission.id}:${actionId}:`, direct = trigger.id.startsWith(prefix)
    if (direct) {
      const index = trigger.id.slice(prefix.length)
      if (!/^(0|[1-9]\d*)$/.test(index) || !Number.isSafeInteger(Number(index))) fail('intent', trigger.id)
      same(trigger.threads, [{ source: 'workspace', id: trigger.id }], `intent_thread:${trigger.id}`)
      if (accepted.length > 1) fail('duplicate_execution', trigger.id)
      const current = mission.actions.find(action => action.id === actionId)
      if (accepted.length && current) same(current.runs[Number(index)], accepted[0]!.id, `action_run:${trigger.id}`)
    } else {
      if (!trigger.id.startsWith('workspace-message:') || !trigger.human) fail('intent', trigger.id)
      const root = required(triggers, trigger.threads[0]?.id ?? '', 'followup_root')
      if (root.meta.mission !== mission.id || root.meta.action !== actionId || !root.id.startsWith(prefix)) fail('followup_authority', trigger.id)
      same(trigger.threads, root.threads, `followup_thread:${trigger.id}`)
    }
    if (!trigger.human) {
      if (!direct || !mission.schedule) fail('scheduled_authority', trigger.id)
      same({ id: meta.schedule, revision: meta.scheduleRevision, occurrence: meta.occurrence, due: meta.scheduledFor }, mission.schedule, `scheduled_authority:${trigger.id}`)
      if (stamped && stamped.version !== 1) fail('scheduled_authority', trigger.id)
    }
    for (const ticket of accepted) {
      executions++; if (!trigger.human) scheduledExecutions++; if (!direct) routedExecutions++
      const mandate = ticket.mandate
      if (mandate.strength !== 'explicit' || mandate.basis.via !== 'addressed' || mandate.basis.addressed !== 'direct'
        || mandate.basis.source !== 'workspace' || mandate.basis.sender !== 'local-operator') fail('mandate', ticket.id)
      same(mandate.basis.scope, meta, `mandate_scope:${ticket.id}`)
      if (direct && !candidates.some(candidate => candidate.action.instructions === mandate.scope)) fail('mandate_instructions', ticket.id)
    }
  }
  for (const mission of missions.values()) for (const action of mission.actions) for (const ticketId of action.runs) {
    await checkpoint(); const ticket = required(tickets, ticketId, 'action_ticket'), trigger = required(triggers, ticket.origin.triggerId, 'action_origin')
    if (trigger.meta.mission !== mission.id || trigger.meta.action !== action.id || !trigger.id.startsWith(`workspace:${mission.id}:${action.id}:`)) fail('action_ticket', ticketId)
  }
  for (const proposal of proposals.values()) if (proposal.author.role === 'worker') {
    const ticket = required(tickets, proposal.author.ticketId, 'proposal_author'), trigger = required(triggers, ticket.origin.triggerId, 'proposal_origin')
    if (trigger.meta.mission !== proposal.missionId || !trigger.id.startsWith(`workspace:${proposal.missionId}:${trigger.meta.action}:`)
      || proposal.author.sessionId !== workerSessionId(ticket.id)) fail('proposal_author', proposal.id)
  }
  for (const table of ['workspace_command', 'workspace_planning_request', 'workspace_schedule_command', 'workspace_plan_command']) {
    if (!tables.has(table)) continue
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) {
      await checkpoint(); if (++records > 250000) fail('limit', table)
      parse(id, row.id, table); parse(z.string().regex(/^[a-f0-9]{32}$/), row.fingerprint, table)
      if (table === 'workspace_schedule_command') required(schedules, String(row.schedule), table)
      else if (table === 'workspace_plan_command') {
        const proposal = required(proposals, String(row.proposal), table)
        if (row.actor !== 'operator' && (proposal.author.role !== 'worker' || row.actor !== `worker:${proposal.author.ticketId}`)) fail('command_actor', String(row.id))
      } else required(missions, String(row.mission), table)
      hash.update(JSON.stringify([table, row]) + '\n')
    }
  }
  signal.throwIfAborted()
  return { version: 1, records, missions: missions.size, actions, planVersions, proposals: proposals.size, schedules: schedules.size,
    scheduleVersions, occurrences: occurrences.size, executions, scheduledExecutions, routedExecutions, legacyPlanVersions, legacyTriggers, digest: hash.digest('hex') }
}
