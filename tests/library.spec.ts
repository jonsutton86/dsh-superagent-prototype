import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Library } from '../src/workspace/library.ts'
import type { LibraryActor, LibraryEntry, PublishRecordInput } from '../src/workspace/library-model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })
let sequence = 0
const requestId = () => `library-${++sequence}`
const input = (extra: Partial<PublishRecordInput> = {}) => ({ requestId: requestId(), kind: 'memory' as const,
  title: 'Research note', summary: 'Findings from the architecture review', content: 'Reliable provenance preserves the source of every claim.', ...extra })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentic-library-')), path = join(directory, 'state.sqlite')
  const store = new Store(path), library = new Library(store)
  disposers.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, library, path }
}
async function hostFixture() { const host = await startRuntime(); disposers.push(() => host.stop()); return host }
async function missionWorker(host: Host) {
  const workspace = host.runtime.workspace
  let m = workspace.create({ requestId: requestId(), title: 'Research', objective: 'Research and save evidence', acceptance: 'Review sources' })
  m = workspace.add(m.id, { requestId: requestId(), revision: m.revision, title: 'Review', owner: 'agent', instructions: 'Write findings' })
  m = workspace.act(m.id, m.actions[0]!.id, { requestId: requestId(), revision: m.revision, command: 'run' })
  await host.runtime.idle()
  const ticketId = m.actions[0]!.ticket!.id, actor: LibraryActor = { role: 'worker', ticketId }
  return { mission: m, actor, ticketId, sessionId: `worker-${ticketId}` }
}

it('recovers content, provenance and exactly-once receipts after reopening SQLite', () => {
  const { store, library, path } = fixture(), request = input(), saved = library.publish(request)
  expect(saved).toMatchObject({ verification: 'not_verified', provenance: { trust: 'operator_submission' } })
  const reopened = new Store(path); disposers.push(() => reopened.close())
  const next = new Library(reopened)
  expect(next.publish(request)).toEqual(saved)
  expect(next.read(saved.id).content).toBe(request.content)
  expect(next.list({ q: 'provenance' }).items.map(item => item.id)).toEqual([saved.id])
  expect(() => next.publish({ ...request, content: 'changed' })).toThrow('already used')
  library.publish(input({ title: 'Another reference', content: request.content }))
  expect(store.db.prepare('SELECT count(*) AS n FROM workspace_blob').get()!.n).toBe(1)
})

it('rolls back blobs, metadata, search entries and receipts as one transaction', () => {
  const { store, library } = fixture(), request = input()
  expect(() => store.atomic(() => { library.publish(request); throw new Error('interrupt') })).toThrow('interrupt')
  expect(library.list().items).toEqual([])
  expect(store.db.prepare('SELECT count(*) AS n FROM workspace_blob').get()!.n).toBe(0)
  expect(store.db.prepare('SELECT count(*) AS n FROM workspace_library_search').get()!.n).toBe(0)
  expect(library.publish(request).title).toBe(request.title)
})

it('keeps immutable supersession and contradiction chains, including inactive history', () => {
  const { library } = fixture(), first = library.publish(input())
  const second = library.publish(input({ content: 'A revised finding.', sources: [{ id: first.id, relation: 'supersedes' }] }))
  const contradiction = library.publish(input({ content: 'Conflicting source.', sources: [{ id: second.id, relation: 'contradicts' }] }))
  expect(library.read(first.id)).toMatchObject({ superseded: true, content: input().content,
    incoming: [{ id: second.id, relation: 'supersedes', hash: second.hash }] })
  expect(library.read(second.id).conflicted).toBe(true)
  expect(library.read(contradiction.id).conflicted).toBe(true)
  expect(library.list().items.map(item => item.id)).toEqual([contradiction.id, second.id])
  expect(library.list({ includeInactive: 'true' }).items).toHaveLength(3)
  expect(second.sources).toEqual([{ id: first.id, relation: 'supersedes', hash: first.hash }])
  library.archive(second.id, { requestId: requestId(), revision: 1, archived: true })
  expect(library.read(first.id).superseded).toBe(false)
  expect(library.read(contradiction.id).staleSources).toEqual([second.id])
})

