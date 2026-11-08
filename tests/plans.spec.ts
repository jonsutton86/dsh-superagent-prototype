import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { Workspace } from '../src/workspace/service.ts'
import { PlanDefinition, definitionOf, type PlanProposal } from '../src/workspace/plan-model.ts'
import type { MissionView } from '../src/workspace/model.ts'
import { planningTools } from '../src/app/tools/planning.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.restoreAllMocks() })
const rid = () => randomUUID()
async function fixture() {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const workspace = host.runtime.workspace
  const mission = workspace.create({ requestId: rid(), title: 'Research brief', objective: 'Produce a useful brief', acceptance: 'Review the findings and sources' })
  return { h: host, workspace, plans: workspace.plans, mission }
}
function add(workspace: Workspace, mission: MissionView, title: string, owner = 'agent', dependsOn: string[] = []) {
  return workspace.add(mission.id, { requestId: rid(), revision: mission.revision, title, owner, instructions: `Complete ${title}`, dependsOn })
}
function propose(workspace: Workspace, mission: MissionView, plan = definitionOf(mission)) {
  return workspace.plans.propose(mission.id, { requestId: rid(), baseVersion: mission.planVersion, plan, rationale: 'Improve the mission plan' })
}
function review(workspace: Workspace, proposal: PlanProposal, decision = 'approve') {
  return workspace.plans.review(proposal.missionId, proposal.id, { requestId: rid(), revision: proposal.revision,
    missionRevision: workspace.get(proposal.missionId).revision, decision, note: 'Read the complete proposal and its effects' })
}
async function ready(h: Host, mission: MissionView, index = 0) {
  const action = mission.actions[index]!
  const m = h.runtime.workspace.act(mission.id, action.id, { requestId: rid(), revision: mission.revision, command: 'run' })
  await h.runtime.idle()
  await h.runTool(m.actions[index]!.ticket!.sessionId!, 'orchestrator_report', { state: 'ready', summary: 'Evidence ready' })
  return h.runtime.workspace.get(m.id)
}
function accept(workspace: Workspace, mission: MissionView, index = 0) {
  const action = mission.actions[index]!
  return workspace.act(mission.id, action.id, { requestId: rid(), revision: mission.revision, command: 'complete',
    ticketRevision: action.ticket?.revision, text: 'Independently reviewed the result' })
}

it('preserves immutable versions and approval receipts across reopening SQLite without dispatching proposed work', async () => {
  const { h, workspace, plans, mission } = await fixture()
  const m = add(workspace, mission, 'Research'), original = plans.version(m.id, m.planVersion)
  const plan = definitionOf(m); plan.actions.push({ id: 'draft-review', title: 'Review', instructions: 'Read the brief', owner: 'person', dependsOn: [m.actions[0]!.id] })
  const proposal = propose(workspace, m, plan)
  const body = { requestId: rid(), revision: proposal.revision, missionRevision: m.revision, decision: 'approve', note: 'Reviewed the dependency order' }
  const approved = plans.review(m.id, proposal.id, body)
  expect(approved.review?.version).toBe(3)
  expect(plans.version(m.id, 2)).toEqual(original)
  expect(h.runtime.store.tickets.list()).toEqual([])
  const updated = workspace.get(m.id)
  expect(updated.actions[1]!.id).not.toBe('draft-review')
  expect(updated.actions[1]!.dependsOn).toEqual([updated.actions[0]!.id])
  const reopened = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const restored = new Workspace(reopened, () => { throw new Error('Must not dispatch') }, () => false)
    expect(restored.plans.review(m.id, proposal.id, body)).toEqual(approved)
    expect(restored.get(m.id)).toEqual(updated)
    expect(restored.plans.list(m.id).versions).toHaveLength(3)
    expect(() => restored.plans.review(m.id, proposal.id, { ...body, note: 'Changed retry' })).toThrow('already used')
  } finally { reopened.close() }
})

