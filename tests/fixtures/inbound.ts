import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { channelPublicationFixture } from './channel-publication.ts'
import { ConversationInbox } from '../../src/publication/inbound.ts'

/** Real owned Runtime/listener and local provider service with polling explicitly controlled by the test. */
export async function inboundFixture(cleanup: (() => Promise<unknown>)[], kind: 'github-comment' | 'github-review' | 'feishu-reply' = 'github-comment') {
  vi.spyOn(ConversationInbox.prototype, 'start').mockImplementation(() => {})
  const context = await channelPublicationFixture(cleanup, kind), { host, mission, configure, run } = context, runtime = host.runtime
  await runtime.channelPublications.configure(mission.id, configure)
  const task = await run(), sender = kind === 'feishu-reply' ? 'ou_alice' : 'alice'
  const request = { requestId: randomUUID(), revision: 0, enabled: true, grantId: configure.requestId, ticketId: task.ticket.id, senders: [sender] }
  const state = runtime.conversations.configure(mission.id, request)
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(state.binding!.startsAt)), { interval: 25, timeout: 1500 })
  return { ...context, ...task, runtime, sender, request, poll: (rescan = false) => runtime.conversations.poll(mission.id, rescan) }
}
