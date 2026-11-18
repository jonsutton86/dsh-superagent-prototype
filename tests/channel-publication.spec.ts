import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { channelPublicationFixture } from './fixtures/channel-publication.ts'
import { PublicationClient } from '../src/publication/client.ts'
import type { PublicationRpc } from '../src/publication/protocol.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

it('delivers worker acknowledgements and router results through the mission’s exact standing grant', async () => {
  const { host, publisher, mission, configure, run } = await channelPublicationFixture(cleanup), runtime = host.runtime
  expect((await host.api('PUT', `missions/${mission.id}/delivery`, configure)).status).toBe(200)
  const { ticket, sessionId, trigger } = await run()
  expect(trigger.source).toBe('workspace'); expect(trigger.channel?.source).toBe('publication')
  await expect(host.runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'Premature result' })).rejects.toThrow('not ready')
  expect(await host.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'I am preparing the result.' })).toMatchObject({ acknowledgement: 'sent' })
  await host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'The result is ready.' })
  expect(await host.runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'The result is ready.' })).toEqual({ status: 'sent' })
  const state = runtime.channelPublications.state(mission.id)
  expect(state.items).toHaveLength(2); expect(publisher.posts).toBe(2)
  for (const item of state.items) expect(item.receipt).toMatchObject({ phase: 'sent', message: { ticketId: ticket.id, missionId: mission.id, grantId: configure.requestId, planVersion: mission.planVersion } })
  expect(JSON.stringify(state)).not.toContain(publisher.secret)
  expect(JSON.stringify(state)).not.toContain('I am preparing')
  expect(publisher.comments.map(item => item.body.split('\n')[0])).toEqual(['I am preparing the result.', 'The result is ready.'])
}, 15_000)

it('preserves one intent after a lost service response and stops new sends when the grant is revoked', async () => {
  const { host, publisher, mission, configure, run } = await channelPublicationFixture(cleanup), runtime = host.runtime
  await runtime.channelPublications.configure(mission.id, configure)
  const { sessionId, trigger } = await run(), call = PublicationClient.prototype.call
  let drop = true
  vi.spyOn(PublicationClient.prototype, 'call').mockImplementation(async function<T>(this: PublicationClient, request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const value = await call.call(this, request, signal)
    if (drop && request.op === 'publish') { drop = false; throw new Error('Lost service reply') }
    return value as T
  })
  expect(await host.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'Starting.' })).toMatchObject({ acknowledgement: 'pending' })
  const item = runtime.channelPublications.state(mission.id).items[0]!
  expect(item.phase).toBe('unknown'); expect(publisher.posts).toBe(1)
  await runtime.channelPublications.configure(mission.id, { requestId: randomUUID(), revision: 1, missionRevision: mission.revision, enabled: false })
  expect((await host.api('POST', `deliveries/${item.id}/retry`)).status).toBe(409)
  expect((await host.api('POST', `deliveries/${item.id}/refresh`)).body).toMatchObject({ receipt: { phase: 'sent' } })
  expect(runtime.outbox.status(item.messageId)).toBe('sent'); expect(publisher.posts).toBe(1)
}, 15_000)

it('retains a withdrawn unknown send and only permits read-only receipt recovery', async () => {
  const { host, publisher, mission, configure, run } = await channelPublicationFixture(cleanup), runtime = host.runtime
  await runtime.channelPublications.configure(mission.id, configure)
  const { sessionId, trigger } = await run()
  publisher.loseProviderReply()
  await host.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'Starting.' })
  const item = runtime.channelPublications.state(mission.id).items[0]!
  runtime.outbox.withdraw(item.messageId)
  expect(runtime.outbox.status(item.messageId)).toBe('pending')
  expect((await host.api('POST', `deliveries/${item.id}/retry`)).status).toBe(409)
  expect((await host.api('POST', `deliveries/${item.id}/refresh`)).body).toMatchObject({ withdrawn: true, receipt: { phase: 'sent' } })
  expect(runtime.outbox.status(item.messageId)).toBe('sent'); expect(publisher.posts).toBe(1)
}, 15_000)

it('keeps observation available after ownership loss while refusing another dispatch', async () => {
  const { host, publisher, authority, mission, configure, run } = await channelPublicationFixture(cleanup), runtime = host.runtime
  await runtime.channelPublications.configure(mission.id, configure)
  const { sessionId, trigger } = await run()
  publisher.loseProviderReply(); await host.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'Starting.' })
  const item = runtime.channelPublications.state(mission.id).items[0]!
  authority.restart()
  await vi.waitFor(() => expect(runtime.lifetime.aborted).toBe(true), { timeout: 5000 })
  expect((await host.api('POST', `deliveries/${item.id}/refresh`)).body).toMatchObject({ receipt: { phase: 'sent' } })
  expect((await host.api('POST', `deliveries/${item.id}/retry`)).status).toBe(409)
  expect(publisher.posts).toBe(1)
}, 10_000)

