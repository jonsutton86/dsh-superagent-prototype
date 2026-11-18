/** Historical reflection evidence and cumulative recall allowances; no reads, approvals or refunds are replayed. */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { key, type Ticket, type Trigger } from '../core/index.ts'
import { RecallPolicy, SaveRecall, DEFAULT_RECALL, type RecallMetrics } from '../workspace/recall-model.ts'
import { ReflectionSpec, ProposeReflection, ReviewReflection, type ReflectionRun, type ReflectionProposal } from '../workspace/reflection-model.ts'
import { definitionOf, type PlanVersion } from '../workspace/plan-model.ts'
import type { Mission, MissionView } from '../workspace/model.ts'
import type { LibraryRead, LibraryRecord } from '../workspace/library-model.ts'
import type { Schedule, ScheduleOccurrence } from '../workspace/schedule-model.ts'
import { StateReader, stateAt as at, stateCount as count, statePositive as positive, stateId as id, stateKey as shortHash, stateObject as object } from './reader.ts'

const metrics = z.object({ calls: count, pages: count, bytes: count, nodes: count, millis: count }).strict()
const configuration = z.object({ revision: count, at, policy: RecallPolicy }).strict()
const owner = z.discriminatedUnion('role', [z.object({ id, role: z.literal('router'), day: z.iso.date() }).strict(),
  z.object({ id, role: z.literal('worker'), ticketId: id, assignmentId: id }).strict()])
const attemptSchema = z.object({ id: z.string().uuid(), owner, at, revision: count, operation: z.enum(['search', 'read']),
  phase: z.enum(['reserved', 'complete', 'failed']), charged: metrics, reserved: metrics, truncated: z.boolean().optional() }).strict()
const snapshotSchema = z.object({ capturedAt: at, since: at, guidance: ReflectionSpec.shape.guidance,
  missions: z.array(z.object({ value: object, fingerprint: shortHash }).strict()).max(10),
  records: z.array(z.object({ value: object, fingerprint: shortHash }).strict()).max(20),
  omissions: z.object({ missions: count, records: count, unavailable: count, partialRecords: count, selectionStopped: z.boolean() }).strict(), contextOnly: z.literal(true) }).strict()
const reflectionSchema = z.object({ id: shortHash, missionId: id, scheduleId: id, scheduleRevision: positive, capturedAt: at,
  snapshotHash: shortHash, bytes: positive.max(262144), snapshot: snapshotSchema, captureVersion: z.literal(1).optional() }).strict()
const proposalSchema = z.object({ id: z.string().uuid(), runId: shortHash, revision: positive, status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: at, ticketId: id, assignmentId: id, rationale: ProposeReflection.shape.rationale, evidence: ProposeReflection.shape.evidence,
  candidate: ProposeReflection.shape.candidate, review: z.object({ at, note: ReviewReflection.shape.note,
    result: z.object({ kind: z.enum(['memory', 'mission']), id, version: positive.optional() }).strict().optional() }).strict().optional() }).strict()
const dimensions = ['calls', 'pages', 'bytes', 'nodes', 'millis'] as const
const zero = (): RecallMetrics => ({ calls: 0, pages: 0, bytes: 0, nodes: 0, millis: 0 })

export interface ContextStateVerification {
  version: 1; records: number; recallConfigurations: number; recallAttempts: number; reservedRecall: number; failedRecall: number;
  recallOwners: number; elapsedOverruns: number; recallBytes: number; reflectionRuns: number; snapshotBytes: number; capturedMissions: number;
  capturedRecords: number; proposals: number; readOwners: number; readCalls: number; readBytes: number; legacySnapshots: number; legacyCommands: number; digest: string
}

