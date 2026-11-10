import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { collectExecutionEvidence, type ExecutionEvidenceInput } from '../src/executor/evidence.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { ExecutionEffects } from '../src/remote/effects.ts'
import { RemoteWorld } from '../src/remote/world.ts'
import { worldBinding } from '../src/remote/world-journal.ts'
import { EXECUTION_EVIDENCE_LIMIT, ExecutionEvidenceSchema, emptyRemoteExecutionEvidence, unavailableExecutionEvidence } from '../src/supervision/execution-evidence.ts'
import type { Ticket } from '../src/core/index.ts'

const agent = (id: string, status = 'idle', header: { origin?: string; parentSession?: string } = {}) => ({ id, status, session: { header } })
function fixture() {
  const parent = agent('worker-ticket'), agents = new Map([[parent.id, parent]])
  const rows: { id: string; owner?: string; status: string; output?: { total: number } }[] = []
  const input: ExecutionEvidenceInput = { sessionId: parent.id, assignmentId: 'assignment',
    agents: { get: id => agents.get(id), list: () => [...agents.values()] }, jobs: () => ({ list: () => rows }), handedOff: new Set(),
    executor: { ...unavailableExecutionEvidence().executor, availability: 'available' }, remoteEffects: () => emptyRemoteExecutionEvidence('not_applicable') }
  return { parent, agents, rows, input }
}

