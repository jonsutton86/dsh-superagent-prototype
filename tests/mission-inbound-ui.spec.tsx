// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MissionInboundCard } from '../src/client/mission-inbound.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { channelPublicationFixture } from './fixtures/channel-publication.ts'
import { ConversationInbox, type ConfigureInbound } from '../src/publication/inbound.ts'

const cleanup: (() => Promise<unknown>)[] = []
let root: Root | undefined, container: HTMLDivElement | undefined, pendingRequests = 0
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove(); root = undefined; container = undefined
  vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks()
})
const button = (text: string) => [...container!.querySelectorAll('button')].find(value => value.textContent === text)!
const settle = async () => { await vi.waitFor(() => expect(pendingRequests).toBe(0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); await act(async () => { button(text).click(); await settle() }) }
async function fixture(losePanelReply = false) {
  vi.spyOn(ConversationInbox.prototype, 'start').mockImplementation(() => {})
  const context = await channelPublicationFixture(cleanup), { host, mission, configure, run } = context
  await host.runtime.channelPublications.configure(mission.id, configure)
  const task = await run(), nativeFetch = globalThis.fetch, requests: ConfigureInbound[] = []; let lost = false
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('/orchestrator/api/')) return nativeFetch(input, init)
    pendingRequests++
    try {
      const path = String(input).slice('/orchestrator/api/'.length), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (method === 'PUT') requests.push(body)
      const response = await host.api(method, path, body)
      if (losePanelReply && method === 'PUT' && !lost) { lost = true; throw new Error('Listener acknowledgement lost') }
      if (losePanelReply && method === 'GET' && path.endsWith('/inbound') && requests.length < 2)
        return new Response(JSON.stringify({ configured: true, active: false, items: [] }), { status: 200 })
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } })
    } finally { pendingRequests-- }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}>
    <MissionInboundCard mission={host.runtime.workspace.get(mission.id)} delivery={host.runtime.channelPublications.state(mission.id)} />
  </PanelProvider>)); await act(settle)
  const select = container.querySelector('select')!, textarea = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, task.ticket.id); select.dispatchEvent(new Event('change', { bubbles: true }))
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'alice'); textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(button(en['inbound.enable']).disabled).toBe(true)
  await act(async () => container!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  expect(button(en['inbound.enable']).disabled).toBe(false)
  return { ...context, ...task, requests }
}

it('retries the original participant authorization after a lost save response and stale poll', async () => {
  const { host, mission, requests } = await fixture(true)
  await click(en['inbound.enable']); expect(container!.querySelector('[role=alert]')).toBeTruthy()
  await click(en['inbound.enable'])
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0])
  expect(host.runtime.conversations.state(mission.id).binding?.revision).toBe(1)
  expect(container!.textContent).toContain(en['inbound.active']); expect(button(en['inbound.enable']).disabled).toBe(true)
}, 15_000)

it('shows actual incoming and unsupported messages, then stops new input', async () => {
  const { host, publisher, mission, ticket } = await fixture()
  await click(en['inbound.enable'])
  const startsAt = host.runtime.conversations.state(mission.id).binding!.startsAt
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(startsAt)), { interval: 25, timeout: 1500 })
  publisher.receive('alice', 'Please review the result again.'); publisher.receive('alice', 'x'.repeat(16_001))
  await click(en['inbound.poll'])
  expect(container!.textContent).toContain(en['inbound.received']); expect(container!.textContent).toContain(en['inbound.unsupported'])
  expect(JSON.stringify((await host.api('GET', `inbox/${ticket.id}`)).body)).toContain('Please review the result again.')
  await click(en['inbound.rescan']); expect(host.runtime.conversations.state(mission.id).items).toHaveLength(2)
  await click(en['inbound.disable']); expect(container!.textContent).toContain(en['inbound.off'])
  publisher.receive('alice', 'After listener stopped')
  expect((await host.runtime.conversations.poll(mission.id)).items).toHaveLength(2)
}, 15_000)

it('requires renewed participant consent after a definitive revision conflict', async () => {
  const { host, mission, ticket, configure, requests } = await fixture()
  host.runtime.conversations.configure(mission.id, { requestId: crypto.randomUUID(), revision: 0, enabled: true, grantId: configure.requestId, ticketId: ticket.id, senders: ['alice'] })
  await click(en['inbound.enable'])
  expect(container!.querySelector('[role=alert]')).toBeTruthy(); expect(button(en['inbound.enable']).disabled).toBe(true)
  await act(async () => container!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await click(en['inbound.enable'])
  expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId); expect(requests.map(request => request.revision)).toEqual([0, 1])
}, 15_000)
