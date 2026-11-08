import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Store } from '../src/app/store.ts'
import { Personas } from '../src/personas/service.ts'
import { PersonaDefinition, type PersonaRef } from '../src/personas/model.ts'
import { definitionOf } from '../src/workspace/plan-model.ts'
import { KV } from '../src/kv.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined; vi.restoreAllMocks() })
const rid = () => randomUUID()
const definition = (): PersonaDefinition => ({ name: 'Researcher', description: 'Evidence-backed research', instructions: 'Cite primary evidence. Preserve literal ${{ expressions }}.',
  model: null, capabilities: ['read', 'skills'], skills: [{ name: 'evidence', description: 'Evidence procedure', content: 'Keep an evidence ledger.' }] })
async function fixture() {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  return { h: host, personas: host.runtime.personas, workspace: host.runtime.workspace }
}
async function mission(persona: PersonaRef) {
  const { h, personas, workspace } = { h: host!, personas: host!.runtime.personas, workspace: host!.runtime.workspace }
  let m = workspace.create({ requestId: rid(), title: 'Evidence brief', objective: 'Research the evidence', acceptance: 'Review evidence' })
  m = workspace.add(m.id, { requestId: rid(), revision: m.revision, title: 'Research', instructions: 'Write a brief', owner: 'agent', persona })
  return { h, personas, workspace, m }
}

it('persists immutable versions, archive revisions and exact response-loss receipts across database reopen', async () => {
  const { h, personas } = await fixture(), input = { requestId: rid(), definition: definition() }
  const first = await personas.create(input), pinned = personas.snapshot({ id: first.id, version: 1 })
  const update = { requestId: rid(), revision: 1, definition: { ...definition(), instructions: 'A different procedure' } }
  const second = await personas.update(first.id, update)
  const archived = personas.archive(first.id, { requestId: rid(), revision: 2, archived: true, reason: 'Retire this definition' })
  expect(archived).toMatchObject({ version: 2, revision: 3, archived: true })
  const store = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const restored = new Personas(store)
    expect(await restored.create(input)).toEqual(first)
    expect(await restored.update(first.id, update)).toEqual(second)
    expect(restored.version(first.id, 1)).toEqual(pinned)
    expect(() => restored.snapshot({ id: first.id, version: 1 })).toThrow('archived')
    expect(() => restored.verify(pinned)).not.toThrow()
    expect(() => restored.verify({ ...pinned, definition: { ...pinned.definition, instructions: 'tampered' } })).toThrow('immutable')
    await expect(restored.update(first.id, { ...update, definition: definition() })).rejects.toThrow('another payload')
    await expect(restored.update(first.id, { ...update, requestId: rid() })).rejects.toThrow('changed')
    restored.archive(first.id, { requestId: rid(), revision: 3, archived: false, reason: 'Make available again' })
    expect(restored.snapshot({ id: first.id, version: 1 })).toEqual(pinned)
  } finally { store.close() }
})

it('checks model availability before commit and rechecks revisions after asynchronous validation', async () => {
  const { h } = await fixture(), validate = vi.fn(async () => {}), personas = new Personas(h.runtime.store, validate)
  const model = { provider: 'test-provider', model: 'test-model' }
  validate.mockRejectedValueOnce(new Error('Unknown model'))
  await expect(personas.create({ requestId: rid(), definition: { ...definition(), model } })).rejects.toThrow('Unknown model')
  expect(personas.list().items).toEqual([])
  const first = await personas.create({ requestId: rid(), definition: definition() })
  let release!: () => void
  validate.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const pending = personas.update(first.id, { requestId: rid(), revision: 1, definition: { ...definition(), model } })
  personas.archive(first.id, { requestId: rid(), revision: 1, archived: true, reason: 'Concurrent change' })
  release(); await expect(pending).rejects.toThrow('changed')
  expect(personas.get(first.id)).toMatchObject({ version: 1, revision: 2 })
})