it('bounds text retrieval, list pages, query syntax and binary ingestion', () => {
  const { library } = fixture(), record = library.publish(input({ content: 'x'.repeat(9000) }))
  expect(library.read(record.id)).toMatchObject({ content: 'x'.repeat(4000), nextOffset: 4000, totalChars: 9000, contextOnly: true })
  expect(library.read(record.id, { offset: 8000 })).toMatchObject({ content: 'x'.repeat(1000), nextOffset: null })
  expect(() => library.read(record.id, { limit: 8001 })).toThrow()
  expect(() => library.list({ limit: 51 })).toThrow()
  expect(library.list({ q: '" OR * (NEAR)' }).items).toEqual([])
  library.publish(input()); expect(library.list({ limit: 1 }).nextOffset).toBe(1)
  expect(() => library.publish(input({ content: 'x'.repeat(65537) }))).toThrow('64 KiB')
  expect(() => library.publish(input({ kind: 'artifact', content: 'aGVsbG8', encoding: 'base64' }))).toThrow('canonical base64')
  expect(() => library.publish(input({ kind: 'artifact', content: '/w==', encoding: 'base64', mime: 'text/plain' }))).toThrow('UTF-8')
  expect(() => library.publish(input({ filename: '../secrets' }))).toThrow()
})

it('preserves binary bytes and refuses corrupted blobs', () => {
  const { library, store } = fixture(), bytes = Buffer.from([0, 1, 2, 255])
  const record = library.publish(input({ kind: 'artifact', content: bytes.toString('base64'), encoding: 'base64', mime: 'application/octet-stream', filename: 'result.bin' }))
  expect(library.read(record.id)).toMatchObject({ content: null, nextOffset: null, totalChars: null })
  expect(library.content(record.id)).toMatchObject({ data: bytes.toString('base64'), filename: 'result.bin' })
  store.db.prepare('UPDATE workspace_blob SET data=? WHERE hash=?').run(Buffer.from('corrupt'), record.hash)
  expect(() => library.content(record.id)).toThrow('integrity')
})

it('keeps expired records available by reference but removes them from active recall', () => {
  const { store } = fixture(); let time = '2026-11-08T12:00:00.000Z'
  const library = new Library(store, () => time)
  const record = library.publish(input({ expiresAt: '2026-11-09T12:00:00.000Z' }))
  time = '2026-11-10T12:00:00.000Z'
  expect(library.list().items).toEqual([])
  expect(library.read(record.id).expired).toBe(true)
  expect(library.list({ includeInactive: 'true' }).items).toHaveLength(1)
  expect(() => library.publish(input({ expiresAt: '2026-11-09T00:00:00.000Z' }))).toThrow('future')
})

it('archives and restores without changing content and rejects stale archive commands', () => {
  const { library } = fixture(), record = library.publish(input())
  const request = { requestId: requestId(), revision: 1, archived: true }
  const archived = library.archive(record.id, request)
  expect(library.archive(record.id, request)).toEqual(archived)
  expect(library.list().items).toEqual([])
  expect(library.content(record.id).hash).toBe(record.hash)
  expect(() => library.archive(record.id, { ...request, requestId: requestId() })).toThrow('changed')
  expect(library.archive(record.id, { requestId: requestId(), revision: 2, archived: false })).toMatchObject({ hash: record.hash, revision: 3 })
  expect(library.list().items).toHaveLength(1)
})

it('derives worker scope and provenance from the authorized mission and rejects forged ownership', async () => {
  const host = await hostFixture(), worker = await missionWorker(host)
  const record = await host.runTool(worker.sessionId, 'workspace_publish', input()) as unknown as LibraryEntry
  expect(record).toMatchObject({ scope: `mission:${worker.mission.id}`, provenance: { actor: 'worker', trust: 'agent_submission',
    ticketId: worker.ticketId, sessionId: worker.sessionId, assignmentId: expect.any(String), triggerId: expect.any(String), triggerHash: expect.any(String) } })
  await expect(host.runTool(worker.sessionId, 'workspace_publish', { ...input(), scope: 'workspace' })).rejects.toThrow()
  expect((await host.runTool(worker.sessionId, 'workspace_search', { q: 'provenance' })).items).toHaveLength(1)
  expect((await host.runTool(worker.sessionId, 'workspace_read', { id: record.id })).content).toBe(input().content)
})