it('rejects cycles, dangling and repeated dependencies, duplicate action IDs, authority fields and oversized plans', async () => {
  const { h, workspace, mission } = await fixture()
  const a = { id: 'a', title: 'A', instructions: 'Do A', owner: 'agent' as const, dependsOn: [] as string[] }
  for (const actions of [[a, a], [{ ...a, dependsOn: ['missing'] }], [{ ...a, dependsOn: ['a'] }],
    [{ ...a, dependsOn: ['b', 'b'] }, { ...a, id: 'b' }], [{ ...a, dependsOn: ['b'] }, { ...a, id: 'b', dependsOn: ['a'] }]]) {
    expect(PlanDefinition.safeParse({ ...definitionOf(mission), actions }).success).toBe(false)
  }
  const plan = { ...definitionOf(mission), actions: Array.from({ length: 12 }, (_, i) => ({ ...a, id: String(i), instructions: 'x'.repeat(12000) })) }
  expect(PlanDefinition.safeParse(plan).success).toBe(false)
  expect((await h.api('POST', `missions/${mission.id}/proposals`, { requestId: rid(), baseVersion: 1, rationale: 'Change',
    plan: definitionOf(mission), author: { role: 'operator' } })).status).toBe(400)
  expect((await h.api('GET', `missions/${mission.id}/plans/0`)).status).toBe(400)
  expect((await h.api('GET', `missions/${mission.id}/plans/999`)).status).toBe(404)
  let large = mission
  for (let i = 0; i < 10; i++) large = workspace.add(large.id, { requestId: rid(), revision: large.revision, title: `Step ${i}`, owner: 'person', instructions: 'x'.repeat(12000) })
  expect(() => workspace.add(large.id, { requestId: rid(), revision: large.revision, title: 'Too large', owner: 'person', instructions: 'x'.repeat(12000) })).toThrow('128,000')
  expect(workspace.get(large.id).planVersion).toBe(large.planVersion)
})

it('refuses stale proposal approvals and concurrent mission edits, but permits rejecting obsolete proposals', async () => {
  const { workspace, mission } = await fixture()
  const first = propose(workspace, mission), second = propose(workspace, mission)
  workspace.update(mission.id, { requestId: rid(), revision: mission.revision, status: 'archived' })
  expect(() => review(workspace, first)).toThrow('Reopen')
  workspace.update(mission.id, { requestId: rid(), revision: workspace.get(mission.id).revision, status: 'active' })
  expect(() => workspace.plans.review(mission.id, first.id, { requestId: rid(), revision: 1, missionRevision: 1, decision: 'approve', note: 'Outdated view' })).toThrow('Mission changed')
  review(workspace, first)
  expect(() => review(workspace, second)).toThrow('stale')
  expect(review(workspace, second, 'reject').status).toBe('rejected')
  expect(workspace.plans.list(mission.id).versions).toHaveLength(2)
})

it('protects affected running work while permitting independent additions without replacing its mandate', async () => {
  const { h, workspace, mission } = await fixture()
  let m = add(workspace, mission, 'Research')
  m = workspace.act(m.id, m.actions[0]!.id, { requestId: rid(), revision: m.revision, command: 'run' }); await h.runtime.idle()
  const original = h.runtime.store.tickets.get(m.actions[0]!.ticket!.id)!
  const changed = definitionOf(m); changed.actions[0]!.instructions = 'A different job'
  expect(() => review(workspace, propose(workspace, m, changed))).toThrow('Stop or finish')
  const independent = definitionOf(m); independent.actions.push({ id: 'parallel', title: 'Collect notes', instructions: 'Collect notes', owner: 'person', dependsOn: [] })
  review(workspace, propose(workspace, m, independent))
  const updated = workspace.get(m.id)
  expect(updated.actions[0]!.ticket?.id).toBe(original.id)
  expect(updated.actions[0]!.ticket?.currentDefinition).toBe(true)
  expect(h.runtime.store.tickets.get(original.id)?.mandate).toEqual(original.mandate)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  await h.runTool(updated.actions[0]!.ticket!.sessionId!, 'orchestrator_report', { state: 'ready', summary: 'First result' })
  await h.api('POST', 'executor/pause', { paused: true })
  h.runtime.inbox.reply(original.id, { requestId: rid(), revision: h.runtime.inbox.item(original.id).revision, text: 'Revise this result' })
  const pending = workspace.get(m.id), revised = definitionOf(pending); revised.actions[0]!.instructions = 'Change the task'
  expect(() => review(workspace, propose(workspace, pending, revised))).toThrow('Stop or finish')
})