it('bounds catalogs and rejects duplicate capabilities, invalid skills and oversized definitions', async () => {
  const { personas } = await fixture()
  for (let i = 0; i < 32; i++) await personas.create({ requestId: rid(), definition: { ...definition(), name: `Research ${i}` } })
  const page = personas.list({ q: 'RESEARCH', active: 'true' })
  expect(page.items).toHaveLength(30); expect(page.nextOffset).toBe(30)
  expect(personas.list({ offset: 30 }).items).toHaveLength(2)
  expect(JSON.stringify(page)).not.toContain('instructions')
  const item = page.items[0]!
  personas.archive(item.id, { requestId: rid(), revision: 1, archived: true, reason: 'Archive' })
  expect(personas.list({ active: 'false' }).items.map(item => item.id)).toEqual([item.id])
  for (const invalid of [{ ...definition(), capabilities: ['read', 'read'] }, { ...definition(), capabilities: ['read'] },
    { ...definition(), skills: [definition().skills[0], definition().skills[0]] },
    { ...definition(), skills: [{ ...definition().skills[0], name: 'bad/name' }] },
    { ...definition(), skills: Array.from({ length: 6 }, (_, i) => ({ name: `skill-${i}`, description: 'A skill', content: 'x'.repeat(12000) })) }])
    expect(PersonaDefinition.safeParse(invalid).success).toBe(false)
})

it('copies the reviewed version into an execution and keeps its prompt, capabilities and Session pin after edits and archive', async () => {
  const { h, personas } = await fixture(), first = await personas.create({ requestId: rid(), definition: definition() })
  const { workspace, m } = await mission({ id: first.id, version: 1 })
  expect(definitionOf(m).actions[0]!.persona).toEqual({ id: first.id, version: 1 })
  const command = { requestId: rid(), revision: m.revision, command: 'run' }
  const running = workspace.act(m.id, m.actions[0]!.id, command)
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(running.actions[0]!.ticket!.id)!, sessionId = `worker-${ticket.id}`
  expect(ticket.execution!.persona).toEqual(personas.version(first.id, 1))
  expect(h.runtime.store.get(KV.sessions.persona(sessionId))).toBe(first.digest)
  const agent = h.agents.get(sessionId)! as unknown as Agent, checks = vi.mocked(agent.ctx.tools.guard).mock.calls.map(([check]) => check)
  const denied = (name: string) => checks.map(check => check({ name } as never)).filter(Boolean)
  expect(denied('bash').join(' ')).toContain('commands')
  expect(denied('web_search').join(' ')).toContain('web')
  expect(denied('read')).toEqual([])
  expect(denied('workspace_publish')).toEqual([])
  await personas.update(first.id, { requestId: rid(), revision: 1, definition: { ...definition(), capabilities: ['read', 'commands', 'skills'] } })
  personas.archive(first.id, { requestId: rid(), revision: 2, archived: true, reason: 'No new runs' })
  expect(workspace.act(m.id, m.actions[0]!.id, command).actions[0]!.runs).toEqual([ticket.id])
  expect(denied('bash').join(' ')).toContain('commands')
  expect((await h.api('GET', `tickets/${ticket.id}`)).body.executionPersona).toEqual(ticket.execution!.persona)
  await h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, 'Resume pinned worker', 'worker')
  expect(h.runtime.store.tickets.get(ticket.id)!.execution!.persona).toEqual(ticket.execution!.persona)
  h.runtime.store.tickets.save({ ...ticket, execution: { ...ticket.execution!, persona: personas.version(first.id, 2) } })
  await expect(h.runtime.sessions.ensure(sessionId, ticket.execution!.directory, 'Forbidden replacement', 'worker')).rejects.toThrow('another persona')
  expect(denied('read').join(' ')).toContain('persona changed')
})

it('rejects archived selection before creating any task and refuses personas on human actions', async () => {
  const { h, personas } = await fixture(), first = await personas.create({ requestId: rid(), definition: definition() })
  const { workspace, m } = await mission({ id: first.id, version: 1 })
  expect((await h.api('POST', `missions/${m.id}/actions`, { requestId: rid(), revision: m.revision, title: 'Review', instructions: 'Read', owner: 'person', persona: { id: first.id, version: 1 } })).status).toBe(400)
  personas.archive(first.id, { requestId: rid(), revision: 1, archived: true, reason: 'Retire' })
  expect(() => workspace.act(m.id, m.actions[0]!.id, { requestId: rid(), revision: m.revision, command: 'run' })).toThrow('archived')
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(workspace.get(m.id).actions[0]!.runs).toEqual([])
})

