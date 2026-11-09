import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Library } from '../src/workspace/library.ts'
import { Recall } from '../src/workspace/recall.ts'
import type { LibraryActor, LibraryEntry, PublishRecordInput } from '../src/workspace/library-model.ts'
import type { RecallPolicy } from '../src/workspace/recall-model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const cleanup: (() => void | Promise<void>)[] = [], signal = () => new AbortController().signal
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const router: LibraryActor = { role: 'router' }
const input = (extra: Partial<PublishRecordInput> = {}) => ({ requestId: randomUUID(), kind: 'memory' as const, title: 'Source finding', summary: 'Evidence to inspect', content: 'Source fact', ...extra })
function fixture(path?: string) {
  const directory = path ?? mkdtempSync(join(tmpdir(), 'dsh-recall-')), store = new Store(join(directory, 'state.sqlite'))
  let at = '2026-11-09T12:00:00.000Z', closed = false
  const library = new Library(store, () => at), recall = library.recall
  const close = () => { if (!closed) { closed = true; store.close() } }
  cleanup.push(() => { close(); if (!path) rmSync(directory, { recursive: true, force: true }) })
  return { directory, store, library, recall, close, time: (value: string) => { at = value } }
}
function configure(recall: Recall, owner: Partial<RecallPolicy['owner']> = {}, run: Partial<RecallPolicy['run']> = {}) {
  const current = recall.configuration()
  return recall.configure({ requestId: randomUUID(), revision: current.revision,
    policy: { owner: { ...current.policy.owner, ...owner }, run: { ...current.policy.run, ...run } } })
}
function chain(library: Library, length = 3): LibraryEntry[] {
  const records: LibraryEntry[] = []
  for (let index = 0; index < length; index++) records.push(library.publish(input({ title: `Source ${index}`, content: `Fact ${index}`,
    sources: records.length ? [{ id: records.at(-1)!.id, relation: 'derived_from' }] : [] })))
  return records
}
async function worker(host: Host) {
  const workspace = host.runtime.workspace
  let mission = workspace.create({ requestId: randomUUID(), title: 'Recall proof', objective: 'Use sources', acceptance: 'Check source changes' })
  mission = workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Read evidence', owner: 'agent', instructions: 'Review evidence' })
  mission = workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
  await host.runtime.idle(); const ticketId = mission.actions[0]!.ticket!.id
  return { mission, ticketId, sessionId: `worker-${ticketId}`, actor: { role: 'worker' as const, ticketId } }
}
it('returns a scoped source chain with exact serialized-byte accounting and bounded link depth', () => {
  const { library, recall } = fixture(), records = chain(library, 4), root = records.at(-1)!
  const result = recall.read({ id: root.id }, router, signal())
  expect(result.chain.map(item => item.id)).toEqual([records[2]!.id, records[1]!.id])
  expect(result.recall).toMatchObject({ charged: { calls: 1, pages: 3, nodes: 4 }, truncated: true })
  expect(result.recall.charged.bytes).toBe(Buffer.byteLength(JSON.stringify(result)))
  expect(recall.state().attempts[0]!.charged).toEqual(result.recall.charged)
  expect(result.freshness).toMatchObject({ status: 'current', complete: true, checked: 4 })
})
it('bounds pages and unique inspected nodes even when a model asks for deeper traversal', () => {
  const { library, recall } = fixture(), records = chain(library, 6)
  configure(recall, {}, { pages: 2, nodes: 2, depth: 1 })
  const result = recall.read({ id: records.at(-1)!.id, depth: 8 }, router, signal())
  expect(result.chain).toHaveLength(1); expect(result.recall.charged.pages).toBe(2); expect(result.recall.charged.nodes).toBe(2)
  expect(result.recall.truncated).toBe(true); expect(result.freshness).toMatchObject({ status: 'unknown', complete: false })
  expect(result.freshness?.issues.some(issue => issue.reason === 'limit')).toBe(true)
})
it('counts search metadata and receipts in the output ceiling and preserves exact pagination after trimming', () => {
  const { library, recall } = fixture()
  for (let n = 0; n < 20; n++) library.publish(input({ title: `${n} ${'t'.repeat(130)}`, summary: 's'.repeat(500) }))
  configure(recall, {}, { bytes: 4096 })
  const first = recall.search({ limit: 20 }, router, signal())
  expect(first.items.length).toBeGreaterThan(0); expect(first.items.length).toBeLessThan(20)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(4096)
  expect(first.recall.charged.bytes).toBe(Buffer.byteLength(JSON.stringify(first)))
  expect(first.nextOffset).toBe(first.items.length)
  const next = recall.search({ offset: first.nextOffset!, limit: 20 }, router, signal())
  expect(next.items.some(item => first.items.some(prior => prior.id === item.id))).toBe(false)
})
it('bounds multibyte content and provides a continuation offset for a shortened root excerpt', () => {
  const { library, recall } = fixture(), record = library.publish(input({ content: '世界🌍'.repeat(5000) }))
  configure(recall, {}, { bytes: 4096 })
  const result = recall.read({ id: record.id, limit: 8000, depth: 0 }, router, signal())
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  expect(result.nextOffset).toBe(result.content!.length); expect(result.recall.truncated).toBe(true)
})
it('preserves cumulative allowances across reopen, query changes and time windows', () => {
  const f = fixture(); f.library.publish(input()); configure(f.recall, { calls: 2 })
  f.recall.search({ q: 'Source' }, router, signal()); f.close()
  const g = fixture(f.directory); g.recall.search({ q: 'finding' }, router, signal())
  expect(() => g.recall.search({}, router, signal())).toThrow('Recall allowance exhausted')
  g.time('2026-11-10T00:00:00.000Z'); expect(g.recall.search({}, router, signal()).recall.owner.day).toBe('2026-11-10')
})
it('keeps a lost-process reservation charged and prevents concurrent admissions from exceeding one allowance', async () => {
  const f = fixture(); f.library.publish(input()); configure(f.recall, { calls: 1 })
  const results = await Promise.allSettled([Promise.resolve().then(() => f.recall.search({}, router, signal())), Promise.resolve().then(() => f.recall.search({}, router, signal()))])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const original = f.recall.state().attempts[0]!, interrupted = { ...original, phase: 'reserved', charged: original.reserved }
  f.store.db.prepare('UPDATE workspace_recall_attempt SET value=? WHERE id=?').run(JSON.stringify(interrupted), original.id); f.close()
  const g = fixture(f.directory)
  expect(g.recall.state().attempts[0]).toEqual(interrupted)
  expect(() => g.recall.search({}, router, signal())).toThrow('Recall allowance exhausted')
})
it('charges failed reads, rejects pre-aborted requests, and exposes time-limited inspection as unknown', () => {
  const f = fixture(), records = chain(f.library)
  const abort = new AbortController(); abort.abort()
  expect(() => f.recall.read({ id: records[0]!.id }, router, abort.signal)).toThrow(); expect(f.recall.state().attempts).toEqual([])
  expect(() => f.recall.read({ id: randomUUID() }, router, signal())).toThrow('not found')
  expect(f.recall.state().attempts[0]).toMatchObject({ phase: 'failed', charged: { calls: 1, bytes: 0 } })
  let time = 0
  const slow = new Recall(f.store, f.library, () => '2026-11-09T12:00:00.000Z', () => time)
  const original = f.library.read.bind(f.library)
  vi.spyOn(f.library, 'read').mockImplementation((...args) => { time += 101; return original(...args) })
  const result = slow.read({ id: records.at(-1)!.id }, router, signal())
  expect(result.recall.truncated).toBe(true); expect(result.freshness?.status).toBe('unknown')
  expect(result.recall.charged.millis).toBe(101)
})
it('propagates archive, expiry, supersession and contradiction through multiple source levels', () => {
  const f = fixture(), records = chain(f.library), [leaf, , root] = records
  f.library.archive(leaf!.id, { requestId: randomUUID(), revision: 1, archived: true })
  expect(f.library.read(root!.id)).toMatchObject({ staleSources: [leaf!.id], freshness: { status: 'stale' } })
  f.library.archive(leaf!.id, { requestId: randomUUID(), revision: 2, archived: false })
  f.library.publish(input({ sources: [{ id: leaf!.id, relation: 'supersedes' }] }))
  expect(f.library.read(root!.id).freshness?.issues).toContainEqual({ id: leaf!.id, reason: 'superseded' })
  const other = chain(f.library); f.library.publish(input({ sources: [{ id: other[0]!.id, relation: 'contradicts' }] }))
  expect(f.library.read(other[2]!.id)).toMatchObject({ conflicted: true, freshness: { status: 'contested' } })
  const expiring = f.library.publish(input({ expiresAt: '2026-11-09T13:00:00.000Z' })), derived = f.library.publish(input({ sources: [{ id: expiring.id, relation: 'derived_from' }] }))
  f.time('2026-11-09T14:00:00.000Z'); expect(f.library.read(derived.id).freshness?.issues).toContainEqual({ id: expiring.id, reason: 'expired' })
})
it('marks damaged provenance unknown, detects hash mismatch and terminates corrupted cycles', () => {
  const f = fixture(), records = chain(f.library), [leaf, , root] = records
  f.store.db.prepare("UPDATE workspace_library SET value=json_set(value,'$.hash',?) WHERE id=?").run('a'.repeat(64), leaf!.id)
  expect(f.library.read(root!.id).freshness?.issues.some(issue => issue.reason === 'hash_mismatch')).toBe(true)
  const cyclic = { ...leaf!, sources: [{ id: root!.id, relation: 'references', hash: root!.hash }] }
  f.store.db.prepare('UPDATE workspace_library SET value=? WHERE id=?').run(JSON.stringify(cyclic), leaf!.id)
  expect(f.library.read(root!.id).freshness).toMatchObject({ status: 'unknown', complete: false })
  f.store.db.prepare('DELETE FROM workspace_library WHERE id=?').run(leaf!.id)
  expect(f.library.read(root!.id).freshness?.issues.some(issue => issue.reason === 'unavailable_source')).toBe(true)
})
it('enforces worker scope for every chain node and shares allowance across calls from recreated tools', async () => {
  const host = await startRuntime(); cleanup.push(() => host.stop()); const a = await worker(host), b = await worker(host), library = host.runtime.library
  const shared = library.publish(input()), secret = library.publish(input({ content: 'Private second mission', sources: [{ id: shared.id, relation: 'references' }] }), b.actor)
  const root = library.publish(input({ sources: [{ id: shared.id, relation: 'derived_from' }] }), a.actor)
  const result = await host.runTool(a.sessionId, 'workspace_read', { id: root.id }) as unknown as ReturnType<Recall['read']>
  expect(result.chain.map((item: LibraryEntry) => item.id)).toEqual([shared.id])
  expect(JSON.stringify(result)).not.toContain(secret.id); expect(JSON.stringify(result)).not.toContain('Private second mission')
  configure(library.recall, { calls: 2 })
  await expect(host.runTool(a.sessionId, 'workspace_read', { id: secret.id })).rejects.toThrow('not found')
  await expect(host.runTool(a.sessionId, 'workspace_search', {})).rejects.toThrow('Recall allowance exhausted')
  expect(library.recall.state().attempts.filter(item => item.owner.ticketId === a.ticketId)).toHaveLength(2)
})
it('invalidates human-reviewed memory on distant changes without invalidating for unrelated records', async () => {
  const host = await startRuntime(); cleanup.push(() => host.stop()); const w = await worker(host), library = host.runtime.library, workspace = host.runtime.workspace
  const sources = chain(library, 36), artifact = library.publish(input({ kind: 'memory', sources: [{ id: sources.at(-1)!.id, relation: 'derived_from' }] }), w.actor)
  expect(library.read(artifact.id).freshness).toMatchObject({ status: 'unknown', complete: false })
  await host.runTool(w.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Candidate memory ready' })
  let mission = workspace.get(w.mission.id), action = mission.actions[0]!
  mission = workspace.act(mission.id, action.id, { requestId: randomUUID(), revision: mission.revision, command: 'complete', ticketRevision: action.ticket!.revision, text: 'Operator reviewed sources', reviewKind: 'operator' })
  const before = library.evidenceRevision(w.ticketId)
  library.publish(input({ title: 'Unrelated record' })); expect(library.evidenceRevision(w.ticketId)).toBe(before)
  library.archive(sources[0]!.id, { requestId: randomUUID(), revision: 1, archived: true })
  expect(library.evidenceRevision(w.ticketId)).not.toBe(before)
  expect(workspace.get(mission.id).actions[0]!.status).not.toBe('done')
  // A damaged cyclic edge index must also terminate during complete review hashing, independently of display limits.
  host.runtime.store.db.prepare('INSERT INTO workspace_library_edge VALUES (?,?,?)').run(sources[0]!.id, artifact.id, 'references')
  expect(typeof library.evidenceRevision(w.ticketId)).toBe('string')
})
it('keeps revision-bound configuration idempotent through actual API routes and rejects model-controlled scope', async () => {
  const host = await startRuntime(); cleanup.push(() => host.stop()); const current = host.runtime.library.recall.configuration()
  const request = { requestId: 'configure-recall', revision: current.revision, policy: { ...current.policy, owner: { ...current.policy.owner, calls: 7 } } }
  expect((await host.api('PUT', 'recall', request)).status).toBe(200)
  expect((await host.api('PUT', 'recall', request)).body).toMatchObject({ revision: 1, policy: { owner: { calls: 7 } } })
  expect((await host.api('GET', 'recall/versions/0')).body).toEqual(current)
  expect((await host.api('PUT', 'recall', { ...request, requestId: 'stale' })).status).toBe(409)
  expect((await host.api('PUT', 'recall', { ...request, policy: current.policy })).status).toBe(409)
  await expect(host.runTool(host.runtime.masterId, 'workspace_search', { scope: 'workspace' })).rejects.toThrow()
})
