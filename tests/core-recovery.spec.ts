/** Automatic host recovery spends the existing assignment history, including after reopening the Store. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine, key, latestAssignment, runningAssignment, waitsForPerson, type EngineOptions, type Ticket } from '../src/core/index.ts'
import { automaticRestartBudget, isAutomaticRestartInput } from '../src/core/recovery.ts'

let directory: string, store: Store, engine: Engine, clock: number
const start = vi.fn(), deliver = vi.fn(), stop = vi.fn()
const ticketId = 'recovery-ticket'
const original = (): Ticket => ({
  id: ticketId, title: 'Continue the authorized task', decisionId: 'accepted',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'test', id: 'owner' }, scope: 'The original work' },
  channels: [], origin: { triggerId: 'original-request', triggerIds: ['original-request'] }, inputs: [], undelivered: [],
  createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
  assignments: [{ id: 'original-assignment', state: 'running', createdAt: '2026-11-10T00:00:00.000Z' }],
})
const current = () => store.tickets.get(ticketId)!
function open() {
  store = new Store(join(directory, 'orchestrator.sqlite'))
  const options: EngineOptions = {
    repo: store, executor: { start, deliver, stop }, assessor: { request: vi.fn(), release: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() },
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60000,
      gate: () => ({ admissible: false, reason: 'No new admission in this test' }), revalidate: () => true, admitsInferred: () => false }),
    now: () => new Date(clock).toISOString(),
  }
  engine = new Engine(options)
}
function reopen() { store.close(); open() }
function interrupt() { clock += 1000; engine.assignmentInterrupted(ticketId, runningAssignment(current())!.id) }
function started() { clock += 1000; engine.assignmentStarted(ticketId, latestAssignment(current())!.id) }
function spendAll() { for (let i = 0; i < 3; i++) { interrupt(); started() } }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'core-recovery-'))
  clock = Date.parse('2026-11-10T00:00:00.000Z')
  start.mockClear(); deliver.mockClear(); stop.mockClear()
  open(); store.tickets.save(original())
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('automatic host restart recovery', () => {
  it('admits three original replacements across Store reopens, then holds the same assignment without minting another input or launch', () => {
    const mandate = current().mandate
    for (let used = 1; used <= 3; used++) {
      reopen(); interrupt()
      expect(automaticRestartBudget(current())).toEqual({ limit: 3, used, remaining: 3 - used, exhausted: used === 3 })
      expect(latestAssignment(current())!.state).toBe('pending')
      started()
    }
    const before = current(), identities = before.assignments.map(item => item.id), inputs = before.inputs
    start.mockClear(); deliver.mockClear(); reopen(); interrupt()
    expect(current().assignments.map(item => item.id)).toEqual(identities)
    expect(current().inputs).toEqual(inputs)
    expect(current().undelivered).toEqual([])
    expect(current().mandate).toEqual(mandate)
    expect(latestAssignment(current())).toMatchObject({ id: identities.at(-1), state: 'running',
      report: { state: 'failed', summary: expect.stringContaining('Automatic host restart recovery reached its limit') } })
    expect(waitsForPerson(current())).toBe(true)
    expect(start).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled()
    reopen(); interrupt()
    expect(current().assignments.map(item => item.id)).toEqual(identities)
    expect(current().inputs).toEqual(inputs)
    expect(current().undelivered).toEqual([])
    expect(start).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled()
  })

  it('starts a new chain only when an explicit retry creates its authorized replacement', () => {
    spendAll(); interrupt()
    clock += 1000; engine.retryTicket(ticketId)
    expect(current().assignments.at(-2)!.endedReason).toBe('retried')
    expect(automaticRestartBudget(current())).toEqual({ limit: 3, used: 0, remaining: 3, exhausted: false })
    started(); reopen(); interrupt()
    expect(automaticRestartBudget(current()).used).toBe(1)
    expect(latestAssignment(current())!.state).toBe('pending')
  })

  it('does not reset the automatic replacement budget for progress or a completed worker turn', () => {
    spendAll()
    clock += 1000; engine.report(ticketId, { state: 'progress', summary: 'A recorded intermediate result' })
    engine.turnEnded(ticketId, runningAssignment(current())!.id)
    reopen(); start.mockClear(); interrupt()
    expect(automaticRestartBudget(current()).used).toBe(3)
    expect(latestAssignment(current())!.report?.state).toBe('failed')
    expect(start).not.toHaveBeenCalled()
  })

  it('starts a new chain when an ended ticket resumes under its revalidated mandate on a new human request', () => {
    spendAll()
    const saved = current(), at = new Date(++clock).toISOString(), last = latestAssignment(saved)!
    last.state = 'ended'; last.endedAt = at
    saved.ended = { by: 'executor', outcome: 'completed', at }
    saved.inputs.push({ id: 'new-authorized-request', kind: 'trigger', triggerId: 'new-request', human: true, at })
    saved.undelivered = ['new-authorized-request']
    store.tickets.save(saved); reopen(); engine.evaluateDue()
    expect(current().ended).toBeUndefined()
    expect(current().inputs.at(-1)).toMatchObject({ kind: 'resumed', triggerId: 'new-request' })
    expect(automaticRestartBudget(current()).used).toBe(0)
    started(); interrupt()
    expect(automaticRestartBudget(current()).used).toBe(1)
  })

  it.each(['waiting', 'blocked', 'failed'] as const)('keeps the established %s handoff and unread-input recovery at the cap', state => {
    spendAll()
    const assignmentId = runningAssignment(current())!.id
    const saved = current(), at = new Date(clock).toISOString()
    saved.inputs.push({ id: 'accepted-human-input', kind: 'trigger', triggerId: 'human', human: true, at, readAt: null, deliveredTo: assignmentId },
      { id: 'accepted-automatic-note', kind: 'note', text: 'Existing context', at, readAt: null, deliveredTo: assignmentId })
    store.tickets.save(saved)
    clock += 1000; engine.report(ticketId, { state, summary: 'Established handoff' })
    start.mockClear(); deliver.mockClear(); reopen(); interrupt()
    expect(current().assignments).toHaveLength(4)
    expect(latestAssignment(current())!.report).toMatchObject({ state, summary: 'Established handoff' })
    expect(current().undelivered).toContain('accepted-human-input')
    expect(current().undelivered.includes('accepted-automatic-note')).toBe(state === 'waiting')
    expect(start).not.toHaveBeenCalled(); expect(deliver).toHaveBeenCalledOnce()
  })

  it('ignores a retired-assignment interruption and preserves original recovery input IDs after a lost caller response', () => {
    const previous = runningAssignment(current())!.id
    interrupt(); const after = current()
    reopen(); engine.assignmentInterrupted(ticketId, previous)
    expect(current()).toEqual(after)
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps accepted-unread recovery notes held across repeated boots while retaining their records and ordinary human text', () => {
    spendAll()
    const saved = current(), assignment = runningAssignment(saved)!, at = new Date(clock).toISOString()
    const recoveryIds = saved.inputs.filter(input => isAutomaticRestartInput(saved, input)).map(input => input.id)
    expect(recoveryIds).toHaveLength(3)
    for (const input of saved.inputs) if (input.kind !== 'reopen' && recoveryIds.includes(input.id)) {
      input.readAt = null; input.deliveredTo = assignment.id
    }
    saved.inputs.push({ id: 'original-human-text', kind: 'text', text: saved.inputs[0]!.kind === 'text' ? saved.inputs[0]!.text : '', at,
      readAt: null, deliveredTo: assignment.id })
    saved.undelivered = [...recoveryIds, 'original-human-text']
    store.tickets.save(saved); interrupt()
    const originalInputs = current().inputs
    expect(current().undelivered).toEqual(['original-human-text'])
    for (let boot = 0; boot < 2; boot++) {
      reopen(); interrupt()
      expect(current().inputs).toEqual(originalInputs)
      expect(current().undelivered).toEqual(['original-human-text'])
      expect(automaticRestartBudget(current()).used).toBe(3)
    }
    expect(isAutomaticRestartInput(current(), 'original-human-text')).toBe(false)
  })

  it('recognizes recovery intent by its original identity and host transition, never by text alone', () => {
    interrupt()
    const saved = current(), recovery = saved.inputs[0]!
    expect(isAutomaticRestartInput(saved, recovery)).toBe(true)
    expect(isAutomaticRestartInput(saved, recovery.id)).toBe(true)
    expect(isAutomaticRestartInput(saved, { ...recovery, id: 'different-original-request' })).toBe(false)
    expect(isAutomaticRestartInput(saved, { ...recovery, id: key('input', 'another-ticket', 'restart', latestAssignment(saved)!.id) })).toBe(false)
    saved.assignments[0]!.endedReason = 'retried'
    expect(isAutomaticRestartInput(saved, recovery)).toBe(false)
  })

  it('holds legacy histories already over the limit without changing their recorded attempt count', () => {
    const saved = original(), first = saved.assignments[0]!
    saved.assignments = Array.from({ length: 6 }, (_, index) => ({ ...first, id: `legacy-${index}`,
      ...(index < 5 ? { state: 'ended' as const, endedReason: 'hostRestarted', endedAt: first.createdAt } : {}) }))
    store.tickets.save(saved); reopen(); interrupt()
    expect(automaticRestartBudget(current())).toEqual({ limit: 3, used: 5, remaining: 0, exhausted: true })
    expect(current().assignments).toHaveLength(6)
    expect(latestAssignment(current())!.report?.state).toBe('failed')
    expect(start).not.toHaveBeenCalled()
  })
})
