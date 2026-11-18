import type { Ticket } from '../../src/core/model.ts'
import type { StopRecord } from '../../src/executor/stop-model.ts'
import { stopExecutionDigest, stopScopeDigest } from '../../src/executor/stop-store.ts'

export function stopRecord(ticket: Ticket, patch: Partial<StopRecord> = {}): StopRecord {
  const execution = ticket.assignments[0]?.execution ?? ticket.execution ?? null
  const record: StopRecord = { version: 1, id: 'original-stop', ticketId: ticket.id, assignmentId: ticket.assignments[0]!.id,
    sessionId: `worker-${ticket.id}`, revision: 1, scope: 'all', state: 'unknown', reason: 'Original work is not confirmed stopped',
    execution, world: execution?.environment?.world ?? null, executionBindingHash: '', scopeHash: '',
    createdAt: '2026-01-01T00:00:00.000Z', instance: null, legacy: false, keepInbox: true, ownTurn: false,
    jobIds: ['original-job'], sessions: [`worker-${ticket.id}`], dispatched: true, coverageConsumed: false, proof: null, settledAt: null,
    attestationId: null, ...patch }
  record.executionBindingHash = stopExecutionDigest(record.execution, record.world)
  record.scopeHash = stopScopeDigest(record)
  return record
}
