/** Recorded model liabilities and speculative allocations in held recovery state; no reservation is released here. */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { key, type Ticket, type Trigger } from '../core/index.ts'
import type { Mission } from '../workspace/model.ts'
import { UsageTokens, ModelPrice, UsageBudget, SaveUsage, ReconcileUsage, type UsageCall } from '../usage/model.ts'
import { pricedUsage } from '../usage/service.ts'
import { SpeculationPolicy, SpeculationAllowance, SaveSpeculation, SpeculationCommand, ApproveSpeculationMessage, defaultSpeculation, type SpeculationRun } from '../speculation/model.ts'
import type { RegistryStateContext } from './registries.ts'
import { StateReader, stateAt as at, stateCount as count, statePositive as positive, stateId as id, stateKey as shortHash, stateObject as object } from './reader.ts'

const ownerSchema = z.object({ sessionId: id, root: id, role: z.enum(['orchestrator', 'worker']), ticketId: id.optional(),
  assignmentId: id.optional(), speculationId: shortHash.optional(), missionId: id.optional(), scheduleId: id.optional(), personaId: id.optional() }).strict()
const callSchema = z.object({ id: z.string().uuid(), owner: ownerSchema, provider: id, model: id, purpose: z.string().max(4096),
  startedAt: at, settledAt: at.optional(), phase: z.enum(['pending', 'reported', 'unknown', 'reconciled']), outcome: z.string().max(4096).optional(),
  configRevision: count, reservedTokens: positive.max(1e9).optional(), reservedCost: count.optional(), price: ModelPrice.optional(),
  tokens: UsageTokens.optional(), totalTokens: count.optional(), cost: count.optional(),
  reconciliation: z.object({ at, note: ReconcileUsage.shape.note, tokens: UsageTokens, cost: count.optional() }).strict().optional() }).strict()
const usageConfiguration = z.object({ revision: count, at, trackingSince: at, prices: z.array(ModelPrice).max(200), budgets: z.array(UsageBudget).max(100) }).strict()
const speculationConfiguration = z.object({ revision: count, at, policy: SpeculationPolicy }).strict()
const runSchema = z.object({ id: shortHash, ticketId: id, assignmentId: id, revision: positive, title: z.string().max(128000), owner: id, environment: id,
  createdAt: at, expiresAt: at, state: z.enum(['proposed', 'admitted', 'ready', 'promoted', 'expired', 'cancelled']), providers: z.array(id).max(10000),
  queuedPolicyRevision: count.optional(), policyRevision: count.optional(), allowance: SpeculationAllowance.optional(), admittedAt: at.optional(), deadline: at.optional(),
  execution: object.optional(), releasedAt: at.optional(), releaseEvidence: z.string().min(1).max(128000).optional(), recovered: z.literal(true).optional(),
  attestation: z.object({ at, note: SpeculationCommand.shape.note }).strict().optional(), problem: z.string().max(128000).optional(), evidence: id.optional(),
  report: z.string().max(128000).optional(), review: z.object({ at, note: SpeculationCommand.shape.note }).strict().optional() }).strict()
const usageRequest = z.union([SaveUsage.safeExtend({ operation: z.literal('configure') }),
  ReconcileUsage.extend({ operation: z.literal('reconcile'), id })])
const specRequest = z.union([SaveSpeculation.extend({ operation: z.literal('configure') }),
  SpeculationCommand.extend({ operation: z.literal('review'), id }), ApproveSpeculationMessage.extend({ operation: z.literal('message'), id })])

export interface BudgetStateVerification {
  version: 1; records: number; usageConfigurations: number; calls: number; pendingCalls: number; unknownCalls: number; reconciledCalls: number;
  usageBindings: number; legacyAssignments: number; missingSessionHeaders: number; tokens: number; cost: number; reservedTokens: number; reservedCost: number;
  speculationConfigurations: number; speculativeRuns: number; heldAllocations: number; releasedAllocations: number; promotedRuns: number;
  approvedMessages: number; legacyPolicies: number; legacyCommands: number; digest: string
}

