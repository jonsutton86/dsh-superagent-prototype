/** Host restart admission derived from the existing, durable assignment history. */
import { key } from './ids.ts'
import type { Ticket, TicketInput } from './model.ts'

/** Automatic assignment replacements, distinct from Harness provider-request retries. */
export const AUTOMATIC_RESTART_LIMIT = 3

export interface AutomaticRestartBudget {
  limit: typeof AUTOMATIC_RESTART_LIMIT
  used: number
  remaining: number
  exhausted: boolean
}

/**
 * Count the automatic replacements immediately preceding the current assignment. An explicit retry, or an assignment
 * resumed after its ticket ended and received new human authorization, starts a new chain. A successful turn, report,
 * coordinator restart, or changed clock does not. This is admission history, not proof that prior work is quiescent.
 * Older histories may already exceed the limit; keep their actual count rather than rewriting or forgiving them.
 */
export function automaticRestartBudget(ticket: Pick<Ticket, 'assignments'>): AutomaticRestartBudget {
  let used = 0
  for (let index = ticket.assignments.length - 2; index >= 0; index--) {
    const assignment = ticket.assignments[index]!
    if (assignment.state !== 'ended' || assignment.endedReason !== 'hostRestarted') break
    used++
  }
  return { limit: AUTOMATIC_RESTART_LIMIT, used, remaining: Math.max(0, AUTOMATIC_RESTART_LIMIT - used),
    exhausted: used >= AUTOMATIC_RESTART_LIMIT }
}

/** The original recovery note minted by Tickets.restart, proven by its exact ID and recorded predecessor transition. */
export function isAutomaticRestartInput(ticket: Pick<Ticket, 'id' | 'assignments' | 'inputs'>, input: TicketInput | string | undefined): boolean {
  const value = typeof input === 'string' ? ticket.inputs.find(item => item.id === input) : input
  if (value?.kind !== 'text') return false
  return ticket.assignments.some((assignment, index) => index > 0 && ticket.assignments[index - 1]!.state === 'ended'
    && ticket.assignments[index - 1]!.endedReason === 'hostRestarted'
    && value.id === key('input', ticket.id, 'restart', assignment.id))
}
