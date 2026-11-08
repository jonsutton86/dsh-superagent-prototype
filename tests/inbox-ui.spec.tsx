// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { InboxPage } from '../src/client/inbox.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import type { Route } from '../src/client/route.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function enter(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('starts a task, displays its question, preserves an ambiguous reply retry, and links the resulting artifact and mission', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  let loseReply = true
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', '')
    const result = await host!.api(init?.method ?? 'GET', path, init?.body ? JSON.parse(String(init.body)) : undefined)
    if (path.endsWith('/reply') && loseReply) { loseReply = false; throw new TypeError('Response lost after commit') }
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  let route: Route = { page: 'inbox' }
  const navigate = vi.fn((next: Route) => { route = next; render() })
  const render = () => root!.render(<PanelProvider t={translator(en)} navigate={navigate}>
    {route.page === 'inbox' ? <InboxPage key={route.id ?? 'list'} id={route.id} filter={route.query?.filter} /> : <p>Other page</p>}
  </PanelProvider>)
  const text = () => container!.textContent ?? ''
  const click = async (label: string) => {
    const button = [...container!.querySelectorAll('button')].find(button => button.textContent === label)
    expect(button, label).toBeTruthy(); await act(async () => button!.click())
  }
  const remount = async () => { await act(async () => { root!.unmount(); root = createRoot(container!); render() }) }
  await act(async () => render())
  await click('New task')
  await enter(container.querySelector('textarea')!, 'Prepare a short briefing')
  await click('Start task')
  await host.runtime.idle()
  await vi.waitFor(() => expect(text()).toContain('All conversations'))
  const id = route.id!, item = host.runtime.inbox.item(id)
  await host.runTool(item.sessionId!, 'orchestrator_report', { state: 'blocked', summary: 'Choose the output', human_action: 'Markdown or plain text?' })
  await remount()
  expect(text()).toContain('Markdown or plain text?')
  await click('Mark read')
  expect(host.runtime.inbox.item(id).unread).toBe(false)
  expect(text()).toContain('Markdown or plain text?')
  await enter(container.querySelector('textarea')!, 'Use Markdown and include sources.')
  await click('Send message')
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.querySelector('textarea')!.value).toBe('Use Markdown and include sources.')
  // The committed reply changed the server revision, but the retry must keep its original id and body.
  await click('Send message')
  expect(container.querySelector('textarea')!.value).toBe('')
  expect(host.runtime.store.db.prepare("SELECT count(*) AS count FROM trigger WHERE value ->> '$.text' = ?")
    .get('Use Markdown and include sources.')?.count).toBe(1)
  const artifact = await host.runTool(item.sessionId!, 'workspace_publish', { requestId: 'brief', kind: 'artifact', title: 'Final briefing',
    summary: 'Brief with sources', content: '# Brief\nSources and findings.' }) as { id: string }
  await host.runTool(item.sessionId!, 'orchestrator_report', { state: 'ready', summary: '<script>window.bad = true</script> Brief ready.', human_action: null })
  await remount()
  expect(text()).toContain('Ready for review'); expect(container.querySelector('script')).toBeNull()
  expect(host.runtime.workspace.get(item.mission!.id).completed).toBe(0)
  await click('Final briefing')
  expect(navigate).toHaveBeenLastCalledWith({ page: 'library', id: artifact.id })
  route = { page: 'inbox', id }; await remount(); await click('Open mission')
  expect(navigate).toHaveBeenLastCalledWith({ page: 'missions', id: item.mission!.id })
})

it('keeps stopped conversations read-only and renders the unread/question filters', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const item = host.runtime.inbox.start({ requestId: 'stopped', text: 'A task to stop' })
  await host.runtime.idle(); host.runtime.engine.stopTicket(item.id, 'Stopped by owner')
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const result = await host!.api(init?.method ?? 'GET', String(url).replace('/orchestrator/api/', ''), init?.body ? JSON.parse(String(init.body)) : undefined)
    return new Response(JSON.stringify(result.body), { status: result.status })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const render = (id?: string) => root!.render(<PanelProvider t={translator(en)}><InboxPage key={id ?? 'list'} id={id} /></PanelProvider>)
  await act(async () => render(item.id))
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.textContent).toContain('Stopped')
  await act(async () => render())
  expect(container.querySelector('[data-unread="true"]')).not.toBeNull()
  expect(container.textContent).toContain('1 unread · 0 questions · 0 results to review')
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Questions')).toBe(true)
})
