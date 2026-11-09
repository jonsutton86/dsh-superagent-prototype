/** Reconcile the recorded Engine authority graph without admitting inputs, deciding work or executing queued effects. */
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { threadKey, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'
import type { Receipt } from '../app/store.ts'

const id = z.string().min(1).max(4096), text = z.string().max(8 * 1024 * 1024)
const ids = z.array(id).max(100000).refine(value => new Set(value).size === value.length)
const ref = z.looseObject({ source: id, id })
const actor = z.looseObject({ source: id, id: z.string().max(4096) })
const channel = z.looseObject({ source: id, thread: id, address: z.record(z.string(), z.string()) })
const environment = z.looseObject({ environmentId: id, revision: z.number().int().positive(), epoch: z.number().int().positive(), world: id.optional() })
const location = z.looseObject({ directory: id, mode: z.enum(['local', 'repository']).optional(), environment: environment.optional() })
const received = { source: id.optional(), scope: z.record(z.string(), z.unknown()).optional(), row: id.optional(), sender: id.optional(), rules: ids.optional() }
const modes = z.enum(['off', 'observe', 'auto']), addressed = z.enum(['mention', 'direct'])
const basis = z.discriminatedUnion('via', [
  z.looseObject({ ...received, via: z.literal('addressed'), addressed }),
  z.looseObject({ ...received, via: z.literal('followup'), authority: z.string().optional() }),
  z.looseObject({ ...received, via: z.literal('admission'), cell: z.enum(['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']),
    addressed: addressed.optional(), observation: z.looseObject({ mode: modes }).optional() }),
  z.looseObject({ ...received, via: z.literal('listed'), authority: z.string().optional(), addressed: addressed.optional(),
    observation: z.looseObject({ mode: modes.optional() }).optional() }),
  z.looseObject({ ...received, via: z.literal('bot'), addressed: addressed.optional(), observation: z.looseObject({ mode: modes }) }),
])
const mandate = z.looseObject({ strength: z.enum(['explicit', 'inferred']), policyVersion: id, actor, scope: text,
  basis, environment: environment.optional() })
const evaluation = z.looseObject({ id, threadKey: id, triggerIds: ids.nonempty(), primary: id.optional(), strength: z.enum(['explicit', 'inferred']),
  actor, basis, policyVersion: id, startedAt: id, deadline: id, delivered: id.optional(), pausedAt: id.optional() })
const inputBase = { id, at: id, readAt: z.string().nullable().optional(), deliveredTo: id.optional(), deliveredAt: id.optional() }
const input = z.discriminatedUnion('kind', [
  z.looseObject({ ...inputBase, kind: z.literal('trigger'), triggerId: id, human: z.literal(true).optional(), context: z.literal(true).optional() }),
  z.looseObject({ ...inputBase, kind: z.literal('resumed'), triggerId: id }),
  z.looseObject({ ...inputBase, kind: z.literal('reopen'), decisionId: id }),
  z.looseObject({ ...inputBase, kind: z.literal('policy-changed'), from: id, to: id }),
  z.looseObject({ ...inputBase, kind: z.literal('text'), text }), z.looseObject({ ...inputBase, kind: z.literal('note'), text }),
])
const schemas = {
  trigger: z.looseObject({ id, source: id, threads: z.array(ref).min(1).max(10000), actor, human: z.boolean(), at: id, text,
    channel: channel.optional(), meta: z.record(z.string(), z.unknown()) }),
  disposition: z.looseObject({ fanout: ids, at: id, recipient: id.optional(), evalId: id.optional(), decisionId: id.optional(),
    context: ids.optional(), acked: ids.optional(), handbacks: z.array(z.looseObject({ ticketId: id, reason: text, at: id })).max(100000).optional(),
    filtered: z.looseObject({ code: id }).optional(), requeued: z.literal(true).optional() }),
  thread: z.looseObject({ key: id, ref, createdAt: id, subscriptions: ids, context: ids.optional(), correlated: ids,
    pending: ids, evaluating: evaluation.optional(), meta: z.record(z.string(), z.unknown()) }),
  decision: z.looseObject({ id, evalId: id, threadKey: id, triggerIds: ids.nonempty(), policyVersion: id, at: id,
    kind: z.enum(['ignore', 'accept', 'reopen', 'stop', 'unavailable']), strength: z.enum(['explicit', 'inferred']),
    reason: z.array(z.looseObject({ code: id })).max(100000), ticketId: id.optional(), mandate: mandate.optional() }),
  ticket: z.looseObject({ id, title: text, decisionId: id, mandate, channels: z.array(channel).max(100000),
    origin: z.looseObject({ triggerId: id, triggerIds: ids.nonempty() }), createdAt: id, updatedAt: id,
    assignments: z.array(z.looseObject({ id, state: z.enum(['pending', 'running', 'ended']), createdAt: id, execution: location.optional(),
      startedAt: id.optional(), endedAt: id.optional(), deliveredAt: id.optional(), idleAt: id.optional(), endedReason: text.optional(),
      report: z.looseObject({ state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']), summary: text, at: id }).optional() })).max(100000),
    inputs: z.array(input).max(100000), undelivered: ids,
    follows: z.array(z.looseObject({ thread: id, own: z.boolean(), closed: z.looseObject({ at: id, outcome: z.enum(['merged', 'closed']) }).optional() })).max(100000).optional(), answers: ids.optional(),
    attention: z.looseObject({ id, question: text, triggerId: id.optional() }).optional(),
    ended: z.looseObject({ at: id, by: z.enum(['executor', 'human']), outcome: z.enum(['completed', 'merged', 'closed', 'dropped', 'stopped']) }).optional(),
    delivery: z.looseObject({ error: text, at: id }).optional(), execution: location.extend({ name: id, assignment: text }).optional() }),
  outbox: z.looseObject({ id, channel, text, kind: z.enum(['acknowledgement', 'reply', 'notice']), ticketId: id.optional(),
    status: z.enum(['pending', 'sent', 'dropped']), dropped: z.looseObject({ at: id, reason: z.enum(['channelGone', 'channelIgnored']) }).optional() }),
}
const effectPayload = {
  assessment: z.object({ triggerId: id }).strict(), launch: z.object({ ticketId: id, assignmentId: id }).strict(),
  delivery: z.object({ ticketId: id }).strict(), reply: z.object({}).strict(), relay: z.object({ text }).strict(),
  notice: z.object({ value: z.record(z.string(), z.unknown()), summary: text }).strict(),
}
export interface StateGraphReconciliation {
  version: 1; triggers: number; dispositions: number; threads: number; evaluations: number; decisions: number;
  tickets: number; assignments: number; inputs: number; outbox: number; effects: number; historicalEvaluations: number;
  indexes: { triggerTimes: number; triggerThreads: number; decisionThreads: number }; retiredEffects: number; digest: string;
}
/** Codes identify the conflicting relation; raw source text and credentials never enter diagnostics. */
export class StateGraphError extends Error {
  constructor(readonly code: string, readonly record: string) { super(`recovery_graph_${code}: ${record.slice(0, 200)}`) }
}

/** Validate immutable recorded authority first, then repair only secondary indexes and proven-obsolete queue rows atomically. */
export async function reconcileStateGraph(db: DatabaseSync, signal: AbortSignal): Promise<StateGraphReconciliation> {
  function fail(code: string, record: string): never { throw new StateGraphError(code, record) }
  let rows = 0, bytes = 0, links = 0, ticks = 0
  const checkpoint = async () => { signal.throwIfAborted(); if (++ticks % 128 === 0) await setImmediate(undefined, { signal }) }
  const budget = (count = 1) => { signal.throwIfAborted(); links += count; if (links > 2_000_000) fail('limit', 'links') }
  const load = async <T>(table: keyof typeof schemas): Promise<Map<string, T>> => {
    const result = new Map<string, T>(), column = table === 'thread' ? 'key' : 'id'
    for (const row of db.prepare(`SELECT ${column} AS identity,value FROM ${table} ORDER BY ${column}`).iterate()) {
      signal.throwIfAborted(); rows++; bytes += Buffer.byteLength(String(row.value))
      if (rows > 250000 || bytes > 512 * 1024 * 1024 || Buffer.byteLength(String(row.value)) > 16 * 1024 * 1024) fail('limit', table)
      let value: unknown
      try { value = JSON.parse(String(row.value)); schemas[table].parse(value) } catch { fail('shape', `${table}:${row.identity}`) }
      if (table !== 'disposition' && (value as Record<string, unknown>)[column] !== row.identity) fail('identity', `${table}:${row.identity}`)
      result.set(String(row.identity), value as T)
      if (rows % 128 === 0) await setImmediate(undefined, { signal })
    }
    return result
  }
  db.exec('SAVEPOINT recovery_state_graph')
  try {
    const triggers = await load<Trigger>('trigger'), dispositions = await load<TriggerDisposition>('disposition'), threads = await load<Thread>('thread'),
      decisions = await load<Decision>('decision'), tickets = await load<Ticket>('ticket'), outbox = await load<Receipt>('outbox')
    const require = <T>(map: Map<string, T>, key: string, relation: string): T => { budget(); return map.get(key) ?? fail('reference', `${relation}:${key}`) }
    const evaluations = new Map<string, NonNullable<Thread['evaluating']>>(), byEval = new Map<string, Decision>(), assignments = new Map<string, { ticket: Ticket; index: number }>()
    const batches = new Map<string, Set<string>>()
    const same = (left: unknown, right: unknown, relation: string) => { if (!isDeepStrictEqual(left, right)) fail('conflict', relation) }
    for (const thread of threads.values()) {
      await checkpoint()
      budget(thread.pending.length + thread.subscriptions.length + thread.correlated.length + (thread.context?.length ?? 0))
      same(thread.key, threadKey(thread.ref), `thread:${thread.key}`)
      for (const linked of [...thread.subscriptions, ...thread.context ?? []]) require(tickets, linked, 'subscription')
      for (const linked of thread.correlated) require(threads, linked, 'correlation')
      for (const triggerId of thread.pending) same(threadKey(require(triggers, triggerId, 'pending').threads[0]!), thread.key, `pending:${triggerId}`)
      const evaluation = thread.evaluating
      if (evaluation) {
        const pending = new Set(thread.pending)
        if (evaluations.has(evaluation.id)) fail('duplicate_evaluation', evaluation.id)
        evaluations.set(evaluation.id, evaluation); batches.set(evaluation.id, new Set(evaluation.triggerIds))
        same(evaluation.threadKey, thread.key, `evaluation:${evaluation.id}`)
        for (const triggerId of evaluation.triggerIds) {
          same(threadKey(require(triggers, triggerId, 'evaluation').threads[0]!), thread.key, `evaluation:${triggerId}`)
          if (pending.has(triggerId)) fail('pending_evaluation_overlap', triggerId)
        }
        if (evaluation.primary) {
          if (!batches.get(evaluation.id)!.has(evaluation.primary)) fail('primary', evaluation.id)
          same(evaluation.actor, require(triggers, evaluation.primary, 'evaluation_primary').actor, `evaluation_actor:${evaluation.id}`)
        }
      }
    }
    for (const decision of decisions.values()) {
      await checkpoint()
      require(threads, decision.threadKey, 'decision_thread')
      if (evaluations.has(decision.evalId) || byEval.has(decision.evalId)) fail('evaluation_decision_overlap', decision.evalId)
      byEval.set(decision.evalId, decision); batches.set(decision.evalId, new Set(decision.triggerIds))
      for (const triggerId of decision.triggerIds) same(threadKey(require(triggers, triggerId, 'decision_trigger').threads[0]!), decision.threadKey, `decision:${decision.id}`)
      if (decision.ticketId) require(tickets, decision.ticketId, 'decision_ticket')
      if (decision.kind === 'accept' && (!decision.ticketId || !decision.mandate)) fail('acceptance', decision.id)
      if (decision.kind === 'accept') {
        same(require(tickets, decision.ticketId!, 'acceptance').decisionId, decision.id, `acceptance:${decision.id}`)
        same(decision.mandate!.policyVersion, decision.policyVersion, `acceptance_policy:${decision.id}`)
        same(decision.mandate!.strength, decision.strength, `acceptance_strength:${decision.id}`)
      }
      for (const triggerId of decision.triggerIds) {
        const recipient = dispositions.get(triggerId)?.recipient
        if (recipient && (decision.kind === 'accept' || decision.kind === 'stop' && decision.ticketId !== recipient)) fail('directed_authority', decision.id)
      }
    }
    let inputCount = 0
    for (const ticket of tickets.values()) {
      await checkpoint()
      budget(ticket.inputs.length + ticket.assignments.length + ticket.undelivered.length)
      const accepted = require(decisions, ticket.decisionId, 'ticket_decision')
      if (accepted.kind !== 'accept' || accepted.ticketId !== ticket.id || !accepted.mandate) fail('acceptance', ticket.id)
      const { environment: _hostGrant, ...originalMandate } = ticket.mandate
      const { environment: _decisionGrant, ...decisionMandate } = accepted.mandate
      same(originalMandate, decisionMandate, `mandate:${ticket.id}`)
      if (accepted.mandate.environment) same(accepted.mandate.environment, ticket.mandate.environment, `mandate_environment:${ticket.id}`)
      same(ticket.origin.triggerIds, accepted.triggerIds, `origin:${ticket.id}`)
      if (!ticket.origin.triggerIds.includes(ticket.origin.triggerId)) fail('primary', ticket.id)
      for (const triggerId of ticket.origin.triggerIds) require(triggers, triggerId, 'origin')
      if (!ticket.origin.triggerIds.some(triggerId => isDeepStrictEqual(triggers.get(triggerId)!.actor, ticket.mandate.actor))) fail('mandate_actor', ticket.id)
      let active = 0
      for (const [index, assignment] of ticket.assignments.entries()) {
        if (assignments.has(assignment.id)) fail('duplicate_assignment', assignment.id)
        assignments.set(assignment.id, { ticket, index })
        if (assignment.state !== 'ended') {
          active++; if (index !== ticket.assignments.length - 1 || ticket.ended) fail('assignment_lifecycle', assignment.id)
          if (assignment.execution && ticket.execution) same(assignment.execution, {
            directory: ticket.execution.directory, ...(ticket.execution.mode ? { mode: ticket.execution.mode } : {}),
            ...(ticket.execution.environment ? { environment: ticket.execution.environment } : {}),
          }, `assignment_execution:${assignment.id}`)
        }
      }
      if (active > 1) fail('assignment_lifecycle', ticket.id)
      if (ticket.execution) same(ticket.execution.environment, ticket.mandate.environment, `execution_environment:${ticket.id}`)
      const inputs = new Set<string>(), assignmentIds = new Set(ticket.assignments.map(item => item.id))
      for (const input of ticket.inputs) {
        inputCount++; if (inputs.has(input.id)) fail('duplicate_input', ticket.id); inputs.add(input.id)
        if (input.deliveredTo && !assignmentIds.has(input.deliveredTo)) fail('input_assignment', input.id)
        if (input.kind === 'trigger' || input.kind === 'resumed') {
          const trigger = require(triggers, input.triggerId, 'input_trigger')
          if ((input.kind === 'resumed' || input.human) && !trigger.human) fail('input_authority', input.id)
          const recipient = dispositions.get(input.triggerId)?.recipient
          if (recipient && recipient !== ticket.id) fail('directed_authority', input.id)
        } else if (input.kind === 'reopen') {
          if (require(decisions, input.decisionId, 'input_decision').ticketId !== ticket.id) fail('input_authority', input.id)
        }
      }
      for (const waiting of ticket.undelivered) if (!inputs.has(waiting)) fail('undelivered', waiting)
      for (const follow of ticket.follows ?? []) require(threads, follow.thread, 'follow')
      for (const triggerId of [...ticket.answers ?? [], ...ticket.attention?.triggerId ? [ticket.attention.triggerId] : []])
        if (!require(triggers, triggerId, 'question_answer').human) fail('input_authority', triggerId)
    }
    const historicalEvaluations = new Set<string>()
    for (const [triggerId, disposition] of dispositions) {
      await checkpoint()
      const trigger = require(triggers, triggerId, 'disposition')
      for (const ticketId of [...disposition.fanout, ...disposition.context ?? [], ...disposition.acked ?? [],
        ...disposition.handbacks?.map(value => value.ticketId) ?? [], ...disposition.recipient ? [disposition.recipient] : []]) require(tickets, ticketId, 'disposition_ticket')
      if (disposition.recipient && (!trigger.human || disposition.fanout.some(ticketId => ticketId !== disposition.recipient))) fail('directed_authority', triggerId)
      if (disposition.decisionId && !batches.get(require(decisions, disposition.decisionId, 'disposition_decision').evalId)!.has(triggerId)) fail('disposition_decision', triggerId)
      if (disposition.evalId) {
        const evaluation = evaluations.get(disposition.evalId) ?? byEval.get(disposition.evalId)
        if (evaluation && !batches.get(disposition.evalId)!.has(triggerId)) fail('disposition_evaluation', triggerId)
        // Expiration removes an Eval without recording a Decision. Its disposition tag remains historical only.
        if (!evaluation) historicalEvaluations.add(disposition.evalId)
      }
    }
    for (const trigger of triggers.values()) {
      await checkpoint()
      budget(trigger.threads.length)
      const disposition = require(dispositions, trigger.id, 'trigger_disposition')
      if (!disposition.filtered) for (const ref of trigger.threads) require(threads, threadKey(ref), 'trigger_thread')
    }
    for (const receipt of outbox.values()) {
      await checkpoint()
      if (receipt.ticketId) require(tickets, receipt.ticketId, 'outbox_ticket')
      if ((receipt.status === 'dropped') !== !!receipt.dropped) fail('outbox_outcome', receipt.id)
    }
    const retired: { kind: string; key: string }[] = [], sequences = new Set<number>(), queuedReplies = new Set<string>()
    let effects = 0
    for (const row of db.prepare('SELECT * FROM effect ORDER BY seq,kind,key').iterate()) {
      budget(); effects++; bytes += Buffer.byteLength(String(row.value))
      if (++rows > 250000 || bytes > 512 * 1024 * 1024 || Buffer.byteLength(String(row.value)) > 16 * 1024 * 1024) fail('limit', 'effects')
      const kind = String(row.kind), key = String(row.key), schema = effectPayload[kind as keyof typeof effectPayload]
      if (!schema || !id.safeParse(key).success || !Number.isSafeInteger(row.seq) || Number(row.seq) < 0 || sequences.has(Number(row.seq))
        || !Number.isSafeInteger(row.generation) || Number(row.generation) < 0 || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0
        || !Number.isSafeInteger(row.due) || !id.safeParse(row.since).success || !text.safeParse(row.error).success) fail('effect_shape', `${kind}:${key}`)
      sequences.add(Number(row.seq))
      let value: Record<string, string>
      try { value = schema.parse(JSON.parse(String(row.value))) as Record<string, string> } catch { fail('effect_shape', `${kind}:${key}`) }
      let obsolete = false
      if (kind === 'launch') {
        const ticket = require(tickets, value!.ticketId!, 'launch'), assignment = assignments.get(value!.assignmentId!)
        if (!assignment || assignment.ticket.id !== ticket.id || key !== value!.assignmentId) fail('effect_reference', `launch:${key}`)
        obsolete = !!ticket.ended || ticket.assignments[assignment.index]!.state !== 'pending'
      } else if (kind === 'delivery') {
        const ticket = require(tickets, value!.ticketId!, 'delivery')
        if (key !== ticket.id) fail('effect_reference', `delivery:${key}`)
        obsolete = !!ticket.ended || !ticket.undelivered.length || !ticket.assignments.some(item => item.state === 'running')
      } else if (kind === 'assessment') {
        const trigger = require(triggers, value!.triggerId!, 'assessment')
        const evaluation = evaluations.get(key) ?? byEval.get(key)
        if (evaluation && !batches.get(key)!.has(value!.triggerId!)) fail('effect_reference', `assessment:${key}`)
        // The handler is a no-op unless the trigger is still held by this exact current Eval.
        const thread = require(threads, threadKey(trigger.threads[0]!), 'assessment_thread')
        obsolete = thread.evaluating?.id !== key
      } else if (kind === 'reply') {
        const receipt = require(outbox, key, 'reply'); queuedReplies.add(key); obsolete = receipt.status !== 'pending'
      }
      if (obsolete) retired.push({ kind, key })
      if (effects % 128 === 0) await setImmediate(undefined, { signal })
    }
    for (const receipt of outbox.values()) if (receipt.status === 'pending' && !queuedReplies.has(receipt.id)) fail('pending_reply_missing', receipt.id)
    // The authenticated aggregate is authoritative; SQL helper columns and thread membership rows are derived projections.
    const indexes = { triggerTimes: 0, triggerThreads: 0, decisionThreads: 0 }
    const expected = new Map<string, { thread: string; id: string; at: string; human: number }>()
    for (const trigger of triggers.values()) {
      await checkpoint()
      for (const ref of trigger.threads) {
        const thread = threadKey(ref), identity = JSON.stringify([thread, trigger.id])
        expected.set(identity, { thread, id: trigger.id, at: trigger.at, human: trigger.human ? 1 : 0 })
      }
    }
    const seen = new Set<string>(), remove: { thread: string; id: string }[] = []
    for (const row of db.prepare('SELECT * FROM trigger_thread').iterate()) {
      await checkpoint()
      budget(); const identity = JSON.stringify([row.thread, row.id]), value = expected.get(identity)
      if (!value || value.at !== row.at || value.human !== row.human) {
        remove.push({ thread: String(row.thread), id: String(row.id) })
      } else seen.add(identity)
    }
    for (const row of remove) { await checkpoint(); db.prepare('DELETE FROM trigger_thread WHERE thread=? AND id=?').run(row.thread, row.id); indexes.triggerThreads++ }
    for (const [identity, value] of expected) if (!seen.has(identity)) {
      await checkpoint()
      db.prepare('INSERT INTO trigger_thread VALUES (?,?,?,?)').run(value.thread, value.id, value.at, value.human); indexes.triggerThreads++
    }
    for (const trigger of triggers.values()) { await checkpoint(); indexes.triggerTimes += Number(db.prepare('UPDATE trigger SET at=? WHERE id=? AND at != ?').run(trigger.at, trigger.id, trigger.at).changes) }
    for (const decision of decisions.values()) { await checkpoint(); indexes.decisionThreads += Number(db.prepare('UPDATE decision SET thread=? WHERE id=? AND thread != ?').run(decision.threadKey, decision.id, decision.threadKey).changes) }
    for (const item of retired) { await checkpoint(); db.prepare('DELETE FROM effect WHERE kind=? AND key=?').run(item.kind, item.key) }
    const digest = createHash('sha256')
    for (const table of ['trigger', 'disposition', 'thread', 'decision', 'ticket', 'outbox', 'effect', 'trigger_thread']) {
      digest.update(table + '\n')
      const order = table === 'thread' ? 'key' : table === 'effect' ? 'kind,key' : table === 'trigger_thread' ? 'thread,id' : 'id'
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) {
        await checkpoint(); digest.update(JSON.stringify(row) + '\n')
      }
    }
    signal.throwIfAborted(); db.exec('RELEASE recovery_state_graph')
    return { version: 1, triggers: triggers.size, dispositions: dispositions.size, threads: threads.size, evaluations: evaluations.size,
      decisions: decisions.size, tickets: tickets.size, assignments: assignments.size, inputs: inputCount, outbox: outbox.size,
      effects, historicalEvaluations: historicalEvaluations.size, indexes, retiredEffects: retired.length, digest: digest.digest('hex') }
  } catch (error) { db.exec('ROLLBACK TO recovery_state_graph; RELEASE recovery_state_graph'); throw error }
}
