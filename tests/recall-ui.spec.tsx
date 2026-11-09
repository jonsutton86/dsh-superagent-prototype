// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LibraryPage } from '../src/client/library.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('edits host recall limits with original-request retry and follows a stale transitive source through the library', async () => {
  host = await startRuntime(); const library = host.runtime.library
  const leaf = library.publish({ requestId: 'leaf', title: 'Original research', summary: 'Original source', kind: 'memory', content: 'Original evidence' })
  const middle = library.publish({ requestId: 'middle', title: 'Summary', summary: 'Derived source', kind: 'memory', content: 'Intermediate summary', sources: [{ id: leaf.id, relation: 'derived_from' }] })
  const derived = library.publish({ requestId: 'derived', title: 'Decision brief', summary: 'Latest summary', kind: 'memory', content: 'Derived evidence', sources: [{ id: middle.id, relation: 'supports' }] })
  library.recall.search({}, { role: 'router' }, new AbortController().signal)
  library.archive(leaf.id, { requestId: 'archive', revision: 1, archived: true })
  let lose = true; const submissions: unknown[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined
    const result = await host!.api(init?.method ?? 'GET', path, body)
    if (path === 'recall' && init?.method === 'PUT') { submissions.push(body); if (lose) { lose = false; throw new Error('Lost committed response') } }
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  let id: string | undefined
  const render = () => root!.render(<PanelProvider t={translator(en)} navigate={next => { id = next.id; render() }}><LibraryPage key={id ?? 'list'} id={id} /></PanelProvider>)
  const click = async (text: string) => {
    const button = [...container!.querySelectorAll('button')].find(item => item.textContent === text)
    expect(button, text).toBeTruthy(); await act(async () => { button!.click() })
  }
  await act(async () => render()); expect(container.textContent).toContain('Source chain changed')
  await click('Recall limits and history'); expect(container.textContent).toContain('Returned')
  await click('Edit recall limits')
  const field = container.querySelector('input[name="owner.calls"]') as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '2'); field.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('Save'); expect(container.textContent).toContain('Cannot reach the dsh-superagent service')
  await click('Retry original request'); expect(submissions).toHaveLength(2); expect(submissions[0]).toEqual(submissions[1])
  expect(library.recall.configuration().policy.owner.calls).toBe(2)
  library.recall.search({}, { role: 'router' }, new AbortController().signal)
  expect(() => library.recall.search({}, { role: 'router' }, new AbortController().signal)).toThrow('Recall allowance exhausted')
  await act(async () => { id = derived.id; render() })
  expect(container.textContent).toContain('Source chain changed'); await click('Archived source')
  expect(id).toBe(leaf.id); expect(container.textContent).toContain('Original evidence')
})
