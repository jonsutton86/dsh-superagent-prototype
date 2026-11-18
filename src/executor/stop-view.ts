/** Read the one canonical stop ledger; presentation never probes, cancels, or loads a Session. */
import { createHash } from 'node:crypto'
import type { Store } from '../app/store.ts'
import { latestAssignment, type Ticket } from '../core/model.ts'
import { StopRecordSchema } from './stop-model.ts'
import { STOP_HOLD_SAMPLE, type StopHoldView } from './stop-view-model.ts'

export function stopHold(store: Pick<Store, 'db'>, ticket: Ticket): StopHoldView | undefined {
  const material = createHash('sha256'), originals: StopHoldView['originals'] = []
  let count = 0
  for (const row of store.db.prepare("SELECT value FROM executor_stop WHERE ticket=? AND state NOT IN ('quiet','dormant') ORDER BY id").iterate(ticket.id)) {
    const record = StopRecordSchema.parse(JSON.parse(String(row.value)))
    const original = { id: record.id, assignmentId: record.assignmentId, revision: record.revision, scope: record.scope,
      state: record.state, proof: record.proof, legacy: record.legacy }
    count++; material.update(JSON.stringify(original))
    if (originals.length < STOP_HOLD_SAMPLE) originals.push(original)
  }
  if (!count) return
  const assignment = latestAssignment(ticket)
  return { held: true, count, revision: material.digest('hex'), originals,
    truncated: count > originals.length, pendingAssignmentId: assignment?.state === 'pending' ? assignment.id : null,
    pendingInputs: ticket.undelivered.length }
}

/** Includes ended tasks while their original execution still lacks a stop proof. */
export function heldTicketIds(store: Pick<Store, 'db'>, limit?: number): string[] {
  const query = "SELECT DISTINCT ticket FROM executor_stop WHERE state NOT IN ('quiet','dormant') ORDER BY ticket"
  const rows = limit === undefined ? store.db.prepare(query).all() : store.db.prepare(query + ' LIMIT ?').all(limit)
  return rows.map(row => String(row.ticket))
}
