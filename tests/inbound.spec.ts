import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { channelPublicationFixture } from './fixtures/channel-publication.ts'
import { ConversationInbox } from '../src/publication/inbound.ts'
import { inboundFixture } from './fixtures/inbound.ts'
import { threadKey } from '../src/core/index.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

async function fixture(kind: 'github-comment' | 'github-review' | 'feishu-reply' = 'github-comment') {
  return inboundFixture(cleanup, kind)
}

it.each(['github-comment', 'github-review', 'feishu-reply'] as const)('receives verified %s replies once, and answers through the original task grant', async kind => {
  const { host, publisher, mission, runtime, ticket, sessionId, sender, poll, request } = await fixture(kind)
  publisher.receive(sender, 'Please check the second requirement.')
  publisher.receive('outsider', 'Unauthorized instruction')
  publisher.receive(sender, 'A bot pretending to be the participant', undefined, false)
  publisher.receive(sender, 'Before authorization', '2025-01-01T00:00:00.000Z')
  let state = await poll(); expect(state.binding).toMatchObject({ received: 1, unsupported: 0 }); expect(state.binding?.problem).toBeUndefined()
  const item = state.items[0]!, incoming = runtime.store.triggers.get(item.triggerId!)!
  expect(incoming).toMatchObject({ source: 'conversation', actor: { id: sender }, text: 'Please check the second requirement.' })
  expect(runtime.store.triggers.disposition(incoming.id)).toMatchObject({ recipient: ticket.id, fanout: [ticket.id] })
  expect(JSON.stringify(await host.runTool(sessionId, 'orchestrator_read', { resource: `trigger/${incoming.id}` }))).toContain(incoming.text)
  expect(await host.runTool(sessionId, 'orchestrator_ack', { trigger_id: incoming.id, text: 'I will check it.' })).toMatchObject({ acknowledgement: 'sent' })
  expect(publisher.posts).toBe(1)
  expect(runtime.channelPublications.state(mission.id).items[0]?.receipt?.phase).toBe('sent')
  state = await poll(true); expect(state.binding?.received).toBe(1); expect(state.items).toHaveLength(1)
  // Replacing a listener never replays a native message, even if it is edited after the original delivery.
  runtime.conversations.configure(mission.id, { ...request, requestId: randomUUID(), revision: 1 })
  const replacement = runtime.conversations.state(mission.id).binding!
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(replacement.startsAt)), { timeout: 1500, interval: 25 })
  if (kind === 'feishu-reply') publisher.messages[0]!.create_time = String(Date.now())
  else { publisher.comments[0]!.body = 'Edited instruction'; publisher.comments[0]!.created_at = new Date().toISOString() }
  expect((await poll(true)).items).toHaveLength(1)
  expect(runtime.store.triggers.get(incoming.id)?.text).toBe('Please check the second requirement.')
}, 15_000)

it('preserves authorization intent on replay, rejects substituted and stale configurations, and pages through a backlog', async () => {
  const { host, mission, runtime, publisher, sender, poll, request } = await fixture()
  expect(runtime.conversations.configure(mission.id, request).binding?.revision).toBe(1)
  expect((await host.api('PUT', `missions/${mission.id}/inbound`, { ...request, senders: ['mallory'] })).status).toBe(409)
  expect((await host.api('PUT', `missions/${mission.id}/inbound`, { ...request, requestId: randomUUID() })).status).toBe(409)
  for (let i = 0; i < 47; i++) publisher.receive(sender, `Reply ${i}`)
  expect((await poll()).items).toHaveLength(40)
  publisher.loseServiceReply()
  expect((await poll()).binding?.problem).toBeTruthy()
  expect((await poll()).items).toHaveLength(47)
  expect((await poll(true)).items).toHaveLength(47)
  expect(runtime.store.tickets.list()).toHaveLength(1)
}, 15_000)

it('reserves a paused listener’s destination so a second mission cannot take over its conversation', async () => {
  const { runtime, mission, configure } = await fixture()
  runtime.store.saveSettings({ ...runtime.store.settings(), sources: { conversation: { enabled: false, config: {} } } })
  let other = runtime.workspace.create({ requestId: randomUUID(), title: 'Other mission', objective: 'Independent work', acceptance: 'Done' })
  other = runtime.workspace.add(other.id, { requestId: randomUUID(), revision: other.revision, title: 'Other task', instructions: 'Independent work', owner: 'agent', environment: runtime.workspace.get(mission.id).actions[0]!.environment })
  const grant = await runtime.channelPublications.configure(other.id, { ...configure, requestId: randomUUID(), missionRevision: other.revision })
  other = runtime.workspace.act(other.id, other.actions[0]!.id, { requestId: randomUUID(), revision: other.revision, command: 'run' })
  await runtime.idle()
  const request = { requestId: randomUUID(), revision: 0, enabled: true, grantId: grant.grant!.id, ticketId: other.actions[0]!.runs[0]!, senders: ['alice'] }
  expect(() => runtime.conversations.configure(other.id, request)).toThrow('already steers another mission')
  runtime.conversations.configure(mission.id, { requestId: randomUUID(), revision: 1, enabled: false })
  expect(runtime.conversations.configure(other.id, request).binding?.ticketId).toBe(request.ticketId)
}, 15_000)

