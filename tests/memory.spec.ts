import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Memory, MemoryAccess, MemoryError } from '../src/memory/service.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
const KEYS = ['DSH_ORCHESTRATOR_ADMIN_TOKEN', 'DSH_ORCHESTRATOR_ROLE'] as const
const TOKEN = 'memory-test-token-0123456789abcdefgh'
const temporary: string[] = []

afterEach(async () => {
  await host?.stop(); host = undefined
  for (const key of KEYS) delete process.env[key]
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-'))
  temporary.push(directory)
  const store = new Store(join(directory, 'state.sqlite'))
  return { directory, store, memory: new Memory({ store }) }
}
const fact = (content: string, extra: Record<string, unknown> = {}) => ({
  kind: 'fact' as const, scope: { type: 'personal' as const }, subject: '', content, ...extra,
})

it('persists memory across a Store restart and returns it by full-text search', () => {
  const first = fixture()
  const saved = first.memory.save(MemoryAccess.owner(), fact('The deploy pipeline uses immutable artifacts', { tags: ['ops'] }))
  expect(saved.created).toBe(true)
  first.store.close()
  const reopened = new Store(join(first.directory, 'state.sqlite'))
  try {
    const memory = new Memory({ store: reopened })
    const page = memory.search(MemoryAccess.owner(), { q: 'immutable artifacts' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ id: saved.record.id, content: 'The deploy pipeline uses immutable artifacts', tags: ['ops'] })
    expect(memory.search(MemoryAccess.owner(), { q: 'ops' }).items).toHaveLength(1)
  } finally { reopened.close() }
})

it('isolates scopes and refuses writes outside the caller grants', () => {
  const { memory } = fixture()
  const personal = memory.save(MemoryAccess.owner(), fact('Personal fact'))
  const business = memory.save(MemoryAccess.owner(), { ...fact('Business fact'), scope: { type: 'business' } })
  const project = memory.save(MemoryAccess.owner(), { ...fact('Project fact'), scope: { type: 'project', project: 'alpha' } })
  const personalOnly = new MemoryAccess(['personal'])
  expect(memory.search(personalOnly).items.map(item => item.id)).toEqual([personal.record.id])
  expect(memory.get(personalOnly, business.record.id)).toBeUndefined()
  expect(memory.get(personalOnly, project.record.id)).toBeUndefined()
  expect(() => memory.save(personalOnly, { ...fact('Cross-scope write'), scope: { type: 'business' } })).toThrow(MemoryError)
  const projectOnly = new MemoryAccess(['project:alpha'])
  expect(memory.search(projectOnly).items.map(item => item.id)).toEqual([project.record.id])
  expect(new MemoryAccess([]).filter()).toBeUndefined()
})

it('deduplicates identical facts and upserts a subject by revision with provenance events', () => {
  const { memory } = fixture()
  const profile = { kind: 'profile' as const, scope: { type: 'personal' as const }, subject: 'Alice', content: 'Prefers concise updates', source: 'operator' as const }
  const first = memory.save(MemoryAccess.owner(), profile)
  const duplicate = memory.save(MemoryAccess.owner(), profile)
  expect(duplicate).toMatchObject({ created: false, record: { id: first.record.id, revision: 1 } })
  const updated = memory.save(MemoryAccess.owner(), { ...profile, content: 'Prefers concise updates and morning briefings', source: 'agent' })
  expect(updated.record).toMatchObject({ id: first.record.id, revision: 2, provenance: { source: 'agent' } })
  expect(memory.search(MemoryAccess.owner(), { kinds: ['profile'] }).items).toHaveLength(1)
  expect(memory.events(MemoryAccess.owner(), first.record.id).map(event => event.action)).toEqual(['created', 'updated'])
  expect(memory.get(new MemoryAccess(['business']), first.record.id)).toBeUndefined()
  expect(memory.events(new MemoryAccess(['business']), first.record.id)).toEqual([])
})

it('filters by kind and hard-deletes the record and its search index while retaining the deletion event', () => {
  const { memory } = fixture()
  const saved = memory.save(MemoryAccess.owner(), fact('Kubernetes cluster is staging only', { tags: ['infra'] }))
  const goal = memory.save(MemoryAccess.owner(), { kind: 'goal', scope: { type: 'business' }, subject: 'Launch', content: 'Ship the private beta' })
  expect(memory.search(MemoryAccess.owner(), { q: 'kubernetes', kinds: ['fact'] }).items).toHaveLength(1)
  expect(memory.search(MemoryAccess.owner(), { q: 'kubernetes', kinds: ['goal'] }).items).toHaveLength(0)
  expect(memory.delete(MemoryAccess.owner(), saved.record.id)).toBe(true)
  expect(memory.get(MemoryAccess.owner(), saved.record.id)).toBeUndefined()
  expect(memory.search(MemoryAccess.owner(), { q: 'kubernetes' }).items).toHaveLength(0)
  expect(memory.events(MemoryAccess.owner(), saved.record.id).map(event => event.action)).toEqual(['created', 'deleted'])
  expect(memory.delete(MemoryAccess.owner(), saved.record.id)).toBe(false)
  expect(memory.search(MemoryAccess.owner(), { q: 'beta' }).items).toHaveLength(1)
  expect(goal.created).toBe(true)
})

it('builds bounded advisory context from normal profiles/goals/preferences/decisions only', () => {
  const { memory } = fixture()
  memory.save(MemoryAccess.owner(), { kind: 'profile', scope: { type: 'personal' }, subject: 'Alice', content: 'Prefers concise updates', sensitivity: 'normal' })
  memory.save(MemoryAccess.owner(), { kind: 'goal', scope: { type: 'business' }, subject: 'Launch', content: 'Ship the private beta', sensitivity: 'normal' })
  memory.save(MemoryAccess.owner(), { kind: 'preference', scope: { type: 'personal' }, subject: 'Briefings', content: 'Morning briefings at 8am', sensitivity: 'normal' })
  memory.save(MemoryAccess.owner(), { kind: 'fact', scope: { type: 'personal' }, subject: '', content: 'A private fact', sensitivity: 'private' })
  memory.captureConversation(MemoryAccess.owner(), { sessionId: 'main', text: 'A conversation turn that must not be auto-injected' })
  const context = memory.context(MemoryAccess.owner(), { limit: 8, maxChars: 1500 })
  expect(context).toContain('[profile] Alice: Prefers concise updates')
  expect(context).toContain('[goal] Launch: Ship the private beta')
  expect(context).toContain('[preference] Briefings: Morning briefings at 8am')
  expect(context).not.toContain('A private fact')
  expect(context).not.toContain('conversation turn')
  expect(memory.context(MemoryAccess.owner(), { limit: 1, maxChars: 1500 })).toBe('- [profile] Alice: Prefers concise updates')
  expect(memory.context(new MemoryAccess(['business']), { limit: 8 })).toContain('Launch')
  expect(memory.context(new MemoryAccess(['business']), { limit: 8 })).not.toContain('Alice')
  memory.save(MemoryAccess.owner(), { kind: 'decision', scope: { type: 'business' }, subject: 'Archive', content: 'x'.repeat(300), sensitivity: 'normal' })
  const bounded = memory.context(MemoryAccess.owner(), { limit: 8, maxChars: 200 })
  expect(bounded.length).toBeLessThanOrEqual(200)
  expect(bounded).not.toContain('Archive')
})

it('captures operator conversation turns privately, deduplicates them, and keeps bounded retention', () => {
  const { memory } = fixture()
  const first = memory.captureConversation(MemoryAccess.owner(), { sessionId: 'main', text: 'Remember the launch is in May' })
  expect(first).toMatchObject({ kind: 'conversation', sensitivity: 'private', scope: { type: 'personal' }, provenance: { source: 'conversation', ref: 'main' } })
  expect(memory.captureConversation(MemoryAccess.owner(), { sessionId: 'main', text: 'Remember the launch is in May' })!.id).toBe(first!.id)
  expect(memory.search(MemoryAccess.owner(), { q: 'launch', kinds: ['conversation'] }).items).toHaveLength(1)
  for (let index = 0; index < 205; index++) memory.captureConversation(MemoryAccess.owner(), { sessionId: 'main', text: `short-term turn ${index}` })
  expect(memory.search(MemoryAccess.owner(), { kinds: ['conversation'], limit: 50 }).items).toHaveLength(50)
  expect(memory.search(MemoryAccess.owner(), { q: 'short-term', kinds: ['conversation'] }).items.length).toBeLessThan(205)
})

it('injects bounded memory context into the main Session prompt and captures its user turns', async () => {
  const h = host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  await h.api('POST', 'memory', { requestId: 'prompt-memory', kind: 'goal', scope: { type: 'business' }, subject: 'Launch',
    content: 'Ship the private beta', sensitivity: 'normal', source: 'operator' })
  const section = h.promptSections.get(`${h.runtime.masterId}:dsh-superagent-policy`)
  expect(section).toBeDefined()
  const prompt = section!.text({})
  expect(prompt).toContain('Persistent memory context')
  expect(prompt).toContain('[goal] Launch: Ship the private beta')
  const agent = h.agents.get(h.runtime.masterId)!
  h.ctx.emit('session/event', (agent as unknown as { session: never }).session, { type: 'user/message', data: {
    content: [{ type: 'text', text: 'Please prepare my priorities for today' }], source: { kind: 'user' } } } as never)
  const captured = h.runtime.memory.search(MemoryAccess.owner(), { q: 'priorities', kinds: ['conversation'] })
  expect(captured.items).toHaveLength(1)
  expect(captured.items[0]).toMatchObject({ sensitivity: 'private', content: 'Please prepare my priorities for today' })
  expect(h.promptSections.get(`${h.runtime.masterId}:dsh-superagent-policy`)!.text({})).not.toContain('priorities for today')
})

it('exposes scope-filtered memory through the management API and audits without content', async () => {
  const h = host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const created = await h.api('POST', 'memory', { requestId: 'memory-1', kind: 'fact', scope: { type: 'personal' },
    subject: 'home', content: 'Lives near Boston', tags: ['profile'], source: 'operator' })
  expect(created.status).toBe(200)
  const record = (created.body as { record: { id: string; revision: number } }).record
  expect(record.revision).toBe(1)
  const search = await h.api('GET', 'memory/search?q=Boston')
  expect(search.body).toMatchObject({ items: [expect.objectContaining({ id: record.id, content: 'Lives near Boston' })] })
  const detail = await h.api('GET', `memory/${record.id}`)
  expect(detail.body).toMatchObject({ record: { id: record.id }, events: [expect.objectContaining({ action: 'created' })] })
  const audit = h.runtime.audit.list(20)
  expect(audit.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'memory.create', resource: record.id })]))
  expect(JSON.stringify(audit.items)).not.toContain('Lives near Boston')
  expect((await h.api('GET', 'memory/search?scope=project%3Aalpha')).body).toEqual({ items: [], nextCursor: null })
  expect((await h.api('GET', 'memory/search?kinds=unknown')).status).toBe(400)
  expect((await h.api('DELETE', `memory/${record.id}`)).body).toEqual({ deleted: true })
  expect((await h.api('GET', `memory/${record.id}`)).status).toBe(404)
})

it('denies memory writes to a viewer while allowing reads', async () => {
  process.env.DSH_ORCHESTRATOR_ADMIN_TOKEN = TOKEN
  process.env.DSH_ORCHESTRATOR_ROLE = 'viewer'
  const h = host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const headers = { authorization: `Bearer ${TOKEN}` }
  expect((await h.api('GET', 'memory/search', undefined, headers)).status).toBe(200)
  const denied = await h.api('POST', 'memory', { requestId: 'viewer-memory', kind: 'fact', scope: { type: 'personal' },
    subject: '', content: 'Viewer must not write', tags: [], source: 'operator' }, headers)
  expect(denied.status).toBe(403)
  expect(h.runtime.memory.search(MemoryAccess.owner(), { q: 'Viewer' }).items).toHaveLength(0)
})