/** Check recorded arithmetic, immutable attribution and original policy references; preserve uncertainty and stopped authority. */
export async function verifyBudgetState(db: DatabaseSync, context: RegistryStateContext, signal: AbortSignal): Promise<BudgetStateVerification> {
  const r = new StateReader(db, signal, 'budgets'), configs = new Map<string, z.infer<typeof usageConfiguration>>()
  let legacyCommands = 0, legacyAssignments = 0, missingSessionHeaders = 0, pendingCalls = 0, unknownCalls = 0, reconciledCalls = 0,
    tokens = 0, cost = 0, reservedTokens = 0, reservedCost = 0, heldAllocations = 0, releasedAllocations = 0, promotedRuns = 0, approvedMessages = 0, legacyPolicies = 0
  const add = (a: number, b: number, label: string) => r.parse(count, a + b, label)
  const tokenTotal = (value: UsageTokens) => r.parse(count, Math.max(value.totalTokens ?? 0,
    value.inputTokens + value.outputTokens + (value.cacheReadTokens ?? 0) + (value.cacheWriteTokens ?? 0)), 'usage_tokens')
  for (const row of r.rows('usage_configuration')) {
    await r.step(); const value = r.json(row.value, usageConfiguration, 'usage_configuration')
    r.same([row.revision, value.revision], [configs.size, configs.size], 'usage_revision')
    r.parse(SaveUsage, { requestId: 'inspection', revision: value.revision, prices: value.prices, budgets: value.budgets }, 'usage_configuration')
    if (!value.revision) r.same([value.prices, value.budgets, value.trackingSince], [[], [], value.at], 'usage_initial')
    else r.same(value.trackingSince, configs.get('0')!.trackingSince, 'usage_tracking_since')
    configs.set(String(value.revision), value)
  }
  const tickets = new Map<string, Ticket>()
  for (const row of r.rows('ticket')) { await r.step(); const ticket = r.json(row.value, object, 'usage_ticket') as unknown as Ticket; r.same(row.id, ticket.id, 'usage_ticket_id'); tickets.set(ticket.id, ticket) }
  const headers = new Map(context.sessions.map(session => [session.id, session.header]))
  const roots = new Map<string, string>([[context.masterId, context.masterId], ...[...tickets.keys()].map(identity => [`worker-${identity}`, `worker-${identity}`] as const)])
  async function root(identity: string): Promise<string> {
    const chain: string[] = [], seen = new Set<string>(); let cursor = identity
    while (!roots.has(cursor)) {
      await r.step(); if (seen.has(cursor)) r.fail('cycle', 'usage_session_ancestry'); seen.add(cursor); chain.push(cursor)
      const header = r.needed(headers, cursor, 'usage_session_header'); r.charge(header, 'usage_session_header')
      if (!header.parentSession) r.fail('reference', 'usage_session_root'); cursor = header.parentSession!
    }
    const bound = roots.get(cursor)!
    for (const child of chain) roots.set(child, bound)
    return bound
  }
  const bindings = new Map<string, string>()
  for (const row of r.rows('usage_session')) {
    await r.step(); const identity = r.parse(id, row.id, 'usage_session_id'), bound = r.parse(id, row.root, 'usage_session_binding')
    r.same(bound, await root(identity), 'usage_session_binding'); bindings.set(identity, bound)
    if (!headers.has(identity)) missingSessionHeaders++
  }
  const calls = new Map<string, UsageCall>()
  for (const row of r.rows('usage_call')) {
    await r.step(); const value = r.json(row.value, callSchema, 'usage_call'), config = r.needed(configs, String(value.configRevision), 'usage_configuration')
    r.same(row.id, value.id, 'usage_call_id')
    r.same(value.owner.root, await root(value.owner.sessionId), 'usage_owner_root')
    r.same(r.needed(bindings, value.owner.sessionId, 'usage_binding'), value.owner.root, 'usage_binding')
    if (value.owner.role === 'orchestrator') r.same(value.owner, { sessionId: value.owner.sessionId, root: context.masterId, role: 'orchestrator' }, 'usage_router_owner')
    else {
      if (!value.owner.ticketId) r.fail('reference', 'usage_owner_ticket')
      const ticket = r.needed(tickets, value.owner.ticketId!, 'usage_owner_ticket'), trigger = r.core<Trigger>('trigger', ticket.origin.triggerId)
      r.same(value.owner.root, `worker-${ticket.id}`, 'usage_worker_root')
      if (value.owner.assignmentId) { if (!ticket.assignments.some(item => item.id === value.owner.assignmentId)) r.fail('reference', 'usage_assignment') }
      else legacyAssignments++
      const missionId = trigger.source === 'workspace' && typeof trigger.meta.mission === 'string' ? trigger.meta.mission : undefined
      const mission = missionId ? r.core<Mission>('workspace_mission', missionId) : undefined
      r.same([value.owner.missionId, value.owner.scheduleId, value.owner.personaId], [missionId, mission?.schedule?.id, ticket.execution?.persona?.id], 'usage_scope')
    }
    const price = config.prices.find(item => item.provider === value.provider && item.model === value.model)
    r.same(value.price, price, 'usage_price_snapshot')
    const estimate = value.reservedTokens !== undefined && price ? r.parse(count, Number((BigInt(value.reservedTokens) * BigInt(Math.max(price.input, price.output, price.cacheRead, price.cacheWrite)) + 999999n) / 1000000n), 'usage_reserved_cost') : undefined
    r.same(value.reservedCost, estimate, 'usage_reservation')
    if (value.phase === 'pending' || value.phase === 'unknown') {
      if (value.tokens || value.totalTokens !== undefined || value.cost !== undefined || value.reconciliation) r.fail('conflict', 'usage_unsettled')
      if (value.phase === 'pending') { if (value.settledAt || value.outcome) r.fail('conflict', 'usage_pending'); pendingCalls++ }
      else { if (!value.outcome || !value.settledAt && value.outcome !== 'interrupted') r.fail('conflict', 'usage_unknown'); unknownCalls++ }
      reservedTokens = add(reservedTokens, value.reservedTokens ?? 0, 'reserved_tokens')
    } else if (value.phase === 'reported') {
      if (!value.tokens || !value.settledAt || value.outcome === undefined || value.reconciliation) r.fail('reference', 'usage_report')
      r.same([value.totalTokens, value.cost], [tokenTotal(value.tokens!), price ? pricedUsage(value.tokens!, price) : undefined], 'usage_reported_total')
    } else {
      const evidence = value.reconciliation
      if (!evidence || !price && evidence.cost === undefined || !value.outcome) r.fail('reference', 'usage_reconciliation')
      r.same([value.totalTokens, value.cost], [tokenTotal(evidence!.tokens), evidence!.cost ?? pricedUsage(evidence!.tokens, price!)], 'usage_reconciled_total')
      reconciledCalls++
    }
    if (value.cost === undefined) reservedCost = add(reservedCost, value.reservedCost ?? 0, 'reserved_cost')
    tokens = add(tokens, value.totalTokens ?? 0, 'usage_total_tokens'); cost = add(cost, value.cost ?? 0, 'usage_total_cost'); calls.set(value.id, value)
  }
  const configured = new Set<number>(), reconciled = new Set<string>()
  for (const row of r.rows('usage_command')) {
    await r.step(); r.parse(SaveUsage.shape.requestId, row.id, 'usage_command_id'); r.parse(shortHash, row.fingerprint, 'usage_command_hash')
    let request: z.infer<typeof usageRequest>
    if (row.request === undefined || row.request === null) {
      legacyCommands++; const candidates: z.infer<typeof usageRequest>[] = []
      for (const config of configs.values()) if (config.revision) {
        await r.step(); const candidate = { operation: 'configure' as const, requestId: String(row.id), revision: config.revision - 1, prices: config.prices, budgets: config.budgets }
        if (key(JSON.stringify(candidate)) === row.fingerprint) candidates.push(candidate)
      }
      for (const call of calls.values()) if (call.reconciliation) {
        await r.step(); const evidence = call.reconciliation, candidate = { operation: 'reconcile' as const, id: call.id,
          ...ReconcileUsage.parse({ requestId: row.id, tokens: evidence.tokens, ...(evidence.cost !== undefined ? { cost: evidence.cost } : {}), note: evidence.note }) }
        if (key(JSON.stringify(candidate)) === row.fingerprint) candidates.push(candidate)
      }
      if (candidates.length !== 1) r.fail('history', 'usage_legacy_command')
      request = candidates[0]!
    } else request = r.json(row.request, usageRequest, 'usage_command')
    r.same([row.id, row.fingerprint], [request.requestId, key(JSON.stringify(request))], 'usage_command_request')
    if (request.operation === 'configure') {
      const next = r.needed(configs, String(request.revision + 1), 'usage_configured_version')
      if (configured.has(next.revision)) r.fail('duplicate', 'usage_configure')
      r.same([next.prices, next.budgets], [request.prices, request.budgets], 'usage_configure'); configured.add(next.revision)
    } else {
      const call = r.needed(calls, request.id, 'usage_reconciled_call')
      if (reconciled.has(call.id) || call.phase !== 'reconciled' || !call.reconciliation) r.fail('conflict', 'usage_reconciliation_command')
      r.same([call.reconciliation!.note, call.reconciliation!.tokens, call.reconciliation!.cost], [request.note, request.tokens, request.cost], 'usage_reconciliation_command'); reconciled.add(call.id)
    }
  }
  r.same(configured.size + reconciled.size, Math.max(0, configs.size - 1) + reconciledCalls, 'usage_command_coverage')
  const policies = new Map<string, z.infer<typeof speculationConfiguration>>()
  for (const row of r.rows('speculation_configuration')) {
    await r.step(); const value = r.json(row.value, speculationConfiguration, 'speculation_configuration')
    r.same([row.revision, value.revision], [policies.size, policies.size], 'speculation_revision')
    if (!value.revision) r.same(value.policy, defaultSpeculation, 'speculation_initial_policy')
    policies.set(String(value.revision), value)
  }
  const runs = new Map<string, SpeculationRun>()
  for (const row of r.rows('speculation_run')) {
    await r.step(); const value = r.json(row.value, runSchema, 'speculation_run') as unknown as SpeculationRun
    const ticket = r.needed(tickets, value.ticketId, 'speculation_ticket'), assignment = ticket.assignments.find(item => item.id === value.assignmentId)
    if (!assignment || ticket.mandate.strength !== 'inferred') r.fail('authority', 'speculation_assignment')
    r.same([row.id, row.ticket, row.assignment, value.id, value.owner],
      [value.id, value.ticketId, value.assignmentId, key('speculation', value.ticketId, value.assignmentId), `${ticket.mandate.actor.source}:${ticket.mandate.actor.id}`], 'speculation_identity')
    r.parse(count, row.checked, 'speculation_checked')
    if (new Set(value.providers).size !== value.providers.length) r.fail('duplicate', 'speculation_provider')
    if (value.queuedPolicyRevision !== undefined) {
      const policy = r.needed(policies, String(value.queuedPolicyRevision), 'speculation_queued_policy').policy
      r.same(value.expiresAt, new Date(Date.parse(value.createdAt) + policy.ttlMinutes * 60000).toISOString(), 'speculation_expiry')
    } else legacyPolicies++
    if (value.admittedAt) {
      if (!value.allowance) r.fail('reference', 'speculation_allowance')
      if (value.policyRevision !== undefined) {
        const policy = r.needed(policies, String(value.policyRevision), 'speculation_admission_policy').policy
        r.same(value.allowance, policy.run, 'speculation_allowance'); if (!policy.enabled || !value.providers.length || !value.deadline) r.fail('authority', 'speculation_admission')
        if (value.queuedPolicyRevision !== undefined) r.same(value.deadline, new Date(Date.parse(value.admittedAt) + value.allowance!.seconds * 1000).toISOString(), 'speculation_deadline')
      } else legacyPolicies++ // Migrated pre-ledger work remains held until independently reconciled.
      if (value.execution) {
        const original = assignment!.execution
        if (original) r.same({ directory: value.execution.directory, ...(value.execution.mode ? { mode: value.execution.mode } : {}),
          ...(value.execution.environment ? { environment: value.execution.environment } : {}) }, original, 'speculation_execution')
        else legacyAssignments++
      }
      r.same(value.environment, value.execution?.environment?.environmentId ?? 'local', 'speculation_environment')
      if (value.releasedAt) {
        if (!value.releaseEvidence || value.recovered) r.fail('authority', 'speculation_release'); releasedAllocations++
      } else { if (value.releaseEvidence) r.fail('conflict', 'speculation_release'); heldAllocations++ }
    } else if (value.policyRevision !== undefined || value.allowance || value.deadline || value.releasedAt || value.releaseEvidence || value.execution || value.providers.length
      || ['admitted', 'ready', 'promoted'].includes(value.state)) r.fail('authority', 'speculation_unadmitted')
    if (['ready', 'promoted'].includes(value.state) && value.report === undefined) r.fail('reference', 'speculation_report')
    if (value.state === 'promoted') { if (!value.review || !value.evidence || !value.releasedAt) r.fail('authority', 'speculation_promotion'); promotedRuns++ }
    if (value.review && (!value.evidence || !value.releasedAt)) r.fail('reference', 'speculation_review')
    runs.set(value.id, value)
  }
  for (const call of calls.values()) if (call.owner.speculationId) {
    await r.step(); const run = r.needed(runs, call.owner.speculationId, 'usage_speculation')
    if (call.owner.ticketId !== run.ticketId || call.owner.assignmentId && call.owner.assignmentId !== run.assignmentId || !run.admittedAt) r.fail('authority', 'usage_speculation')
    if (run.policyRevision !== undefined && !run.providers.includes(call.provider)) r.fail('authority', 'speculation_usage_provider')
    if (run.releasedAt && ['pending', 'unknown'].includes(call.phase)) r.fail('authority', 'speculation_unsettled_release')
  }
  const specConfigured = new Set<number>(), reviews = new Map<string, z.infer<typeof specRequest>[]>(), messageCommands = new Map<string, z.infer<typeof specRequest>[]>()
  const opaqueSpecRuns = new Set<string>()
  for (const row of r.rows('speculation_command')) {
    await r.step(); r.parse(SaveSpeculation.shape.requestId, row.id, 'speculation_request_id'); r.parse(shortHash, row.fingerprint, 'speculation_request_hash')
    if (row.request === undefined || row.request === null) {
      legacyCommands++; const result = r.json(row.result, z.union([id, speculationConfiguration]), 'speculation_legacy_result')
      if (typeof result === 'string') { r.needed(runs, result, 'speculation_legacy_result'); opaqueSpecRuns.add(result) }
      else {
        const original = r.needed(policies, String(result.revision), 'speculation_legacy_configuration')
        if (!result.revision || specConfigured.has(result.revision)) r.fail('history', 'speculation_legacy_configuration')
        r.same(result, original, 'speculation_legacy_configuration'); r.same(row.fingerprint, key(JSON.stringify({ operation: 'configure', requestId: row.id,
          revision: result.revision - 1, policy: result.policy })), 'speculation_legacy_configuration_request'); specConfigured.add(result.revision)
      }
      continue
    }
    const request = r.json(row.request, specRequest, 'speculation_request')
    r.same([row.id, row.fingerprint], [request.requestId, key(JSON.stringify(request))], 'speculation_request_hash')
    if (request.operation === 'configure') {
      const next = r.needed(policies, String(request.revision + 1), 'speculation_configured_version')
      if (specConfigured.has(next.revision)) r.fail('duplicate', 'speculation_configuration_command')
      r.same(next.policy, request.policy, 'speculation_configuration_command'); r.same(r.json(row.result, speculationConfiguration, 'speculation_configured_result'), next, 'speculation_configured_result'); specConfigured.add(next.revision)
    } else {
      const run = r.needed(runs, request.id, 'speculation_command_run')
      r.same(r.json(row.result, id, 'speculation_command_result'), run.id, 'speculation_command_result')
      if (request.revision > run.revision || request.operation === 'review' && request.revision === run.revision) r.fail('history', 'speculation_command_revision')
      const catalog = request.operation === 'review' ? reviews : messageCommands, identity = request.operation === 'review' ? run.id : request.receiptId
      const list = catalog.get(identity) ?? []; list.push(request); catalog.set(identity, list)
      if (request.operation === 'review' && request.command === 'promote') r.same([run.review?.note, run.evidence], [request.note, request.evidence], 'speculation_promotion_command')
    }
  }
  r.same(specConfigured.size, Math.max(0, policies.size - 1), 'speculation_configuration_commands')
  for (const run of runs.values()) {
    await r.step(); const commands = reviews.get(run.id) ?? []
    if (run.review && !commands.some(request => request.operation === 'review' && request.command === 'promote') && !opaqueSpecRuns.has(run.id)) r.fail('reference', 'speculation_review_command')
    const attestations = commands.filter(request => request.operation === 'review' && request.command === 'reconcile').sort((a, b) => ('revision' in b ? b.revision : 0) - ('revision' in a ? a.revision : 0))
    if (run.attestation && !attestations.length && !opaqueSpecRuns.has(run.id)) r.fail('reference', 'speculation_attestation_command')
    if (attestations.length) r.same(run.attestation?.note, 'note' in attestations[0]! ? attestations[0]!.note : undefined, 'speculation_attestation')
  }
  for (const row of r.rows('speculation_message')) {
    await r.step(); const run = r.needed(runs, String(row.run), 'speculation_message_run'), message = r.core<Record<string, unknown>>('outbox', String(row.id))
    if (!run.review || !run.releasedAt) r.fail('authority', 'speculation_message')
    r.same([message.ticketId, row.fingerprint], [run.ticketId, key(JSON.stringify({ id: message.id, ticketId: message.ticketId, channel: message.channel, text: message.text, kind: message.kind }))], 'speculation_message_binding')
    const candidates = messageCommands.get(String(row.id)) ?? []
    r.parse(SpeculationCommand.shape.note, row.note, 'speculation_message_note')
    if (!candidates.some(request => request.operation === 'message' && request.id === run.id && request.fingerprint === row.fingerprint && request.note === row.note) && !opaqueSpecRuns.has(run.id)) r.fail('reference', 'speculation_message_command')
    approvedMessages++
  }
  return { version: 1, records: r.records, usageConfigurations: configs.size, calls: calls.size, pendingCalls, unknownCalls, reconciledCalls, usageBindings: bindings.size,
    legacyAssignments, missingSessionHeaders, tokens, cost, reservedTokens, reservedCost, speculationConfigurations: policies.size, speculativeRuns: runs.size,
    heldAllocations, releasedAllocations, promotedRuns, approvedMessages, legacyPolicies, legacyCommands, digest: r.digest() }
}