it.each(['github-comment', 'github-review', 'feishu-reply'] as const)('rejects wrong destinations and visibly holds oversized %s content without truncating it into work', async kind => {
  const { publisher, runtime, sender, poll } = await fixture(kind)
  publisher.receive(sender, 'x'.repeat(16_001))
  publisher.receive(sender, 'Wrong conversation')
  if (kind === 'feishu-reply') publisher.messages[1]!.root_id = publisher.messages[1]!.parent_id = 'om_elsewhere'
  else if (kind === 'github-review') publisher.comments[1]!.in_reply_to_id = 99
  else publisher.comments[1]!.issue_url = 'https://api.github.com/repos/acme/project/issues/99'
  const state = await poll()
  expect(state.items).toHaveLength(1); expect(state.items[0]).toMatchObject({ status: 'unsupported', problem: 'content_too_large' })
  expect(state.items[0]?.triggerId).toBeUndefined(); expect(state.binding?.received).toBe(0)
  expect(runtime.store.tickets.list()[0]?.inputs.filter(input => input.kind === 'trigger')).toHaveLength(0)
}, 15_000)

it.each(['listener', 'delivery', 'source', 'stop', 'plan', 'ownership'] as const)('does not admit an in-flight read after %s revocation', async change => {
  const { host, publisher, authority, runtime, mission, sender, poll, request } = await fixture()
  publisher.receive(sender, 'This must not reach the worker')
  const held = Promise.withResolvers<void>(); publisher.holdRead(held.promise)
  const before = publisher.reads, reading = poll()
  await vi.waitFor(() => expect(publisher.reads).toBeGreaterThan(before))
  if (change === 'listener') runtime.conversations.configure(mission.id, { requestId: randomUUID(), revision: 1, enabled: false })
  if (change === 'delivery') await runtime.channelPublications.configure(mission.id, { requestId: randomUUID(), revision: 1, missionRevision: mission.revision, enabled: false })
  if (change === 'source') runtime.store.saveSettings({ ...runtime.store.settings(), sources: { conversation: { enabled: false, config: {} } } })
  if (change === 'stop') runtime.workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: runtime.workspace.get(mission.id).revision, command: 'stop' })
  if (change === 'plan') runtime.workspace.add(mission.id, { requestId: randomUUID(), revision: runtime.workspace.get(mission.id).revision, title: 'New plan', instructions: 'New step', owner: 'person' })
  if (change === 'ownership') { authority.restart(); await vi.waitFor(() => expect(runtime.lifetime.aborted).toBe(true), { timeout: 5000 }) }
  held.resolve(); await reading
  expect(runtime.conversations.state(mission.id).items).toHaveLength(0)
  expect(runtime.conversations.state(mission.id).active).toBe(false)
  if (change === 'listener') expect(runtime.conversations.configure(mission.id, request).binding?.enabled).toBe(false)
  expect((await host.api('GET', `missions/${mission.id}/inbound`)).status).toBe(200)
}, 15_000)

it('keeps a directed reply private to its selected task even when another task subscribes to the same thread', async () => {
  const { runtime, publisher, sender, poll, ticket, trigger, host, sessionId, mission } = await fixture()
  let other = runtime.workspace.create({ requestId: randomUUID(), title: 'Other mission', objective: 'Independent work', acceptance: 'Done' })
  other = runtime.workspace.add(other.id, { requestId: randomUUID(), revision: other.revision, title: 'Other task', instructions: 'Independent work', owner: 'agent', environment: runtime.workspace.get(mission.id).actions[0]!.environment })
  other = runtime.workspace.act(other.id, other.actions[0]!.id, { requestId: randomUUID(), revision: other.revision, command: 'run' })
  await runtime.idle()
  const otherId = other.actions[0]!.runs[0]!, thread = runtime.store.threads.get(threadKey(trigger.threads[0]!))!
  thread.subscriptions.push(otherId); runtime.store.threads.save(thread)
  publisher.receive(sender, 'Private directed instruction')
  const incoming = (await poll()).items[0]!.triggerId!
  expect(runtime.store.tickets.get(otherId)!.inputs.some(input => input.kind === 'trigger' && input.triggerId === incoming)).toBe(false)
  expect(() => runtime.engine.attach(otherId, incoming)).toThrow()
  const { workerSessionId } = await import('../src/executor/dsh.ts')
  await expect(host.runTool(workerSessionId(otherId), 'orchestrator_read', { resource: `trigger/${incoming}` })).rejects.toThrow()
  expect(JSON.stringify(await host.runTool(workerSessionId(otherId), 'orchestrator_read', { resource: `thread/${thread.key}` }))).not.toContain('Private directed instruction')
  await expect(host.runTool(workerSessionId(otherId), 'orchestrator_ack', { trigger_id: incoming, text: 'Cross-task ack' })).rejects.toThrow()
  expect(() => runtime.engine.decide(incoming, { kind: 'stop', ticketId: otherId, reason: 'Wrong target' })).toThrow()
  runtime.engine.handback(ticket.id, incoming, 'Outside this task')
  expect(() => runtime.engine.decide(incoming, { kind: 'accept', title: 'Forbidden new task', scope: 'Other work', reason: 'Create other work' })).toThrow()
  expect(runtime.store.tickets.list()).toHaveLength(2)
  expect(runtime.store.triggers.disposition(incoming)?.recipient).toBe(ticket.id)
}, 15_000)