it('invalidates changed and downstream reviewed results, blocks old-ticket steering, and issues a new mandate on rerun', async () => {
  const { h, workspace, mission } = await fixture()
  let m = add(workspace, mission, 'Research'); m = add(workspace, m, 'Synthesize', 'agent', [m.actions[0]!.id])
  m = accept(workspace, await ready(h, m)); m = accept(workspace, await ready(h, m, 1), 1)
  const old = m.actions[0]!.ticket!.id, plan = definitionOf(m); plan.actions[0]!.instructions = 'Research a revised question'
  review(workspace, propose(workspace, m, plan)); m = workspace.get(m.id)
  expect(m.completed).toBe(0)
  expect(m.actions.map(action => action.status)).toEqual(['outdated', 'outdated'])
  expect(h.runtime.inbox.item(old)).toMatchObject({ canReply: false, status: 'outdated' })
  expect(h.runtime.inbox.list({ filter: 'review' }).items).toEqual([])
  expect(() => accept(workspace, m)).toThrow('latest completed')
  expect(() => workspace.act(m.id, m.actions[0]!.id, { requestId: rid(), revision: m.revision, command: 'steer', text: 'Continue' })).toThrow('definition changed')
  m = workspace.act(m.id, m.actions[0]!.id, { requestId: rid(), revision: m.revision, command: 'run' })
  expect(m.actions[0]!.runs).toHaveLength(2)
  expect(m.actions[0]!.ticket!.id).not.toBe(old)
  expect(h.runtime.store.tickets.get(m.actions[0]!.ticket!.id)?.mandate.scope).toBe('Research a revised question')
})

it('restores old definitions as new versions and new action identities while preserving removed-run history', async () => {
  const { h, workspace, mission } = await fixture()
  let m = add(workspace, mission, 'Research'); m = await ready(h, m)
  const historical = workspace.plans.version(m.id, m.planVersion), oldAction = m.actions[0]!, empty = definitionOf(m); empty.actions = []
  review(workspace, propose(workspace, m, empty)); m = workspace.get(m.id)
  expect(h.runtime.inbox.item(oldAction.ticket!.id).mission).toMatchObject({ id: m.id, current: false })
  review(workspace, propose(workspace, m, historical.plan)); m = workspace.get(m.id)
  expect(m.actions[0]!.id).not.toBe(oldAction.id)
  expect(m.actions[0]!.runs).toEqual([])
  expect(workspace.plans.version(m.id, 2)).toEqual(historical)
  expect(h.runtime.store.tickets.get(oldAction.ticket!.id)).toBeTruthy()
})

it('can change an ended agent action to human ownership and accept the new human result', async () => {
  const { h, workspace, mission } = await fixture()
  let m = await ready(h, add(workspace, mission, 'Review'))
  const plan = definitionOf(m); plan.actions[0]!.owner = 'person'
  review(workspace, propose(workspace, m, plan)); m = workspace.get(m.id)
  expect(m.actions[0]!.status).toBe('todo')
  expect(accept(workspace, m).completed).toBe(1)
})