it('denies private reads, search and provenance traversal across missions, including inverse edges', async () => {
  const host = await hostFixture(), first = await missionWorker(host), second = await missionWorker(host), library = host.runtime.library
  const shared = library.publish(input()), secret = library.publish(input({ sources: [{ id: shared.id, relation: 'references' }] }), first.actor)
  const own = library.publish(input(), second.actor)
  expect(library.list({}, second.actor).items.map(item => item.id)).toEqual([own.id, shared.id])
  expect(library.read(shared.id, {}, second.actor).incoming).toEqual([])
  expect(library.read(shared.id, {}, first.actor).incoming.map(edge => edge.id)).toEqual([secret.id])
  expect(() => library.read(secret.id, {}, second.actor)).toThrow('not found')
  expect(() => library.list({ scope: secret.scope }, second.actor)).toThrow('not found')
  expect(() => library.publish(input({ sources: [{ id: secret.id, relation: 'references' }] }), second.actor)).toThrow('not found')
  expect(() => library.publish({ ...input(), scope: 'workspace', sources: [{ id: secret.id, relation: 'derived_from' }] })).toThrow('private scope')
  expect(() => library.publish(input({ sources: [{ id: shared.id, relation: 'supersedes' }] }), first.actor)).toThrow('supersession')
  expect((await host.runTool(host.runtime.masterId, 'workspace_search', {})).items).toHaveLength(1)
})

it('reuses committed publication receipts after a ticket ends but denies new writes and disabled sources', async () => {
  const host = await hostFixture(), worker = await missionWorker(host), library = host.runtime.library, request = input()
  const record = library.publish(request, worker.actor)
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workspace: { enabled: false, config: {} } } })
  expect(() => library.publish(input(), worker.actor)).toThrow('authorizes')
  host.runtime.store.saveSettings(settings)
  host.runtime.engine.stopTicket(worker.ticketId, 'Finished')
  expect(library.publish(request, worker.actor).id).toBe(record.id)
  expect(() => library.publish(input(), worker.actor)).toThrow('active ticket')
})

it('invalidates mission acceptance when reviewed library evidence changes visibility', async () => {
  const host = await hostFixture(), worker = await missionWorker(host), workspace = host.runtime.workspace, library = host.runtime.library
  const record = library.publish(input({ kind: 'artifact' }), worker.actor)
  await host.runTool(worker.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Saved the artifact' })
  let mission = workspace.get(worker.mission.id), action = mission.actions[0]!
  const stale = { requestId: requestId(), revision: mission.revision, command: 'complete', ticketRevision: action.ticket!.revision, text: 'Reviewed artifact' }
  library.archive(record.id, { requestId: requestId(), revision: 1, archived: true })
  expect(() => workspace.act(mission.id, action.id, stale)).toThrow('latest completed')
  library.archive(record.id, { requestId: requestId(), revision: 2, archived: false })
  mission = workspace.get(mission.id); action = mission.actions[0]!
  mission = workspace.act(mission.id, action.id, { ...stale, requestId: requestId(), ticketRevision: action.ticket!.revision })
  mission = workspace.update(mission.id, { requestId: requestId(), revision: mission.revision, status: 'completed' })
  library.archive(record.id, { requestId: requestId(), revision: 3, archived: true })
  expect(workspace.get(mission.id)).toMatchObject({ completed: 0, needsReview: true })
})

it('invalidates reviewed results when another author revises or contradicts their evidence', async () => {
  const host = await hostFixture(), worker = await missionWorker(host), library = host.runtime.library
  const record = library.publish(input({ kind: 'artifact' }), worker.actor)
  const before = library.evidenceRevision(worker.ticketId)
  const revision = library.publish({ ...input({ kind: 'artifact', sources: [{ id: record.id, relation: 'supersedes' }] }), scope: record.scope })
  expect(library.evidenceRevision(worker.ticketId)).not.toBe(before)
  expect(library.read(record.id).superseded).toBe(true)
  const revised = library.evidenceRevision(worker.ticketId)
  library.archive(revision.id, { requestId: requestId(), revision: 1, archived: true })
  expect(library.evidenceRevision(worker.ticketId)).not.toBe(revised)
})

it('exposes validated library routes and bounded content through the actual management API', async () => {
  const host = await hostFixture(), request = input({ kind: 'artifact', mime: 'text/html', filename: 'brief.html', content: '<h1>Brief</h1>' })
  const response = await host.api('POST', 'library', request)
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  const record = response.body as unknown as LibraryEntry
  expect((await host.api('GET', 'library?q=Brief')).body).toMatchObject({ items: [{ id: record.id }] })
  expect((await host.api('GET', `library/${record.id}?limit=3`)).body).toMatchObject({ content: '<h1', nextOffset: 3 })
  expect((await host.api('GET', `library/${record.id}/content`)).body).toMatchObject({ data: Buffer.from(request.content).toString('base64') })
  expect((await host.api('POST', 'library', { ...input(), scope: 'mission:unknown' })).status).toBe(404)
  expect((await host.api('GET', 'library?limit=100')).status).toBe(400)
  expect((await host.api('POST', 'library', { ...input(), provenance: { actor: 'operator' } })).status).toBe(400)
})
