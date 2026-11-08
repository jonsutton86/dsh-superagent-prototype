// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LibraryPage, sandboxDocument } from '../src/client/library.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import type { Route } from '../src/client/route.ts'
import { translator } from './fixtures/panel.tsx'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import type { LibraryEntry } from '../src/workspace/library-model.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove()
  await host?.stop(); host = undefined; root = undefined; container = undefined
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function fixture(initial: Route = { page: 'library' }) {
  host = await startRuntime()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const result = await host!.api(init?.method ?? 'GET', String(url).replace('/orchestrator/api/', ''), init?.body ? JSON.parse(String(init.body)) : undefined)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  let route = initial
  const render = () => root!.render(<PanelProvider t={translator(en)} navigate={next => { route = next; render() }}>
    <LibraryPage key={`${route.id ?? 'list'}:${route.page === 'library' ? route.query?.scope ?? '' : ''}`} id={route.id}
      scope={route.page === 'library' ? route.query?.scope : undefined} /></PanelProvider>)
  const text = () => container!.textContent ?? ''
  const click = async (label: string) => {
    const button = [...container!.querySelectorAll('button')].find(button => button.textContent === label)
    expect(button, label).toBeTruthy(); await act(async () => { button!.click() })
  }
  const enter = async (label: string, value: string) => {
    const parent = [...container!.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)
    const element = parent?.querySelector('input,textarea') as HTMLInputElement | HTMLTextAreaElement
    expect(element, label).toBeTruthy()
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await act(async () => render())
  return { click, enter, text, navigate: async (next: Route) => { route = next; await act(async () => render()) } }
}

it('saves, revises, follows provenance and archives through rendered library forms and real routes', async () => {
  const f = await fixture()
  await f.click('Save a record')
  await f.enter('Record title', 'Research preferences')
  await f.enter('Short description', 'Prefer original sources')
  await f.enter('Content', 'Use primary sources and record uncertainty.')
  await f.click('Save record')
  await vi.waitFor(() => expect(f.text()).toContain('Saved content; independent result verification has not been performed.'))
  expect(f.text()).toContain('Use primary sources and record uncertainty.')
  const first = host!.runtime.library.list().items[0]!
  await f.click('Create a new revision')
  await f.enter('Content', 'Use primary sources with dated evidence.')
  await f.click('Save record')
  await vi.waitFor(() => expect(f.text()).toContain('Use primary sources with dated evidence.'))
  const second = host!.runtime.library.list().items[0]!
  expect(second.sources).toEqual([{ id: first.id, hash: first.hash, relation: 'supersedes' }])
  await f.click(`supersedes · ${first.id}`)
  await vi.waitFor(() => expect(f.text()).toContain('Superseded'))
  expect(f.text()).toContain('Use primary sources and record uncertainty.')
  await f.click(`supersedes · ${second.id}`)
  await f.click('Archive')
  await vi.waitFor(() => expect(f.text()).toContain('Restore'))
  expect(host!.runtime.library.read(second.id).archived).toBe(true)
  await f.click('Restore')
  await vi.waitFor(() => expect(f.text()).not.toContain('Restore'))
  await f.click('Memory & artifacts')
  await f.enter('Search records', 'dated evidence')
  await f.click('Search records')
  await vi.waitFor(() => expect(f.text()).toContain('Research preferences'))
  expect(container!.querySelectorAll('.dt-mission-card')).toHaveLength(1)
})

it('shows a real worker publication with inert HTML preview and a revocable download URL', async () => {
  const f = await fixture()
  const { sessionId } = await host!.acceptedTicket(feishu('library-html', '@bot write a brief'))
  const html = '<h1>Worker brief</h1><script>alert(1)</script><a href="https://example.invalid">link</a><meta http-equiv="refresh" content="0;url=https://example.invalid"><img src="https://example.invalid/pixel" onerror="alert(1)">'
  const record = await host!.runTool(sessionId, 'workspace_publish', { requestId: 'html', kind: 'artifact', title: 'Worker brief',
    summary: 'A generated HTML brief', mime: 'text/html', filename: 'brief.html', content: html }) as unknown as LibraryEntry
  const create = vi.fn(() => 'blob:library-preview'), revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  await f.navigate({ page: 'library', id: record.id })
  await f.click('Full preview & download')
  const preview = container!.querySelector('iframe')!
  expect(preview.getAttribute('sandbox')).toBe('')
  expect(preview.srcdoc).toContain('<h1>Worker brief</h1>')
  expect(preview.srcdoc).not.toContain('<script')
  expect(preview.srcdoc).not.toContain('example.invalid')
  expect(preview.srcdoc).not.toContain('onerror')
  expect(container!.querySelector('a[download]')?.getAttribute('download')).toBe('brief.html')
  expect(f.text()).toContain('Agent submission')
  expect(host!.runtime.library.content(record.id).data).toBe(Buffer.from(html).toString('base64'))
  await f.navigate({ page: 'library' })
  expect(revoke).toHaveBeenCalledWith('blob:library-preview')
})

it('removes navigation, executable markup, nested frames and external resources before previewing HTML', () => {
  const result = sandboxDocument(`<style>body {color: red}</style><base href="https://evil.invalid"><form action="https://evil.invalid"><input></form>
    <iframe srcdoc="hi"></iframe><object data="file:///secret"></object><svg><a href="https://evil.invalid">go</a></svg>
    <div onclick="evil()" style="color:blue">Safe text</div><img src="data:image/png;base64,YQ==" srcset="https://evil.invalid 2x">`)
  expect(result).toContain("default-src 'none'")
  expect(result).toContain('<div style="color:blue">Safe text</div>')
  expect(result).toContain('data:image/png;base64,YQ==')
  for (const forbidden of ['<base', '<form', '<iframe', '<object', '<svg', 'onclick', 'srcset', 'evil.invalid']) expect(result).not.toContain(forbidden)
})
