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
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

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
  await vi.waitFor(() => expect(f.text()).toContain('Saved content is a submission. Review its provenance and any independent check evidence before relying on it.'))
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

it('creates disabled check definitions through real forms, reuses a lost response and saves immutable revisions', async () => {
  const f = await fixture(), fetch = globalThis.fetch, requests: string[] = []; let lost = true
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init)
    if (String(url).endsWith('/checks') && init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)).requestId)
      if (lost) { lost = false; throw new Error('Saved response was lost') }
    }
    return response
  })
  await f.click('Check definitions'); await f.click('Create a check')
  await f.enter('Check name', 'Artifact existence'); await f.enter('What this check establishes', 'The saved artifact is present and nonempty')
  await f.click('Save check definition'); expect(f.text()).toContain('Cannot reach the dsh-superagent service')
  await f.click('Save check definition')
  expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1])
  const definitions = host!.runtime.verification.definitions, check = definitions.list().items[0]!
  expect(definitions.list().items).toHaveLength(1); expect(check).toMatchObject({ version: 1, enabled: false, workers: false, definition: { confinement: 'linux-bubblewrap' } })
  const open = async (text: string) => act(async () => { [...container!.querySelectorAll('summary')].find(item => item.textContent?.includes(text))!.click() })
  await open('Artifact existence'); await f.enter('Reason for this action', 'Reviewed for this workspace')
  const enabled = [...container!.querySelectorAll('label')].find(item => item.textContent === 'Allow this check to run')!.querySelector('input')!
  await act(async () => enabled.click()); await f.click('Update check authority')
  expect(definitions.get(check.id)).toMatchObject({ version: 1, revision: 2, enabled: true, workers: false })
  await open('Save a new version'); await f.enter('What this check establishes', 'New acceptance description')
  await f.click('Save check definition')
  expect(definitions.get(check.id)).toMatchObject({ version: 2, revision: 3, enabled: true })
  expect(definitions.version(check.id, 1).definition.description).toBe('The saved artifact is present and nonempty')
})

it('keeps artifact check IDs through a lost response, allows a deliberate new check and labels uncertain evidence honestly', async () => {
  const f = await fixture(), accepted = await host!.acceptedTicket(feishu('check-ui', '@bot prepare an artifact'))
  const ticket = host!.runtime.store.tickets.list().find(item => `worker-${item.id}` === accepted.sessionId)!, source = join(host!.directory, 'verification-source')
  await mkdir(source)
  ticket.execution!.directory = source; ticket.assignments.at(-1)!.execution = { directory: source, mode: ticket.execution!.mode, environment: ticket.execution!.environment }
  host!.runtime.store.tickets.save(ticket)
  const record = host!.runtime.library.publish({ requestId: 'check-ui-artifact', kind: 'artifact', title: 'Check UI artifact', summary: 'Saved result', content: 'evidence' }, { role: 'worker', ticketId: ticket.id })
  const check = host!.runtime.verification.definitions.create({ requestId: 'check-ui-definition', enabled: true, definition: {
    name: 'Check UI', description: 'Exercise the request and observation controls', argv: ['/bin/true'], artifactPath: 'artifact.txt', confinement: 'host-process' } })
  await f.navigate({ page: 'library', id: record.id })
  const select = [...container!.querySelectorAll('label')].find(item => item.firstChild?.textContent === 'Select a check version')!.querySelector('select')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, `${check.id}:1`); select.dispatchEvent(new Event('change', { bubbles: true })) })
  const originalFetch = globalThis.fetch, requests: string[] = []; let lost = true
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const response = await originalFetch(url, init)
    if (String(url).endsWith(`/library/${record.id}/verification`) && init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)).requestId)
      if (lost) { lost = false; throw new Error('Check acknowledgement lost') }
    }
    return response
  })
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  await f.click('Request check'); await vi.waitFor(async () => { await flush(); expect(f.text()).toContain('Cannot reach the dsh-superagent service') })
  await f.click('Request check'); await vi.waitFor(async () => { await flush(); expect(requests).toHaveLength(2) }); expect(requests[1]).toBe(requests[0])
  await vi.waitFor(() => expect(host!.runtime.verification.get(requests[0]!).quiescent).toBe(true))
  await f.click('Request check'); await vi.waitFor(async () => { await flush(); expect(requests).toHaveLength(3) }); expect(requests[2]).not.toBe(requests[1])
  expect(host!.runtime.verification.list(record.id).items).toHaveLength(2)
  // The fake subprocess provider cannot produce snapshot evidence. The UI must not promote its result.
  expect(f.text()).not.toContain('Passed for captured inputs')
  expect(f.text()).toContain('does not establish factual correctness')
  expect(f.text()).toContain('Host processes have no filesystem or network sandbox')
  expect(f.text()).toContain('Original assignment')
})
