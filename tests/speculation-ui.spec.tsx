// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SpeculationPage } from '../src/client/speculation.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { speculationFixture } from './fixtures/speculation.ts'
let root: Root | undefined, container: HTMLElement | undefined, fixture: ReturnType<typeof speculationFixture> | undefined
const click = async (text: string) => {
  const button = [...container!.querySelectorAll('button')].find(item => item.textContent === text)
  expect(button, text).toBeTruthy(); await act(async () => { button!.click() })
}
const note = async (text: string) => { await act(async () => {
  const element = container!.querySelector('textarea')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, text)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}) }
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await fixture?.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('reviews exact evidence, retries a committed promotion verbatim and separately approves its message', async () => {
  const f = fixture = speculationFixture(); f.policy(); const ticket = f.ticket(); await f.admit(ticket)
  f.store.receipts.add({ id: 'message', ticketId: ticket.id, kind: 'reply', text: 'Exact prepared result', channel: { source: 'fixture', thread: 'fixture:review', address: { id: 'review-room' } } })
  const ready = await f.ready(ticket); let lose = true; const submissions: unknown[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    let result: unknown
    if (String(url).endsWith('/state')) result = { load: { running: 0 } }
    else if (String(url).endsWith('/review')) {
      submissions.push(body); result = f.spec.review(ready.id, body)
      if (lose) { lose = false; throw new Error('Lost committed response') }
    } else if (String(url).endsWith('/messages')) result = f.spec.approveMessage(ready.id, body)
    else result = f.spec.get(ready.id)
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}><SpeculationPage id={ready.id} /></PanelProvider>))
  expect(container.textContent).toContain('Exact prepared result'); expect(container.textContent).toContain('review-room'); expect(container.textContent).toContain(ready.evidence)
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Approve this message for sending')).toBe(false)
  await note('Evidence and retained result reviewed'); await click('Save review decision'); expect(f.spec.get(ready.id).state).toBe('promoted')
  await click('Retry original request'); expect(submissions).toHaveLength(2); expect(submissions[0]).toEqual(submissions[1])
  expect(f.spec.get(ready.id).messages[0]!.approved).toBe(false)
  // A promoted run still has a cancellation form. Enter the separate message form's note.
  await act(async () => {
    const element = [...container!.querySelectorAll('textarea')].at(-1)!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, 'Exact text and destination reviewed')
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Approve this message for sending'); expect(f.spec.get(ready.id).messages[0]!.approved).toBe(true)
  expect(container.textContent).toContain('Approved to send')
})