it('replays exact grant requests, refuses stale/substituted grants and invalidates consent when the plan changes', async () => {
  const { host, publisher, mission, configure, run } = await channelPublicationFixture(cleanup), runtime = host.runtime
  expect((await host.api('PUT', `missions/${mission.id}/delivery`, { ...configure, destinationHash: '0'.repeat(64) })).status).toBe(409)
  const responses = await Promise.all([runtime.channelPublications.configure(mission.id, configure), runtime.channelPublications.configure(mission.id, configure)])
  expect(responses.map(value => value.grant?.id)).toEqual([configure.requestId, configure.requestId])
  expect((await host.api('PUT', `missions/${mission.id}/delivery`, { ...configure, enabled: false })).status).toBe(409)
  expect((await host.api('PUT', `missions/${mission.id}/delivery`, { ...configure, requestId: randomUUID() })).status).toBe(409)
  const { ticket, trigger } = await run()
  expect((await host.api('PUT', `missions/${mission.id}/delivery`, { ...configure, requestId: randomUUID(), revision: 1, missionRevision: runtime.workspace.get(mission.id).revision })).status).toBe(409)
  await expect(runtime.channelPublications.send({ id: 'forged', channel: trigger.channel!, ticketId: 'unrelated-ticket', kind: 'reply', text: 'Must refuse' })).rejects.toThrow('authority')
  runtime.workspace.add(mission.id, { requestId: randomUUID(), revision: runtime.workspace.get(mission.id).revision, title: 'Changed plan', instructions: 'A new step', owner: 'person' })
  expect(runtime.channelPublications.state(mission.id).current).toBe(false)
  await expect(runtime.channelPublications.send({ id: 'stale', channel: trigger.channel!, ticketId: ticket.id, kind: 'reply', text: 'Must refuse' })).rejects.toThrow('authority')
  expect(publisher.posts).toBe(0)
}, 15_000)

it('holds later replies behind an unresolved send even after repeated failures and withdrawal', async () => {
  const { host, publisher, mission, configure, run } = await channelPublicationFixture(cleanup), runtime = host.runtime
  await runtime.channelPublications.configure(mission.id, configure)
  const { sessionId, trigger, ticket } = await run()
  publisher.loseProviderReply(); await host.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'Starting.' })
  const item = runtime.channelPublications.state(mission.id).items[0]!
  runtime.store.db.prepare("UPDATE effect SET attempts=10 WHERE kind='reply' AND key=?").run(item.messageId)
  runtime.outbox.send({ id: 'later-result', ticketId: ticket.id, channel: trigger.channel!, kind: 'reply', text: 'Later result' })
  await runtime.sendReplies()
  expect(runtime.outbox.status('later-result')).toBe('pending'); expect(publisher.posts).toBe(1)
  runtime.outbox.withdraw(item.messageId)
  runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='reply' AND key='later-result'").run()
  await runtime.sendReplies()
  expect(runtime.outbox.status('later-result')).toBe('pending'); expect(publisher.posts).toBe(1)
  await runtime.channelPublications.refresh(item.id)
  runtime.store.db.prepare("UPDATE effect SET due=0 WHERE kind='reply' AND key='later-result'").run()
  await runtime.sendReplies()
  expect(runtime.outbox.status('later-result')).toBe('sent'); expect(publisher.posts).toBe(2)
}, 15_000)

it.each(['source-pause', 'human-stop'] as const)('refuses new delivery after %s', async change => {
  const { host, publisher, mission, configure, run } = await channelPublicationFixture(cleanup), runtime = host.runtime
  await runtime.channelPublications.configure(mission.id, configure)
  const { trigger, ticket } = await run()
  if (change === 'source-pause') runtime.store.saveSettings({ ...runtime.store.settings(), sources: { workspace: { enabled: false, config: {} } } })
  else runtime.workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: runtime.workspace.get(mission.id).revision, command: 'stop' })
  await expect(runtime.channelPublications.send({ id: 'revoked', channel: trigger.channel!, ticketId: ticket.id, kind: 'reply', text: 'Must not arrive' })).rejects.toThrow('authority')
  expect(publisher.posts).toBe(0)
}, 15_000)
