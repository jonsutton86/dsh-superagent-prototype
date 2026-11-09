/** Reconcile consumed input acknowledgements against authenticated Harness history while the restore remains held. */
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { deliveryId, messageId } from '../app/delivery.ts'
import { key, type Ticket } from '../core/index.ts'
import { scanSession, type SessionArchive } from './sessions.ts'

export interface InputStateReconciliation { tickets: number; inputs: number; consumed: number; readMarkers: number; undelivered: number }
/** A contradictory input acknowledgement cannot authorize replay or rewrite historical ticket outcomes. */
export class InputStateError extends Error {
  constructor(readonly code: 'input_state_invalid' | 'input_read_missing' | 'input_delivery_duplicate') { super(code) }
}

/**
 * Apply only missing consumption acknowledgements on live tickets. The caller owns this private Store and all destination
 * Session writers. Each complete archive is authenticated before its ticket changes; any later failure rolls back the batch.
 */
export async function reconcileConsumedInputs(db: DatabaseSync, archive: string, sessions: readonly SessionArchive[], signal: AbortSignal): Promise<InputStateReconciliation> {
  const report: InputStateReconciliation = { tickets: 0, inputs: 0, consumed: 0, readMarkers: 0, undelivered: 0 }
  const histories = new Map(sessions.map(session => [session.id, session]))
  if (histories.size !== sessions.length) throw new InputStateError('input_state_invalid')
  db.exec('SAVEPOINT recovery_consumed_inputs')
  try {
    for (const row of db.prepare('SELECT id,value FROM ticket ORDER BY id').iterate()) {
      signal.throwIfAborted()
      let ticket: Ticket
      try { ticket = JSON.parse(String(row.value)) as Ticket } catch { throw new InputStateError('input_state_invalid') }
      if (!ticket || ticket.id !== row.id || !Array.isArray(ticket.inputs) || !Array.isArray(ticket.undelivered)) throw new InputStateError('input_state_invalid')
      if (ticket.inputs.some(input => !input || typeof input.id !== 'string' || !input.id
        || !['trigger', 'policy-changed', 'reopen', 'resumed', 'text', 'note'].includes(input.kind)
        || input.readAt !== undefined && input.readAt !== null
          && (typeof input.readAt !== 'string' || !Number.isFinite(Date.parse(input.readAt))))) throw new InputStateError('input_state_invalid')
      const inputs = new Map<string, Ticket['inputs'][number]>(ticket.inputs.map(input => [messageId(key(input.id)), input]))
      const inputIds = new Set(ticket.inputs.map(input => input.id))
      if (inputs.size !== ticket.inputs.length || new Set(ticket.undelivered).size !== ticket.undelivered.length
        || ticket.undelivered.some(id => !inputIds.has(id))) throw new InputStateError('input_state_invalid')
      report.tickets++; report.inputs += inputs.size
      if (!Number.isSafeInteger(report.inputs)) throw new InputStateError('input_state_invalid')
      const session = histories.get('worker-' + ticket.id), consumed = new Map<string, string>()
      if (session && inputs.size) await scanSession(join(archive, session.member), session, signal, async events => {
        for (const event of events) {
          // A copied ancestor's message is not evidence that this worker admitted the input itself.
          if (event.seq < session.inheritedEventCount || event.type !== 'user/message') continue
          const id = deliveryId(event.data), input = id && inputs.get(id)
          if (!input) continue
          if (consumed.has(input.id)) throw new InputStateError('input_delivery_duplicate')
          const at = new Date(event.time)
          if (!Number.isFinite(at.getTime())) throw new InputStateError('input_state_invalid')
          consumed.set(input.id, at.toISOString())
        }
      })
      report.consumed += consumed.size
      let changed = false
      for (const input of ticket.inputs) {
        if (input.kind === 'reopen') continue
        const at = consumed.get(input.id)
        // Undefined is the legacy unknown state; null is modern queued/unread state. Neither is proof of consumption.
        if (input.readAt !== undefined && input.readAt !== null && !at) throw new InputStateError('input_read_missing')
        if (at && !ticket.ended && (input.readAt === undefined || input.readAt === null)) {
          input.readAt = at; report.readMarkers++; changed = true
        }
      }
      if (!ticket.ended) {
        const waiting = ticket.undelivered.filter(id => !consumed.has(id))
        if (waiting.length !== ticket.undelivered.length) {
          report.undelivered += ticket.undelivered.length - waiting.length; ticket.undelivered = waiting; changed = true
        }
      }
      if (changed) {
        // Preserve assignments, authorizations, ended outcomes and original application timestamps. Only repair acknowledgements.
        const updated = db.prepare('UPDATE ticket SET value=? WHERE id=? AND value=?').run(JSON.stringify(ticket), ticket.id, row.value!)
        if (Number(updated.changes) !== 1) throw new InputStateError('input_state_invalid')
      }
    }
    signal.throwIfAborted(); db.exec('RELEASE recovery_consumed_inputs'); return report
  } catch (error) {
    db.exec('ROLLBACK TO recovery_consumed_inputs; RELEASE recovery_consumed_inputs')
    throw error
  }
}