/** Authenticate stored context and charges against their original scope and policy; today's freshness/authority is irrelevant. */
export async function verifyContextState(db: DatabaseSync, signal: AbortSignal): Promise<ContextStateVerification> {
  const r = new StateReader(db, signal, 'context'), configurations = new Map<string, z.infer<typeof configuration>>()
  let legacyCommands = 0, recallAttempts = 0, reservedRecall = 0, failedRecall = 0, elapsedOverruns = 0, recallBytes = 0,
    snapshotBytes = 0, capturedMissions = 0, capturedRecords = 0, readOwners = 0, readCalls = 0, readBytes = 0, legacySnapshots = 0
  for (const row of r.rows('workspace_recall_config')) {
    await r.step(); const value = r.json(row.value, configuration, 'recall_configuration')
    r.same([row.revision, value.revision], [configurations.size, configurations.size], 'recall_revision')
    if (!value.revision) r.same(value.policy, DEFAULT_RECALL, 'recall_initial_policy')
    configurations.set(String(value.revision), value)
  }
  let configCommand = 0
  for (const row of r.rows('workspace_recall_command')) {
    await r.step(); r.parse(SaveRecall.shape.requestId, row.id, 'recall_request'); r.parse(shortHash, row.fingerprint, 'recall_request_hash')
    const next = r.needed(configurations, String(++configCommand), 'recall_configuration_command')
    // Configuration commands are the only operation in this table, so even old request hashes are reconstructable.
    const request = { requestId: row.id, revision: next.revision - 1, policy: next.policy }
    r.same(row.fingerprint, key(JSON.stringify(request)), 'recall_configuration_request')
    if (row.request !== undefined && row.request !== null) r.same(r.json(row.request, SaveRecall, 'recall_request'), request, 'recall_request')
  }
  r.same(configCommand, Math.max(0, configurations.size - 1), 'recall_command_count')
  const totals = new Map<string, RecallMetrics>()
  for (const row of r.rows('workspace_recall_attempt')) {
    await r.step(); const value = r.json(row.value, attemptSchema, 'recall_attempt'), policy = r.needed(configurations, String(value.revision), 'recall_policy').policy
    r.same([row.id, row.owner], [value.id, value.owner.id], 'recall_attempt_identity')
    if (value.owner.role === 'router') r.same([value.owner.id, value.owner.day], [`router:${value.at.slice(0, 10)}`, value.at.slice(0, 10)], 'recall_router')
    else {
      const binding = value.owner, ticket = r.core<Ticket>('ticket', binding.ticketId)
      r.same(value.owner.id, `worker:${ticket.id}:${value.owner.assignmentId}`, 'recall_worker')
      if (!ticket.assignments.some(item => item.id === binding.assignmentId)) r.fail('reference', 'recall_assignment')
    }
    const before = totals.get(value.owner.id) ?? zero(), remaining = zero()
    for (const dimension of dimensions) remaining[dimension] = Math.max(0, policy.owner[dimension] - before[dimension])
    if (!remaining.calls || !remaining.pages || remaining.bytes < 4096 || !remaining.nodes || !remaining.millis) r.fail('allowance', 'recall_admission')
    const reserved = { calls: 1, pages: Math.min(policy.run.pages, remaining.pages), bytes: Math.min(policy.run.bytes, remaining.bytes),
      nodes: Math.min(policy.run.nodes, remaining.nodes), millis: Math.min(policy.run.millis, remaining.millis) }
    r.same(value.reserved, reserved, 'recall_reservation')
    if (value.phase === 'reserved') { r.same(value.charged, value.reserved, 'recall_unsettled'); if (value.truncated !== undefined) r.fail('conflict', 'recall_unsettled'); reservedRecall++ }
    else {
      r.same(value.charged.calls, 1, 'recall_call_charge')
      for (const dimension of ['pages', 'bytes', 'nodes'] as const) if (value.charged[dimension] > reserved[dimension]) r.fail('allowance', 'recall_charge')
      if (!value.charged.millis) r.fail('allowance', 'recall_elapsed')
      if (value.charged.millis > reserved.millis) elapsedOverruns++ // A synchronous operation can overrun its checked deadline.
      if (value.phase === 'failed') { r.same(value.charged.bytes, 0, 'recall_failed_bytes'); if (value.truncated !== undefined) r.fail('conflict', 'recall_failed'); failedRecall++ }
      else if (!value.charged.bytes || typeof value.truncated !== 'boolean') r.fail('shape', 'recall_completed')
    }
    for (const dimension of dimensions) before[dimension] = r.parse(count, before[dimension] + value.charged[dimension], 'recall_total')
    totals.set(value.owner.id, before); recallBytes += value.charged.bytes; recallAttempts++
  }
  const runs = new Map<string, ReflectionRun>(), reflectionMissions = new Set<string>()
  for (const row of r.rows('workspace_reflection')) {
    await r.step(); const value = r.json(row.value, reflectionSchema, 'reflection') as unknown as ReflectionRun
    r.same([row.id, row.mission], [value.id, value.missionId], 'reflection_identity')
    if (reflectionMissions.has(value.missionId)) r.fail('duplicate', 'reflection_mission')
    reflectionMissions.add(value.missionId); runs.set(value.id, value)
  }
  for (const value of runs.values()) {
    await r.step(); const serialized = JSON.stringify(value.snapshot), mission = r.core<Mission>('workspace_mission', value.missionId)
    const occurrence = r.core<ScheduleOccurrence>('workspace_occurrence', value.id)
    r.same([value.snapshotHash, value.bytes, value.capturedAt], [key(serialized), Buffer.byteLength(serialized), value.snapshot.capturedAt], 'reflection_snapshot')
    r.same([occurrence.missionId, occurrence.scheduleId, occurrence.revision], [value.missionId, value.scheduleId, value.scheduleRevision], 'reflection_occurrence')
    r.same(mission.schedule, { id: value.scheduleId, revision: value.scheduleRevision, occurrence: value.id, due: occurrence.due }, 'reflection_schedule')
    const saved = db.prepare('SELECT value FROM workspace_schedule_version WHERE schedule=? AND revision=?').get(value.scheduleId, value.scheduleRevision)
    if (!saved) r.fail('reference', 'reflection_schedule_version')
    const schedule = r.json(saved!.value, object, 'reflection_schedule_version') as unknown as Schedule
    const spec = r.parse(ReflectionSpec, schedule.definition.reflection, 'reflection_spec')
    r.same(value.snapshot.guidance, spec.guidance, 'reflection_guidance')
    if (value.bytes > spec.maxBytes || value.snapshot.missions.length > spec.maxMissions || value.snapshot.records.length > spec.maxRecords) r.fail('allowance', 'reflection_snapshot')
    if (value.captureVersion === 1) r.same(value.snapshot.since, new Date(Date.parse(value.capturedAt) - spec.lookbackHours * 3600000).toISOString(), 'reflection_lookback')
    else legacySnapshots++
    const selected = new Set<string>()
    for (const captured of value.snapshot.missions) {
      await r.step(); const item = captured.value
      r.parse(z.looseObject({ id, planVersion: positive, events: z.array(z.looseObject({ id: positive, at })).max(10) }), item, 'captured_mission')
      if (selected.has(item.id) || reflectionMissions.has(item.id) || spec.missionIds.length && !spec.missionIds.includes(item.id)) r.fail('scope', 'captured_mission')
      selected.add(item.id); r.core<Mission>('workspace_mission', item.id)
      r.same(captured.fingerprint, key(JSON.stringify({ ...item, events: [] })), 'captured_mission_fingerprint')
      const plan = db.prepare('SELECT value FROM workspace_plan_version WHERE mission=? AND version=?').get(item.id, item.planVersion)
      if (!plan) r.fail('reference', 'captured_plan')
      const original = r.json(plan!.value, object, 'captured_plan') as unknown as PlanVersion
      r.same(definitionOf(item), original.plan, 'captured_plan')
      let last = Number.MAX_SAFE_INTEGER
      for (const event of item.events) {
        await r.step(); if (event.id >= last) r.fail('history', 'captured_events'); last = event.id
        const stored = db.prepare('SELECT mission,value FROM workspace_event WHERE id=?').get(event.id)
        if (!stored) r.fail('reference', 'captured_event')
        r.same(stored!.mission, item.id, 'captured_event_owner')
        r.same({ ...r.json(stored!.value, object, 'captured_event'), id: event.id }, event, 'captured_event')
      }
      capturedMissions++
    }
    const scopes = new Set(['workspace', ...[...selected].map(identity => `mission:${identity}`)]), seen = new Set<string>()
    for (const captured of value.snapshot.records) {
      await r.step(); const item = captured.value
      r.parse(z.looseObject({ id: z.string().uuid(), revision: positive, hash: z.string(), archived: z.boolean(), expired: z.boolean(),
        superseded: z.boolean(), conflicted: z.boolean(), incoming: z.array(z.looseObject({ id, relation: z.string(), hash: z.string() })).max(50),
        incomingTruncated: z.boolean(), content: z.string().max(4000).nullable(), totalChars: count.nullable(), nextOffset: count.nullable(), contextOnly: z.literal(true) }), item, 'captured_record')
      if (seen.has(item.id) || !scopes.has(item.scope) || item.archived || item.createdAt < value.snapshot.since) r.fail('scope', 'captured_record')
      seen.add(item.id)
      const original = r.core<LibraryRecord>('workspace_library', item.id)
      for (const field of Object.keys(original) as (keyof LibraryRecord)[]) r.same(item[field], original[field], 'captured_record_metadata')
      const revision = Number(db.prepare('SELECT revision FROM workspace_library WHERE id=?').get(item.id)!.revision)
      if (item.revision > revision) r.fail('history', 'captured_record_revision')
      r.same(captured.fingerprint, key(JSON.stringify([item.id, item.revision, item.hash, item.archived, item.expired, item.superseded, item.conflicted])), 'captured_record_fingerprint')
      const blob = db.prepare('SELECT data FROM workspace_blob WHERE hash=?').get(item.hash)
      if (!blob || !(blob.data instanceof Uint8Array)) r.fail('reference', 'captured_blob')
      const data = Buffer.from(blob!.data as Uint8Array); r.charge(data.toString('base64'), 'captured_blob')
      r.same(createHash('sha256').update(data).digest('hex'), original.hash, 'captured_blob_hash')
      const text = original.text ? data.toString('utf8') : null
      r.same([item.content, item.totalChars, item.nextOffset], [text?.slice(0, 4000) ?? null, text?.length ?? null, text && text.length > 4000 ? 4000 : null], 'captured_content')
      for (const incoming of item.incoming) {
        await r.step(); const source = r.core<LibraryRecord>('workspace_library', incoming.id)
        if (!scopes.has(source.scope) || incoming.hash !== source.hash || !source.sources.some(edge => edge.id === item.id && edge.relation === incoming.relation)) r.fail('scope', 'captured_incoming')
      }
      capturedRecords++
    }
    snapshotBytes += value.bytes
  }
  const proposals = new Map<string, ReflectionProposal>(), proposalCounts = new Map<string, number>()
  for (const row of r.rows('workspace_reflection_proposal')) {
    await r.step(); const value = r.json(row.value, proposalSchema, 'reflection_proposal'), run = r.needed(runs, value.runId, 'proposal_run')
    r.same([row.id, row.run], [value.id, value.runId], 'proposal_identity')
    const ticket = r.core<Ticket>('ticket', value.ticketId), trigger = r.core<Trigger>('trigger', ticket.origin.triggerId)
    r.same([trigger.source, trigger.meta.mission], ['workspace', run.missionId], 'proposal_owner')
    if (!ticket.assignments.some(item => item.id === value.assignmentId)) r.fail('reference', 'proposal_assignment')
    if (!value.evidence.missions.length && !value.evidence.records.length || value.evidence.missions.some(identity => !run.snapshot.missions.some(item => item.value.id === identity))
      || value.evidence.records.some(identity => !run.snapshot.records.some(item => item.value.id === identity))) r.fail('scope', 'proposal_evidence')
    if ('missionId' in value.candidate && value.candidate.missionId && !value.evidence.missions.includes(value.candidate.missionId)) r.fail('scope', 'proposal_target')
    r.same(value.revision, value.status === 'pending' ? 1 : 2, 'proposal_revision')
    if (value.status === 'pending' ? !!value.review : !value.review) r.fail('history', 'proposal_review')
    if (value.status === 'approved' ? !value.review?.result : !!value.review?.result) r.fail('history', 'proposal_promotion')
    const tally = (proposalCounts.get(value.runId) ?? 0) + 1; if (tally > 10) r.fail('allowance', 'reflection_proposals')
    proposalCounts.set(value.runId, tally); proposals.set(value.id, value)
  }
  const submitted = new Set<string>(), reviewed = new Set<string>()
  for (const row of r.rows('workspace_reflection_command')) {
    await r.step(); const proposal = r.needed(proposals, String(row.proposal), 'reflection_command')
    r.parse(ProposeReflection.shape.requestId, row.id, 'reflection_command_id')
    let request: unknown
    if (row.actor === 'operator') {
      if (!proposal.review || reviewed.has(proposal.id)) r.fail('history', 'reflection_review_command')
      request = { runId: proposal.runId, proposalId: proposal.id, requestId: row.id, revision: 1,
        decision: proposal.status === 'approved' ? 'approve' : 'reject', note: proposal.review!.note }; reviewed.add(proposal.id)
    } else {
      r.same(row.actor, key(proposal.ticketId, proposal.assignmentId), 'reflection_command_actor')
      if (submitted.has(proposal.id)) r.fail('history', 'reflection_submit_command')
      request = { requestId: row.id, rationale: proposal.rationale, evidence: proposal.evidence, candidate: proposal.candidate }; submitted.add(proposal.id)
    }
    r.same(row.fingerprint, key(JSON.stringify(request)), 'reflection_command_hash')
    if (row.request !== undefined && row.request !== null) r.same(r.json(row.request, object, 'reflection_command_request'), request, 'reflection_command_request')
  }
  for (const proposal of proposals.values()) {
    await r.step(); if (!submitted.has(proposal.id) || proposal.status !== 'pending' && !reviewed.has(proposal.id)) r.fail('reference', 'reflection_command_history')
  }
  const readBindings = new Map<string, ReflectionRun>()
  const byMission = new Map([...runs.values()].map(run => [run.missionId, run]))
  if (runs.size) for (const row of r.rows('ticket')) {
    await r.step(); const ticket = r.json(row.value, object, 'reflection_read_ticket') as unknown as Ticket
    const trigger = r.core<Trigger>('trigger', ticket.origin.triggerId)
    const run = typeof trigger.meta.mission === 'string' ? byMission.get(trigger.meta.mission) : undefined
    if (!run) continue
    for (const assignment of ticket.assignments) { await r.step(); readBindings.set(key(ticket.id, assignment.id), run) }
  }
  for (const row of r.rows('workspace_reflection_read')) {
    await r.step(); const run = r.needed(readBindings, String(row.owner), 'reflection_read_owner')
    r.parse(positive.max(100), row.calls, 'reflection_read_calls'); r.parse(positive.max(Math.max(65536, run.bytes * 8)), row.bytes, 'reflection_read_bytes')
    readOwners++; readCalls += Number(row.calls); readBytes += Number(row.bytes)
  }
  return { version: 1, records: r.records, recallConfigurations: configurations.size, recallAttempts, reservedRecall, failedRecall, recallOwners: totals.size,
    elapsedOverruns, recallBytes, reflectionRuns: runs.size, snapshotBytes, capturedMissions, capturedRecords, proposals: proposals.size,
    readOwners, readCalls, readBytes, legacySnapshots, legacyCommands, digest: r.digest() }
}