describe('bounded execution evidence', () => {
  it('keeps session-only attribution and excludes unowned, foreign and handed-off jobs without reading private content', () => {
    const host = fixture(); host.input.handedOff = new Set(['left'])
    host.rows.push({ id: 'current', owner: host.parent.id, status: 'running', output: { total: 42 } },
      { id: 'left', owner: host.parent.id, status: 'stopping', output: { total: 90 } },
      { id: 'public', status: 'running', output: { total: 200 } }, { id: 'other', owner: 'foreign', status: 'running' })
    for (const row of host.rows) for (const key of ['label', 'detail', 'progress']) Object.defineProperty(row, key, { get: () => { throw new Error('private content read') } })
    const value = collectExecutionEvidence(host.input)
    expect(value.jobs).toMatchObject({ availability: 'available', attribution: 'session', assignmentAttribution: 'unknown', lifecycleAttribution: 'unknown',
      coverage: 'complete', sampled: 2, counts: { running: 1, stopping: 0 }, handedOff: { running: 0, stopping: 1 }, outputBytes: 42 })
    expect(JSON.stringify(value)).not.toContain('current')
    expect(ExecutionEvidenceSchema.safeParse(value).success).toBe(true)
  })

  it('distinguishes an absent or failing registry from an available zero-job registry', () => {
    const host = fixture()
    expect(collectExecutionEvidence(host.input).jobs).toMatchObject({ availability: 'available', coverage: 'complete', sampled: 0 })
    host.input.jobs = () => undefined
    expect(collectExecutionEvidence(host.input).jobs).toMatchObject({ availability: 'unavailable', coverage: 'unavailable' })
    host.input.jobs = () => { throw new Error('private path or token') }
    const result = collectExecutionEvidence(host.input)
    expect(result.jobs.availability).toBe('unavailable'); expect(JSON.stringify(result)).not.toContain('private')
    host.agents.clear()
    expect(collectExecutionEvidence(host.input).session.availability).toBe('unavailable')
  })

  it('bounds metadata and marks incomplete sampling without treating output bytes as verified progress', () => {
    const host = fixture()
    host.rows.push(...Array.from({ length: EXECUTION_EVIDENCE_LIMIT + 1 }, (_, i) => ({ id: String(i), owner: host.parent.id, status: 'running', output: { total: Number.MAX_SAFE_INTEGER } })))
    const value = collectExecutionEvidence(host.input)
    expect(value.jobs).toMatchObject({ coverage: 'partial', sampled: EXECUTION_EVIDENCE_LIMIT, counts: { running: EXECUTION_EVIDENCE_LIMIT }, outputBytes: Number.MAX_SAFE_INTEGER })
    expect(value).not.toHaveProperty('progressing')
    expect(ExecutionEvidenceSchema.safeParse({ ...value, unexpected: 'content' }).success).toBe(false)
  })

  it('changes material evidence for a replaced job identity and growing output but not registry order or handed-off output', () => {
    const host = fixture(); host.input.handedOff = new Set(['left'])
    host.rows.push({ id: 'active', owner: host.parent.id, status: 'running', output: { total: 10 } },
      { id: 'left', owner: host.parent.id, status: 'running', output: { total: 10 } })
    const before = collectExecutionEvidence(host.input)
    host.rows[1]!.output!.total = 20; host.rows.reverse()
    expect(collectExecutionEvidence(host.input)).toEqual(before)
    host.rows[1]!.id = 'replacement'
    expect(collectExecutionEvidence(host.input).jobs.sampleRevision).not.toBe(before.jobs.sampleRevision)
    host.rows[1]!.id = 'active'; host.rows[1]!.output!.total = 11
    expect(collectExecutionEvidence(host.input).jobs.sampleRevision).not.toBe(before.jobs.sampleRevision)
    delete host.rows[1]!.output
    expect(collectExecutionEvidence(host.input).jobs.outputBytes).toBeNull()
  })

  it('describes only loaded direct subagent lineage and refuses a replaced parent sample', () => {
    const host = fixture()
    const child = agent('child', 'running', { origin: 'subagent', parentSession: host.parent.id })
    host.agents.set(child.id, child); host.agents.set('fork', agent('fork', 'running', { parentSession: host.parent.id }))
    host.agents.set('grandchild', agent('grandchild', 'running', { origin: 'subagent', parentSession: child.id }))
    expect(collectExecutionEvidence(host.input).subagents).toMatchObject({ availability: 'available', coverage: 'loaded-only',
      attribution: 'observed-session-lineage', assignmentAttribution: 'unknown', sampled: 1, counts: { running: 1, idle: 0 } })
    host.input.jobs = () => ({ list: () => { host.agents.set(host.parent.id, agent(host.parent.id)); return host.rows } })
    const changed = collectExecutionEvidence(host.input)
    expect(changed.session.availability).toBe('unavailable'); expect(changed.jobs.availability).toBe('unavailable'); expect(changed.subagents.availability).toBe('unavailable')
  })

  it('keeps unavailable remote evidence visible without exposing a failed read message', () => {
    const host = fixture(); host.input.remoteEffects = () => { throw new Error('secret endpoint path') }
    const value = collectExecutionEvidence(host.input)
    expect(value.remoteEffects.availability).toBe('unavailable'); expect(JSON.stringify(value)).not.toContain('secret')
    expect(collectExecutionEvidence(host.input)).toEqual(value)
  })

  it('uses current assignment and process-local handoff/retry facts through the real executor read seam', () => {
    const host = fixture(), ticket = { id: 'ticket', assignments: [{ id: 'assignment' }] } as Ticket
    let stored: Ticket | undefined = ticket
    const executor = Object.create(DshExecutor.prototype) as DshExecutor
    const remoteFor = vi.fn(() => { throw new Error('Unloaded managed world must not fall back to local') })
    Object.assign(executor, { host: { store: { tickets: { get: () => stored } }, context: { agents: host.input.agents, get: () => host.input.jobs() }, environments: { remoteFor } },
      transient: new Map([['assignment', 2], ['launch:assignment', 1]]), resuming: new Set(['assignment']), settling: new Map([['ticket', {}]]),
      preparingRepositories: new Map(), stopping: new Map(), left: new Map([['ticket', { jobs: new Set(['left']) }]]) })
    host.rows.push({ id: 'left', owner: host.parent.id, status: 'running' })
    const value = executor.executionEvidence(ticket)
    expect(value.executor).toMatchObject({ availability: 'available', provenance: 'process-local', retrying: true, turnRetryAttempts: 2, launchRetryAttempts: 1, settling: true, knownHandedOffJobs: 1 })
    expect(value.jobs.counts.running).toBe(0); expect(value.jobs.handedOff.running).toBe(1); expect(value.remoteEffects.availability).toBe('unavailable')
    stored = { ...ticket, assignments: [{ id: 'replacement' }] } as Ticket
    expect(executor.executionEvidence(ticket)).toEqual(unavailableExecutionEvidence(host.parent.id, 'assignment'))
    expect(remoteFor).toHaveBeenCalledTimes(1)
    stored = ticket; host.input.jobs = () => ({ list: () => { stored = undefined; return [] } })
    expect(executor.executionEvidence(ticket).session.availability).toBe('unavailable')
  })
})

