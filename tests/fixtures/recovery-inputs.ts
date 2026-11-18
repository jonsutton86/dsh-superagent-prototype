import { type UserMessage } from '@deepseek-ai/dsh-llm'
import { messageId } from '../../src/app/delivery.ts'
import { key, type Ticket, type TicketInput, type Trigger } from '../../src/core/index.ts'
import type { Store } from '../../src/app/store.ts'

export const inputTime = '2026-01-02T03:04:05.000Z'
export const inputMessage = (id: string): UserMessage => ({ role: 'user', id: messageId(key(id)),
  source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Original input' }] })
export function inputTicket(id = 'ticket', inputs: TicketInput[] = [{ id: 'input', kind: 'trigger', triggerId: 'trigger', at: inputTime, readAt: null, deliveredTo: 'assignment' }]): Ticket {
  return { id, title: 'Recovery input fixture', decisionId: 'decision',
    mandate: { strength: 'explicit', policyVersion: 'policy', basis: { via: 'addressed', addressed: 'direct' }, actor: { source: 'chat', id: 'operator' }, scope: 'Original scope' },
    channels: [], assignments: [{ id: 'assignment', state: 'running', createdAt: inputTime, startedAt: inputTime }],
    inputs, undelivered: inputs.map(input => input.id), createdAt: inputTime, updatedAt: inputTime, origin: { triggerId: 'trigger', triggerIds: ['trigger'] } }
}
/** Give integration fixtures the same recorded causal history required of a real accepted ticket. */
export function seedInputTicket(store: Store, ticket: Ticket): void {
  const ref = { source: 'chat', id: 'recovery-input' }, threadKey = 'chat:recovery-input', evalId = 'input-evaluation'
  const triggers = new Set([...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => 'triggerId' in input ? [input.triggerId] : [])])
  for (const id of triggers) {
    const trigger: Trigger = { id, source: ref.source, threads: [ref], actor: ticket.mandate.actor, human: true, at: inputTime, text: 'Original request', meta: {} }
    store.triggers.save(trigger)
    store.triggers.saveDisposition(id, { fanout: [ticket.id], at: inputTime,
      ...ticket.origin.triggerIds.includes(id) ? { evalId, decisionId: ticket.decisionId } : {} })
  }
  store.threads.save({ key: threadKey, ref, createdAt: inputTime, subscriptions: [ticket.id], correlated: [], pending: [], meta: {} })
  store.decisions.save({ id: ticket.decisionId, evalId, threadKey, triggerIds: ticket.origin.triggerIds, policyVersion: ticket.mandate.policyVersion,
    at: inputTime, kind: 'accept', reason: [{ code: 'requested' }], strength: ticket.mandate.strength, ticketId: ticket.id, mandate: ticket.mandate })
  store.tickets.save(ticket)
}
