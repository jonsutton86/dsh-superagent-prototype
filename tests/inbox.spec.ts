import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Store } from '../src/app/store.ts'
import { Inbox } from '../src/workspace/inbox.ts'
import { Library } from '../src/workspace/library.ts'
import { Workspace } from '../src/workspace/service.ts'
import type { Conversation, InboxItem } from '../src/workspace/inbox-model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { hostVerification } from './fixtures/host-verification.ts'

let host: Host | undefined
const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => { await host?.stop(); host = undefined; for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
async function fixture() { host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true }); return host }
const start = { requestId: 'new-task', text: 'Create a useful briefing', title: 'Briefing' }
function event(seq: number, text: string, overrides = {}): SessionEvent {
  return { type: 'assistant/message', seq, time: Date.UTC(2026, 10, 8, 12, 0, seq), surfaceOp: 'append', data: { turn: 1, step: seq,
    message: { id: `message-${seq}`, role: 'assistant', content: [{ type: 'text', text }, { type: 'reasoning', text: 'Hidden reasoning' }] }, stream: [] },
    ...overrides } as unknown as SessionEvent
}

it('atomically starts one mission and ticket, replays after reopening SQLite, and refuses changed request IDs', async () => {
  const h = await fixture(), first = h.runtime.inbox.start(start)
  await h.runtime.idle()
  expect(first).toMatchObject({ title: 'Briefing', source: 'workspace', unread: true, canReply: true, status: 'working' })
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(h.runtime.workspace.list().items).toHaveLength(1)
  const store = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const workspace = new Workspace(store, () => { throw new Error('Must not dispatch again') }, () => false)
    const restored = new Inbox(store, workspace, new Library(store), async () => [])
    expect(restored.start(start).id).toBe(first.id)
    expect(() => restored.start({ ...start, text: 'Different' })).toThrow('already used')
  } finally { store.close() }
})

it('rolls back the mission, action and receipts when execution is paused or the source is disabled', async () => {
  const h = await fixture(), store = h.runtime.store, settings = store.settings()
  store.saveSettings({ ...settings, paused: true })
  expect(() => h.runtime.inbox.start(start)).toThrow('resume')
  expect(h.runtime.workspace.list().items).toEqual([])
  expect(store.tickets.list()).toEqual([])
  expect(store.db.prepare('SELECT * FROM workspace_inbox_command').all()).toEqual([])
  store.saveSettings({ ...settings, sources: { ...settings.sources, workspace: { enabled: false, config: {} } } })
  expect(() => h.runtime.inbox.start(start)).toThrow()
  expect(h.runtime.workspace.list().items).toEqual([])
  store.saveSettings(settings)
  expect(h.runtime.inbox.start(start).id).toBeTruthy()
})

it('persists exact read revisions without clearing a newer question or treating reading as answering', async () => {
  const h = await fixture(), inbox = h.runtime.inbox, first = inbox.start(start)
  await h.runtime.idle()
  const before = inbox.item(first.id)
  expect(inbox.read(first.id, { revision: before.revision })).toEqual({ marked: true, unread: false })
  await h.runTool(first.sessionId!, 'orchestrator_report', { state: 'blocked', summary: 'Need a format', human_action: 'Which format?' })
  expect(inbox.list({ filter: 'questions' }).items).toHaveLength(1)
  expect(inbox.read(first.id, { revision: before.revision })).toEqual({ marked: false, unread: true })
  const asked = inbox.item(first.id)
  expect(inbox.read(first.id, { revision: asked.revision }).marked).toBe(true)
  expect(inbox.read(first.id, { revision: before.revision })).toEqual({ marked: false, unread: false })
  expect(inbox.list({ filter: 'unread' }).items).toEqual([])
  expect(inbox.list({ filter: 'questions' }).items[0]?.question).toBe('Which format?')
  const store = new Store(join(h.directory, 'orchestrator.sqlite'))
  try {
    const restored = new Inbox(store, new Workspace(store, () => h.runtime.engine, () => true), new Library(store), async () => [])
    expect(restored.item(first.id).unread).toBe(false)
  } finally { store.close() }
})