it('launches one planner through actual routes and binds its proposal tools to its own mission without approval authority', async () => {
  const { h, workspace, plans, mission } = await fixture()
  const body = { requestId: rid(), revision: mission.revision, instructions: 'Include an independent review step' }
  const result = await h.api('POST', `missions/${mission.id}/plan-request`, body)
  expect(result.status).toBe(200)
  const m = result.body as unknown as MissionView, sessionId = m.actions[0]!.ticket!.sessionId!
  await h.runtime.idle()
  expect((await h.api('POST', `missions/${mission.id}/plan-request`, body)).status).toBe(200)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  const tool = await h.runTool(sessionId, 'workspace_plan_read', {})
  expect(tool.currentVersion).toBe(m.planVersion)
  const candidate = { ...definitionOf(m), actions: [{ id: 'write', title: 'Write brief', instructions: 'Write the brief', owner: 'agent' as const, dependsOn: [] }] }
  const proposalBody = { requestId: rid(), baseVersion: m.planVersion, rationale: 'A complete plan', plan: candidate }
  const submitted = await h.runTool(sessionId, 'workspace_plan_propose', proposalBody)
  expect(plans.proposal(m.id, String(submitted.id)).author).toMatchObject({ role: 'worker', ticketId: m.actions[0]!.ticket!.id })
  expect((await h.runTool(sessionId, 'workspace_plan_propose', proposalBody)).id).toBe(submitted.id)
  expect(workspace.get(m.id).planVersion).toBe(m.planVersion)
  expect(h.tools.get(sessionId)?.has('workspace_plan_approve')).toBe(false)
  const other = workspace.create({ requestId: rid(), title: 'Private mission', objective: 'Separate work', acceptance: 'Separate review' })
  expect(() => plans.propose(other.id, { ...proposalBody, requestId: rid(), baseVersion: 1 }, m.actions[0]!.ticket!.id)).toThrow('Mission not found')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workspace: { enabled: false, config: {} } } })
  await expect(h.runTool(sessionId, 'workspace_plan_propose', { ...proposalBody, requestId: rid() })).rejects.toThrow('no longer authorizes')
  h.runtime.store.saveSettings(settings)
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: `Proposed ${submitted.id}` })
  await expect(h.runTool(sessionId, 'workspace_plan_propose', { ...proposalBody, requestId: rid() })).rejects.toThrow('no longer authorizes')
  const reviewed = await h.api('POST', `missions/${m.id}/proposals/${submitted.id}`, { requestId: rid(), revision: 1,
    missionRevision: workspace.get(m.id).revision, decision: 'approve', note: 'Inspected the plan' })
  expect(reviewed.status).toBe(200)
  expect(workspace.get(m.id).actions[0]!.title).toBe('Write brief')
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  const surfaces = planningTools(plans, m.actions[0]!.ticket!.id).map(({ name, description, schema }) => ({ name, description, parameters: z.toJSONSchema(schema) }))
  expect(JSON.stringify(surfaces).length).toBeLessThanOrEqual(4000)
})

it('rolls back a failed planner dispatch and migrates legacy mission definitions once without changing their accepted results', async () => {
  const { h, workspace, mission } = await fixture()
  const completed = accept(workspace, add(workspace, mission, 'Human review', 'person'))
  await h.api('POST', 'executor/pause', { paused: true })
  expect(() => workspace.plans.request(mission.id, { requestId: rid(), revision: completed.revision })).toThrow('resume')
  expect(workspace.get(mission.id)).toEqual(completed)
  expect(workspace.plans.list(mission.id).versions).toHaveLength(2)
  const legacy = JSON.parse(String(h.runtime.store.db.prepare('SELECT value FROM workspace_mission WHERE id=?').get(mission.id)!.value)) as Partial<MissionView>
  delete legacy.planVersion
  h.runtime.store.db.prepare('UPDATE workspace_mission SET value=? WHERE id=?').run(JSON.stringify(legacy), mission.id)
  h.runtime.store.db.prepare('DELETE FROM workspace_plan_version WHERE mission=?').run(mission.id)
  new Workspace(h.runtime.store, () => h.runtime.engine, () => false)
  new Workspace(h.runtime.store, () => h.runtime.engine, () => false)
  expect(workspace.get(mission.id).revision).toBe(completed.revision)
  expect(workspace.get(mission.id).completed).toBe(1)
  expect(workspace.plans.list(mission.id).versions).toHaveLength(1)
})
