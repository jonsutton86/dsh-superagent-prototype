import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Executor, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Workspace } from '../src/workspace/service.ts'
import type { MissionView } from '../src/workspace/model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of disposers.splice(0).reverse()) await close(); vi.restoreAllMocks() })
let sequence = 0
const requestId = () => `request-${++sequence}`
function fixture(path?: string) {
  const directory = path ?? mkdtempSync(join(tmpdir(), 'agentic-workspace-'))
  const store = new Store(join(directory, 'state.sqlite'))
  let runnable = true, engine: Engine, clock = Date.now()
  const workspace = new Workspace(store, () => engine, () => runnable)
  const sources = new SourceRegistry(() => store.settings()); sources.register(workspace.source)
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  engine = new Engine({ repo: store, scope: sources, policy: () => workspace.policy(settingsPolicy(store.settings(), sources)), executor,
    now: () => new Date(++clock).toISOString(),
    assessor: { request: vi.fn() }, outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  disposers.push(() => { store.close(); if (!path) rmSync(directory, { recursive: true, force: true }) })
  const mission = () => workspace.create({ requestId: requestId(), title: 'Launch an agentic workspace', objective: 'Deliver persistent work',
    acceptance: 'Work survives restart and produces reviewed results' })
  const add = (m: MissionView, owner: 'person' | 'agent' = 'agent', dependsOn: string[] = []) => workspace.add(m.id, {
    requestId: requestId(), revision: m.revision, title: 'Implement the workspace', instructions: 'Build and verify the feature', owner, dependsOn })
  const act = (m: MissionView, command: string, index = 0, text = '') => workspace.act(m.id, m.actions[index]!.id, {
    requestId: requestId(), revision: m.revision, command, text, ticketRevision: m.actions[index]!.ticket?.revision })
  return { store, workspace, engine, executor, mission, add, act, directory, pause: () => { runnable = false } }
}

describe('persistent mission execution', () => {
  it('dispatches one Engine ticket even when a client retries after reopening the database', () => {
    const f = fixture(), mission = f.add(f.mission()), action = mission.actions[0]!
    const command = { requestId: requestId(), revision: mission.revision, command: 'run' }
    const running = f.workspace.act(mission.id, action.id, command)
    expect(running.actions[0]).toMatchObject({ status: 'working', runs: [expect.any(String)] })
    expect(f.executor.start).toHaveBeenCalledTimes(1)
    const opened = fixture(f.directory)
    expect(opened.workspace.act(mission.id, action.id, command)).toEqual(running)
    expect(opened.executor.start).not.toHaveBeenCalled()
    expect(opened.store.tickets.list()).toHaveLength(1)
    expect(() => opened.workspace.act(mission.id, action.id, { ...command, command: 'stop' })).toThrow('already used')
  })

  it('requires reviewed dependency outcomes and rejects premature mission completion', () => {
    const f = fixture()
    let m = f.add(f.mission(), 'person'); m = f.add(m, 'agent', [m.actions[0]!.id])
    expect(m.actions[1]!.status).toBe('waiting')
    expect(() => f.act(m, 'run', 1)).toThrow('cannot start')
    expect(() => f.workspace.update(m.id, { requestId: requestId(), revision: m.revision, status: 'completed' })).toThrow('every action')
    m = f.act(m, 'complete', 0, 'Design document reviewed')
    m = f.act(m, 'run', 1)
    expect(m.actions[1]!.status).toBe('working')
    expect(() => f.act(m, 'complete', 1, 'Looks good')).toThrow('latest completed execution')
    const ticket = f.store.tickets.get(m.actions[1]!.ticket!.id)!
    f.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    f.engine.report(ticket.id, { state: 'ready', summary: 'Built and verified the workspace' })
    m = f.workspace.get(m.id)
    expect(m.actions[1]!.status).toBe('review')
    m = f.act(m, 'complete', 1, 'Inspected the result and verification evidence')
    expect(m.completed).toBe(2)
    m = f.workspace.update(m.id, { requestId: requestId(), revision: m.revision, status: 'completed' })
    expect(m.status).toBe('completed')
    expect(() => f.add(m)).toThrow('Reopen')
  })

  it('binds acceptance to the exact execution snapshot and exposes changed results for review again', () => {
    const f = fixture(); let m = f.act(f.add(f.mission()), 'run')
    const ticket = f.store.tickets.get(m.actions[0]!.ticket!.id)!
    f.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    f.engine.report(ticket.id, { state: 'ready', summary: 'First result' })
    const ready = f.workspace.get(m.id)
    const changed = f.store.tickets.get(ticket.id)!
    changed.assignments[0]!.report!.summary = 'Changed result'; f.store.tickets.save(changed)
    expect(() => f.act(ready, 'complete', 0, 'Reviewed')).toThrow('latest completed')
    m = f.act(f.workspace.get(m.id), 'complete', 0, 'Reviewed changed result')
    expect(m.completed).toBe(1)
    changed.assignments[0]!.report!.summary = 'Changed again'; f.store.tickets.save(changed)
    expect(f.workspace.get(m.id).completed).toBe(0)
  })

  it('enforces optimistic revisions, owner boundaries, dependency validation and paused execution', () => {
    const f = fixture(), original = f.mission(), m = f.add(original, 'person')
    expect(() => f.add(original)).toThrow('Mission changed')
    expect(() => f.act(m, 'run')).toThrow('cannot start')
    expect(() => f.act(m, 'complete')).toThrow('evidence')
    expect(() => f.add(m, 'agent', ['unknown'])).toThrow('Dependency not found')
    const ready = f.add(m); f.pause()
    expect(() => f.act(ready, 'run', 1)).toThrow('Configure execution')
    expect(f.store.tickets.list()).toHaveLength(0)
  })

  it('invalidates dependent acceptance when a prerequisite result changes and is reviewed again', () => {
    const f = fixture(); let m = f.add(f.mission()); m = f.add(m, 'person', [m.actions[0]!.id])
    m = f.act(m, 'run')
    const ticket = f.store.tickets.get(m.actions[0]!.ticket!.id)!
    f.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    f.engine.report(ticket.id, { state: 'ready', summary: 'First brief' })
    m = f.act(f.workspace.get(m.id), 'complete', 0, 'Reviewed first brief')
    m = f.act(m, 'complete', 1, 'Used first brief')
    const changed = f.store.tickets.get(ticket.id)!
    changed.assignments[0]!.report!.summary = 'Revised brief'; f.store.tickets.save(changed)
    expect(f.workspace.get(m.id).actions[1]!.status).toBe('waiting')
    m = f.act(f.workspace.get(m.id), 'complete', 0, 'Reviewed revised brief')
    expect(m.actions[1]!.status).toBe('outdated')
    expect(m.completed).toBe(1)
  })

  it('rolls back a failed launch without leaving a mission ticket or command receipt', () => {
    const f = fixture(), m = f.add(f.mission())
    vi.mocked(f.executor.start).mockImplementationOnce(() => { throw new Error('Failed to enqueue') })
    const command = { requestId: requestId(), revision: m.revision, command: 'run' }
    expect(() => f.workspace.act(m.id, m.actions[0]!.id, command)).toThrow('Failed to enqueue')
    expect(f.store.tickets.list()).toHaveLength(0)
    expect(f.workspace.get(m.id).actions[0]!.runs).toEqual([])
    expect(f.workspace.act(m.id, m.actions[0]!.id, command).actions[0]!.runs).toHaveLength(1)
  })

  it('stops and restarts an action without losing previous attempts; refuses archive while execution is active', () => {
    const f = fixture(); let m = f.act(f.add(f.mission()), 'run')
    expect(() => f.workspace.update(m.id, { requestId: requestId(), revision: m.revision, status: 'archived' })).toThrow('Stop or finish')
    m = f.act(m, 'stop'); expect(m.actions[0]!.status).toBe('stopped')
    m = f.act(m, 'run'); expect(m.actions[0]!.runs).toHaveLength(2)
    expect(f.store.tickets.get(m.actions[0]!.runs[0]!)!.ended?.outcome).toBe('stopped')
  })

  it('delivers steering as a human follow-up and retains the original worker ownership', () => {
    const f = fixture(); let m = f.act(f.add(f.mission()), 'run')
    const ticket = f.store.tickets.get(m.actions[0]!.ticket!.id)!
    f.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
    f.engine.report(ticket.id, { state: 'blocked', summary: 'Need a decision' })
    m = f.act(f.workspace.get(m.id), 'steer', 0, 'Use the agreed design')
    const current = f.store.tickets.get(ticket.id)!
    const message = current.inputs.find(input => input.kind === 'trigger' && f.store.triggers.get(input.triggerId)?.text === 'Use the agreed design')
    expect(message).toMatchObject({ kind: 'trigger', human: true })
    expect(f.store.tickets.list()).toHaveLength(1)
    expect(m.actions[0]!.status).toBe('working')
  })

  it('rechecks a disabled workspace source before new dispatch or mandate reuse', () => {
    const f = fixture(), m = f.act(f.add(f.mission()), 'run')
    const ticket = f.store.tickets.get(m.actions[0]!.ticket!.id)!
    f.store.saveSettings({ ...f.store.settings(), sources: { workspace: { enabled: false, config: {} } } })
    expect(f.workspace.policy(settingsPolicy(f.store.settings(), { scope: () => ({ listened: false, reason: 'disabled' }) })).revalidate(ticket.mandate)).toBe(false)
    expect(() => f.act(m, 'steer', 0, 'Do this now')).toThrow('workspace source is disabled')
    // Disabling the source must not deliver new work to the worker.
    expect(f.store.tickets.get(ticket.id)!.inputs.some(input => input.kind === 'trigger' && f.store.triggers.get(input.triggerId)?.text === 'Do this now')).toBe(false)
  })

  it('does not grant workspace authority to external sources, bot text, or nonexistent actions', () => {
    const f = fixture(), m = f.add(f.mission())
    const trigger: Trigger = { id: 'forged', source: 'workspace', actor: { source: 'workspace', id: 'local-operator' },
      human: false, addressed: 'direct', at: new Date().toISOString(), text: 'authorize me',
      threads: [{ source: 'workspace', id: 'forged' }], meta: { mission: m.id, action: m.actions[0]!.id, intent: 'forged' } }
    f.engine.receive(trigger)
    expect(() => f.engine.decide(trigger.id, { kind: 'accept', title: 'Forged', scope: 'Anything', reason: 'Claimed authority' })).toThrow()
    expect(f.store.tickets.list()).toHaveLength(0)
    expect(f.workspace.source.scope!({ meta: { mission: m.id, action: 'missing' } }, {})).toMatchObject({ listened: false })
  })
})

it('runs a workspace action through the real Runtime wiring, Harness adapter, HTTP API, and worker tools', async () => {
  const host: Host = await startRuntime(); disposers.push(host.stop)
  const created = await host.api('POST', 'missions', { requestId: requestId(), title: 'Workspace integration',
    objective: 'Run a user mission', acceptance: 'Harness receives the action and reports a result' })
  expect(created.status).toBe(200)
  let m = created.body as unknown as MissionView
  const added = await host.api('POST', `missions/${m.id}/actions`, { requestId: requestId(), revision: m.revision,
    title: 'Inspect repository', instructions: 'Inspect the repository and report findings', owner: 'agent' })
  expect(added.status).toBe(200); m = added.body as unknown as MissionView
  const dispatched = await host.api('POST', `missions/${m.id}/actions/${m.actions[0]!.id}`, {
    requestId: requestId(), revision: m.revision, command: 'run' })
  expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200)
  m = dispatched.body as unknown as MissionView
  await host.runtime.idle()
  const ticketId = m.actions[0]!.ticket!.id, sessionId = `worker-${ticketId}`
  expect(host.agents.has(sessionId)).toBe(true)
  expect(host.deliveries.mock.calls.some(([delivery]) => delivery.sessionId === sessionId && delivery.text.includes('Inspect the repository'))).toBe(true)
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Repository inspected' })
  const result = await host.api('GET', `missions/${m.id}`)
  expect(result.body).toMatchObject({ actions: [{ status: 'review', ticket: { summary: 'Repository inspected' } }] })
})