it('steers once through Engine authorization and refuses stale, disabled and stopped conversations', async () => {
  const h = await fixture(), inbox = h.runtime.inbox, first = inbox.start(start)
  await h.runtime.idle()
  const body = { requestId: 'answer', revision: inbox.item(first.id).revision, text: 'Use Markdown' }
  expect((await h.api('POST', `inbox/${first.id}/reply`, body)).status).toBe(200)
  expect((await h.api('POST', `inbox/${first.id}/reply`, body)).status).toBe(200)
  expect(h.runtime.store.db.prepare("SELECT count(*) AS count FROM trigger WHERE value ->> '$.text' = ?").get(body.text)?.count).toBe(1)
  expect(inbox.reply(first.id, body).id).toBe(first.id)
  expect(() => inbox.reply(first.id, { ...body, requestId: 'stale' })).toThrow('changed')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, workspace: { enabled: false, config: {} } } })
  expect(() => inbox.reply(first.id, { ...body, requestId: 'disabled', revision: inbox.item(first.id).revision })).toThrow('cannot receive')
  h.runtime.store.saveSettings(settings)
  h.runtime.engine.stopTicket(first.id, 'Operator stopped')
  expect(() => inbox.reply(first.id, { ...body, requestId: 'stopped', revision: inbox.item(first.id).revision })).toThrow('cannot receive')
  expect(inbox.start(start).status).toBe('stopped')
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})

it('projects visible Harness text once, excludes reasoning/tools/replacements and pages without duplicating new messages', async () => {
  const h = await fixture(), inbox = h.runtime.inbox, first = inbox.start(start)
  await h.runtime.idle()
  const events = Array.from({ length: 65 }, (_, i) => event(i + 1, `Message ${i + 1}`))
  h.controller.inspect.mockResolvedValue({ events } as never)
  const initial = await inbox.conversation(first.id, { limit: 10 })
  // A live notification and a later history read of the same event must not duplicate it.
  h.ctx.emit('session/event', { id: first.sessionId } as never, events[0]!)
  inbox.record(first.id, event(66, 'Replacement summary', { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }))
  inbox.record('not-our-ticket', event(67, 'Unrelated Session'))
  const ids = new Set(initial.messages.map(message => message.id))
  let cursor = initial.nextBefore
  while (cursor) {
    const page = await inbox.conversation(first.id, { before: cursor, limit: 10 })
    for (const message of page.messages) { expect(ids.has(message.id)).toBe(false); ids.add(message.id) }
    cursor = page.nextBefore
  }
  expect([...ids].filter(id => id.startsWith('session:'))).toHaveLength(65)
  const body = JSON.stringify(await inbox.conversation(first.id, { limit: 50 }))
  expect(body).not.toContain('Hidden reasoning'); expect(body).not.toContain('Replacement summary')
  inbox.record(first.id, event(70, '<script>never render raw HTML</script>'.repeat(1000)))
  const latest = await inbox.conversation(first.id)
  const long = latest.messages.find(message => message.truncated)!
  expect(long.text.length).toBe(8000); expect(long.truncated).toBe(true)
  const read = inbox.item(first.id)
  inbox.read(first.id, { revision: read.revision })
  // A recreated Harness Session can restart its sequence while retaining the ticket identity.
  const recreated = event(1, 'New session message', { time: Date.UTC(2026, 10, 8, 12, 2, 0) })
  if (recreated.type === 'assistant/message') recreated.data.message = { ...recreated.data.message, id: 'recreated-message' as never }
  inbox.record(first.id, recreated)
  expect(inbox.item(first.id).unread).toBe(true)
  expect((await inbox.conversation(first.id)).messages.some(message => message.text === 'New session message')).toBe(true)
  expect(h.controller.inspect).toHaveBeenCalledTimes(1)
  const restored = new Inbox(h.runtime.store, h.runtime.workspace, h.runtime.library, async () => { throw new Error('Offline') })
  const offline = await restored.conversation(first.id)
  expect(offline.historyAvailable).toBe(false)
  expect(offline.messages.some(message => message.truncated)).toBe(true)
  expect((await h.api('GET', `inbox/${first.id}?before=invalid`)).status).toBe(400)
})

