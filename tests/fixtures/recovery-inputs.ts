import { type UserMessage } from '@deepseek-ai/dsh-llm'
import { messageId } from '../../src/app/delivery.ts'
import { key, type Ticket, type TicketInput } from '../../src/core/index.ts'

export const inputTime = '2026-01-02T03:04:05.000Z'
export const inputMessage = (id: string): UserMessage => ({ role: 'user', id: messageId(key(id)),
  source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Original input' }] })
export function inputTicket(id = 'ticket', inputs: TicketInput[] = [{ id: 'input', kind: 'trigger', triggerId: 'trigger', at: inputTime, readAt: null, deliveredTo: 'assignment' }]): Ticket {
  return { id, title: 'Recovery input fixture', decisionId: 'decision',
    mandate: { strength: 'explicit', policyVersion: 'policy', basis: { via: 'addressed', addressed: 'direct' }, actor: { source: 'workspace', id: 'operator' }, scope: 'Original scope' },
    channels: [], assignments: [{ id: 'assignment', state: 'running', createdAt: inputTime, startedAt: inputTime }],
    inputs, undelivered: inputs.map(input => input.id), createdAt: inputTime, updatedAt: inputTime, origin: { triggerId: 'trigger', triggerIds: ['trigger'] } }
}