it('treats persona changes and removal as reviewed plan changes while preserving historical definitions', async () => {
  const { personas } = await fixture(), first = await personas.create({ requestId: rid(), definition: definition() })
  const { workspace, m } = await mission({ id: first.id, version: 1 })
  await personas.update(first.id, { requestId: rid(), revision: 1, definition: { ...definition(), instructions: 'Second version' } })
  const plan = definitionOf(m); plan.actions[0]!.persona!.version = 2
  const changed = workspace.applyPlan(m.id, m.revision, plan, 'reviewed-change')
  expect(changed.actions[0]).toMatchObject({ definitionRevision: 2, persona: { version: 2 } })
  expect(workspace.plans.version(m.id, m.planVersion).plan.actions[0]!.persona!.version).toBe(1)
  delete plan.actions[0]!.persona
  const removed = workspace.applyPlan(m.id, changed.revision, plan, 'reviewed-removal')
  expect(removed.actions[0]!.persona).toBeUndefined()
  expect(removed.actions[0]!.definitionRevision).toBe(3)
})

it('restores a descendant through an unloaded parent and blocks loss of its durable persona ownership', async () => {
  const { h, personas } = await fixture(), first = await personas.create({ requestId: rid(), definition: definition() })
  const { workspace, m } = await mission({ id: first.id, version: 1 })
  const running = workspace.act(m.id, m.actions[0]!.id, { requestId: rid(), revision: m.revision, command: 'run' })
  await h.runtime.idle()
  const worker = running.actions[0]!.ticket!.id, parent = `worker-${worker}`
  await h.controller.create({ sessionId: 'resumed-child' } as never)
  const child = h.agents.get('resumed-child')! as unknown as Agent
  Object.assign(child.session.header, { parentSession: 'unloaded-parent' })
  vi.spyOn(h.controller, 'inspect').mockImplementation(async (...args) => {
    if (args[0] === 'unloaded-parent') return { meta: { parentSession: parent }, events: [] } as never
    throw new Error('Parent unavailable')
  })
  await h.ctx.parallel('agent/created', { agent: child } as never)
  expect(h.runtime.store.get(KV.sessions.persona(child.id))).toBe(first.digest)
  expect(h.runtime.store.get(KV.sessions.personaOwner(child.id))).toBe(worker)
  const checks = vi.mocked(child.ctx.tools.guard).mock.calls.map(([check]) => check)
  expect(checks.some(check => String(check({ name: 'subagent' } as never)).includes('delegation'))).toBe(true)
  // Durable anchors retain the persona for teams deeper than the bounded cold-header traversal.
  let preceding = child.id
  for (let i = 0; i < 10; i++) {
    const id = `deep-child-${i}`
    await h.controller.create({ sessionId: id } as never)
    const descendant = h.agents.get(id)! as unknown as Agent
    Object.assign(descendant.session.header, { parentSession: preceding })
    await h.ctx.parallel('agent/created', { agent: descendant } as never)
    expect(h.runtime.store.get(KV.sessions.personaOwner(id))).toBe(worker)
    expect(h.runtime.store.get(KV.sessions.persona(id))).toBe(first.digest)
    preceding = descendant.id
  }
  h.runtime.engine.stopTicket(worker)
  expect(checks.some(check => String(check({ name: 'read' } as never)).includes('Ticket ended'))).toBe(true)
  await h.controller.create({ sessionId: 'lost-owner-child' } as never)
  const orphan = h.agents.get('lost-owner-child')! as unknown as Agent
  Object.assign(orphan.session.header, { parentSession: 'missing-parent' })
  h.runtime.store.set(KV.sessions.persona(orphan.id), first.digest)
  await expect(h.ctx.parallel('agent/created', { agent: orphan } as never)).rejects.toBeDefined()
  expect(vi.mocked(orphan.ctx.tools.guard).mock.calls.some(([check]) => String(check({ name: 'read' } as never)).includes('owning task'))).toBe(true)
})