it('shows actual mission review state and artifacts, then clears review only after explicit acceptance', async () => {
  const h = await fixture(), response = await h.api('POST', 'inbox', start), item = response.body as unknown as InboxItem
  expect(response.status).toBe(200)
  await h.runtime.idle()
  const beforePublication = h.runtime.inbox.item(item.id)
  h.runtime.inbox.read(item.id, { revision: beforePublication.revision })
  const check = await hostVerification(h, item.id, cleanup)
  const artifact = await h.runTool(item.sessionId!, 'workspace_publish', { requestId: 'result', kind: 'artifact', title: 'Brief', summary: 'Briefing', content: 'The evidence.' })
  const selection = await check((artifact as { id: string }).id, 'The evidence.')
  expect(h.runtime.inbox.read(item.id, { revision: beforePublication.revision })).toEqual({ marked: false, unread: true })
  await h.runTool(item.sessionId!, 'orchestrator_report', { state: 'ready', summary: 'Brief ready' })
  expect(h.runtime.inbox.list({ filter: 'review' }).items[0]?.id).toBe(item.id)
  const page = (await h.api('GET', `inbox/${item.id}`)).body as unknown as Conversation
  expect(page.artifacts).toContainEqual({ id: (artifact as { id: string }).id, title: 'Brief', kind: 'artifact' })
  expect(page.item.canReply).toBe(true)
  const mission = h.runtime.workspace.get(item.mission!.id), action = mission.actions[0]!
  await h.runtime.workspace.actReviewed(mission.id, action.id, { requestId: 'accept', revision: mission.revision, command: 'complete',
    ticketRevision: action.ticket!.revision, text: 'Read the evidence and accepted it', reviewKind: 'checks', checks: [selection] })
  expect(h.runtime.inbox.list({ filter: 'review' }).items).toEqual([])
  expect(h.runtime.inbox.item(item.id).status).toBe('done')
  expect((await h.api('GET', 'inbox?limit=999')).status).toBe(400)
  expect((await h.api('GET', 'inbox/unknown')).status).toBe(404)
  expect((await h.api('POST', 'inbox', { ...start, actor: 'admin' })).status).toBe(400)
})

it('resumes a reviewed result only for an explicit follow-up and blocks acceptance or archival while that message waits', async () => {
  const h = await fixture(), inbox = h.runtime.inbox, item = inbox.start(start)
  await h.runtime.idle()
  await h.runTool(item.sessionId!, 'orchestrator_report', { state: 'ready', summary: 'First brief' })
  const ready = inbox.item(item.id), mission = h.runtime.workspace.get(item.mission!.id)
  await h.api('POST', 'executor/pause', { paused: true })
  inbox.reply(item.id, { requestId: 'revise', revision: ready.revision, text: 'Please add a concise conclusion to this brief.' })
  const pending = h.runtime.workspace.get(mission.id)
  expect(pending.actions[0]!.status).toBe('working')
  expect(pending.actions[0]!.ticket?.stoppable).toBe(true)
  expect(() => h.runtime.workspace.act(mission.id, pending.actions[0]!.id, { requestId: 'duplicate-run', revision: pending.revision,
    command: 'run' })).toThrow('Configure execution')
  expect(() => h.runtime.workspace.act(mission.id, pending.actions[0]!.id, { requestId: 'premature', revision: pending.revision,
    command: 'complete', text: 'Accept old result', ticketRevision: pending.actions[0]!.ticket!.revision })).toThrow('latest completed')
  expect(() => h.runtime.workspace.update(mission.id, { requestId: 'archive', revision: pending.revision, status: 'archived' })).toThrow('Stop or finish')
  await h.api('POST', 'executor/pause', { paused: false })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(item.id)?.ended).toBeUndefined()
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})

it('cancels a paused follow-up without launching or rerouting it after processing resumes', async () => {
  const h = await fixture(), inbox = h.runtime.inbox, item = inbox.start(start)
  await h.runtime.idle()
  await h.runTool(item.sessionId!, 'orchestrator_report', { state: 'ready', summary: 'First brief' })
  await h.api('POST', 'executor/pause', { paused: true })
  inbox.reply(item.id, { requestId: 'cancelled-revision', revision: inbox.item(item.id).revision, text: 'Please revise the brief.' })
  const pending = h.runtime.workspace.get(item.mission!.id), action = pending.actions[0]!
  expect((await h.api('GET', `tickets/${item.id}`)).body).toMatchObject({ actions: { stop: true } })
  const stopped = h.runtime.workspace.act(pending.id, action.id, { requestId: 'cancel-revision', revision: pending.revision, command: 'stop' })
  expect(stopped.actions[0]).toMatchObject({ status: 'stopped', ticket: { stoppable: false } })
  expect(inbox.item(item.id)).toMatchObject({ status: 'stopped', canReply: false })
  await h.api('POST', 'executor/pause', { paused: false })
  await h.runtime.idle()
  h.runtime.engine.evaluateDue()
  await h.runtime.idle()
  const ticket = h.runtime.store.tickets.get(item.id)!
  expect(ticket.ended).toMatchObject({ by: 'human', outcome: 'stopped' })
  expect(ticket.undelivered).toEqual([])
  expect(ticket.assignments).toHaveLength(1)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(h.runtime.store.threads.active().some(thread => thread.pending.length || thread.evaluating)).toBe(false)
  expect(h.runtime.workspace.update(pending.id, { requestId: 'archive-stopped', revision: stopped.revision, status: 'archived' }).status).toBe('archived')
})