describe('existing remote receipt projections', () => {
  it('refuses a rotated world instead of reclassifying an old assignment as an empty new world', () => {
    const grant = { id: 'grant', epoch: 2, owner: 'coordinator', workspace: 'workspace', root: '/private/world', rootIdentity: 'inode', operations: ['command'] } as any
    const read = vi.fn(() => ({ ...emptyRemoteExecutionEvidence(), availability: 'available' as const, coverage: 'complete' as const }))
    const world = Object.assign(Object.create(RemoteWorld.prototype), { record: { endpointId: 'endpoint', grant }, closed: false, journal: { effects: { executionEvidence: read } } }) as RemoteWorld
    const current = worldBinding('endpoint', grant), previous = worldBinding('endpoint', { ...grant, epoch: 1 })
    expect(world.executionEvidence('ticket', 'assignment', previous).availability).toBe('unavailable'); expect(read).not.toHaveBeenCalled()
    expect(world.executionEvidence('ticket', 'assignment', current).availability).toBe('available')
    expect(read).toHaveBeenCalledWith('ticket', 'assignment', current)
  })
  it('filters exact assignment/world, ignores sensitive fields and polling timestamps, and stays read-only', () => {
    const db = new DatabaseSync(':memory:'), effects = new ExecutionEffects(db)
    try {
      const add = (id: string, overrides: Record<string, unknown> = {}) => db.prepare('INSERT INTO execution_effect VALUES (?,?)').run(id, JSON.stringify({
        id, owner: { kind: 'assignment', ticketId: 'ticket', assignmentId: 'assignment', sessionId: 'worker-ticket', callId: 'call', tool: 'bash' }, world: 'world',
        phase: 'settled', quiescent: true, outcome: { exitCode: 0, signal: null }, target: '/private/path', program: 'private command', problem: 'private provider body', updatedAt: 'old', ...overrides }))
      add('success'); add('failure', { outcome: { exitCode: 1, signal: null } }); add('signal', { outcome: { exitCode: null, signal: 'SIGTERM' } })
      add('unknown', { phase: 'unknown', quiescent: null }); add('live', { phase: 'started', quiescent: false })
      add('old-assignment', { owner: { kind: 'assignment', ticketId: 'ticket', assignmentId: 'old' } })
      add('other-world', { world: 'different' }); add('host', { owner: { kind: 'host', ticketId: 'ticket', assignmentId: 'assignment' } })
      const before = db.prepare('SELECT value FROM execution_effect ORDER BY id').all()
      const value = effects.executionEvidence('ticket', 'assignment', 'world')
      expect(value).toMatchObject({ availability: 'available', coverage: 'complete', sampled: 5, phases: { settled: 3, started: 1, unknown: 1 },
        quiescence: { confirmed: 3, unconfirmed: 1, unknown: 1 }, outcomes: { succeeded: 1, failed: 1, signalled: 1, unknown: 2 } })
      expect(JSON.stringify(value)).not.toContain('private'); expect(db.prepare('SELECT value FROM execution_effect ORDER BY id').all()).toEqual(before)
      db.exec("UPDATE execution_effect SET value=json_set(value,'$.updatedAt','new','$.observedAt','new')")
      expect(effects.executionEvidence('ticket', 'assignment', 'world')).toEqual(value)
      db.exec("UPDATE execution_effect SET id='replacement-success',value=json_set(value,'$.id','replacement-success') WHERE id='success'")
      expect(effects.executionEvidence('ticket', 'assignment', 'world').sampleRevision).not.toBe(value.sampleRevision)
      expect(effects.executionEvidence('ticket', 'missing', 'world')).toMatchObject({ availability: 'available', coverage: 'complete', sampled: 0 })
      effects.close(); expect(effects.executionEvidence('ticket', 'assignment', 'world').availability).toBe('unavailable')
    } finally { effects.close(); db.close() }
  })

  it('marks oversized and recovered receipt evidence partial/unknown without treating a restart as success', () => {
    const db = new DatabaseSync(':memory:'), effects = new ExecutionEffects(db)
    try {
      const insert = db.prepare('INSERT INTO execution_effect VALUES (?,?)')
      for (let i = 0; i <= EXECUTION_EVIDENCE_LIMIT; i++) insert.run(String(i), JSON.stringify({ id: String(i),
        owner: { kind: 'assignment', ticketId: 'ticket', assignmentId: 'assignment' }, world: 'world', phase: 'started', quiescent: false }))
      const value = effects.executionEvidence('ticket', 'assignment', 'world')
      expect(value).toMatchObject({ coverage: 'partial', sampled: EXECUTION_EVIDENCE_LIMIT, phases: { started: EXECUTION_EVIDENCE_LIMIT }, outcomes: { unknown: EXECUTION_EVIDENCE_LIMIT } })
      effects.close(); const restored = new ExecutionEffects(db)
      expect(restored.executionEvidence('ticket', 'assignment', 'world')).toMatchObject({ phases: { unknown: EXECUTION_EVIDENCE_LIMIT }, quiescence: { unconfirmed: EXECUTION_EVIDENCE_LIMIT } })
      restored.close()
    } finally { effects.close(); db.close() }
  })
})
