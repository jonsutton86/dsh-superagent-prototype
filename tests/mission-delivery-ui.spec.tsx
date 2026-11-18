// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MissionDeliveryCard } from '../src/client/mission-delivery.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { channelPublicationFixture } from './fixtures/channel-publication.ts'
import type { ConfigureDelivery } from '../src/publication/channels.ts'

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
  const context = await channelPublicationFixture(cleanup), { host, mission } = context
  const nativeFetch = globalThis.fetch, requests: ConfigureDelivery[] = []; let lost = false
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('/orchestrator/api/')) return nativeFetch(input, init)
    pendingRequests++
    try {
      const path = String(input).slice('/orchestrator/api/'.length), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (method === 'PUT') requests.push(body)
      const response = await host.api(method, path, body)
      if (losePanelReply && method === 'PUT' && !lost) { lost = true; throw new Error('Delivery grant acknowledgement lost') }
      if (losePanelReply && method === 'GET' && path.endsWith('/delivery') && requests.length < 2)
        return new Response(JSON.stringify({ configured: true, current: false, items: [] }), { status: 200 })
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } })
    } finally { pendingRequests-- }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const render = async () => {
    const view = host.runtime.workspace.get(mission.id)
    await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}>
      <MissionDeliveryCard key={`${view.id}:${view.planVersion}`} mission={view} />
    </PanelProvider>)); await act(settle)
  }
  await render()
  const select = container.querySelector('select')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'project-updates'); select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(button(en['delivery.enable']).disabled).toBe(true)
  await act(async () => container!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  expect(button(en['delivery.enable']).disabled).toBe(false)
  return { ...context, requests, render }
}

it('retains the exact consent request after a lost acknowledgement and lagging poll', async () => {
  const { host, publisher, mission, requests } = await fixture(true)
  await click(en['delivery.enable'])
  expect(container!.querySelector('[role=alert]')).toBeTruthy()
  await click(en['delivery.enable'])
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0])
  expect(host.runtime.channelPublications.state(mission.id).grant?.revision).toBe(1)
  expect(container!.textContent).toContain(en['delivery.active'])
  expect(button(en['delivery.enable']).disabled).toBe(true); expect(publisher.posts).toBe(0)
})

it('stops new mission replies and still observes an unknown original delivery', async () => {
  const { host, publisher, run, render } = await fixture()
  await click(en['delivery.enable'])
  const { sessionId, trigger } = await run()
  publisher.loseProviderReply(); await host.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'Preparing the result.' })
  // Remount to exercise initial receipt loading against the actual Runtime API.
  await act(async () => root!.render(null)); await render()
  expect(container!.textContent).toContain(en['publication.phase.unknown'])
  expect(button(en['delivery.enable']).disabled).toBe(true)
  await click(en['delivery.disable'])
  expect(container!.textContent).toContain(en['delivery.off'])
  expect(button(en['publication.retry']).disabled).toBe(true)
  await click(en['publication.observe'])
  expect(container!.textContent).toContain(en['publication.phase.sent']); expect(publisher.posts).toBe(1)
  expect(container!.querySelector('a')!.href).toBe('https://github.com/acme/project/issues/7#issuecomment-1')
}, 10_000)

it('requires renewed consent after a definitive stale-revision rejection', async () => {
  const { host, mission, configure, requests } = await fixture()
  await host.runtime.channelPublications.configure(mission.id, configure)
  await click(en['delivery.enable'])
  expect(container!.querySelector('[role=alert]')).toBeTruthy()
  expect(button(en['delivery.enable']).disabled).toBe(true)
  await act(async () => container!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await click(en['delivery.enable'])
  expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId)
  expect(requests.map(request => request.revision)).toEqual([0, 1])
  expect(host.runtime.channelPublications.state(mission.id).grant?.revision).toBe(2)
})
