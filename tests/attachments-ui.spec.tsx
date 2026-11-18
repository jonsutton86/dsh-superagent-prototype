// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { randomUUID, webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { InboxPage } from '../src/client/inbox.tsx'
import { AttachmentCard, AttachmentPicker } from '../src/client/attachments.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'
import { attachmentBackend } from './fixtures/attachments.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLDivElement | undefined
const settle = async (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); assertion() })
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function fixture(intercept?: (path: string, result: unknown) => void | Promise<void>) {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, attachments: attachmentBackend().backend })
  vi.stubGlobal('crypto', { randomUUID, subtle: { digest: (_: string, data: ArrayBuffer) => webcrypto.subtle.digest('SHA-256', new Uint8Array(data)) } })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', '')
    const result = await host!.api(init?.method ?? 'GET', path, init?.body ? JSON.parse(String(init.body)) : undefined)
    await intercept?.(path, result.body)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
}
const button = (label: string) => [...container!.querySelectorAll('button')].find(item => item.textContent === label)!
async function click(label: string) { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()) }
async function choose(files = [new File(['first,second\n1,2\n'], 'data.csv', { type: 'text/csv' })]) {
  const input = container!.querySelector('input[type=file]')!
  await act(async () => { Object.defineProperty(input, 'files', { value: files, configurable: true }); input.dispatchEvent(new Event('change', { bubbles: true })) })
}
it.each(['chunks', 'finish'])('recovers a lost %s response and an ambiguous Send without duplicate messages or discarded inputs', async phase => {
  let lostUpload = false, lostSend = false, sent: string | undefined
  await fixture(path => {
    if (path.endsWith(`/${phase}`) && !lostUpload) { lostUpload = true; throw new TypeError('Upload response lost') }
    if (path === 'inbox' && host!.runtime.store.tickets.list().length && !lostSend) { lostSend = true; throw new TypeError('Send response lost') }
  })
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={next => { sent = next.id }}><InboxPage /></PanelProvider>))
  await click('New task')
  const textarea = container!.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Read the CSV'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  await choose(); await settle(() => expect(lostUpload && button('Retry upload') !== undefined).toBe(true))
  expect(button('Start task').disabled).toBe(true); expect(host!.runtime.store.tickets.list()).toHaveLength(0)
  await click('Retry upload'); await settle(() => expect(button('Start task').disabled).toBe(false))
  const uploads = host!.runtime.store.db.prepare('SELECT id FROM inbox_upload').all(); expect(uploads).toHaveLength(1)
  await click('Start task'); expect(lostSend).toBe(true); expect(container!.querySelector('[role=alert]')).not.toBeNull(); expect(textarea.value).toBe('Read the CSV')
  await click('Start task'); expect(sent).toBeTruthy(); expect(host!.runtime.store.tickets.list()).toHaveLength(1)
  const conversation = await host!.runtime.inbox.conversation(sent!)
  expect(conversation.messages.filter(message => message.role === 'person')).toHaveLength(1)
  expect(conversation.messages.find(message => message.role === 'person')!.attachments).toMatchObject([{ id: uploads[0]!.id, name: 'data.csv' }])
  expect(host!.runtime.attachments.get(String(uploads[0]!.id)).phase).toBe('ready')
})
it('cancels a selection while its accepted upload response is delayed and prevents late completion after navigation', async () => {
  let release!: () => void, accepted: string | undefined
  const delayed = new Promise<void>(resolve => { release = resolve })
  await fixture(async (path, result) => { if (path === 'uploads' && (result as { id?: string }).id) { accepted = (result as { id: string }).id; await delayed } })
  const changed = vi.fn()
  await act(async () => root!.render(<PanelProvider t={translator(en)}><AttachmentPicker disabled={false} reset={0} onChange={changed} /></PanelProvider>))
  await choose(); await settle(() => expect(accepted).toBeTruthy())
  await act(async () => root!.render(<p>Another page</p>)); release()
  await settle(() => expect(host!.runtime.attachments.get(accepted!).phase).toBe('cancelled'))
  expect(host!.runtime.store.tickets.list()).toHaveLength(0)
  expect(host!.runtime.store.db.prepare('SELECT count(*) AS n FROM inbox_upload_chunk').get()!.n).toBe(0)
})
it('rejects excessive selections before upload and keeps image previews authenticated and revocable', async () => {
  await fixture(); const changed = vi.fn()
  await act(async () => root!.render(<PanelProvider t={translator(en)}><AttachmentPicker disabled={false} reset={0} onChange={changed} /></PanelProvider>))
  await choose(Array.from({ length: 9 }, (_, i) => new File(['x'], `file${i}.txt`)))
  expect(container!.querySelector('[role=alert]')).not.toBeNull(); expect(host!.runtime.store.db.prepare('SELECT count(*) AS n FROM inbox_upload').get()!.n).toBe(0)
  const request = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', request)
  const create = vi.fn(() => 'blob:preview'), revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  const file = { id: randomUUID(), name: '<script>.png', bytes: 2, sha256: 'a'.repeat(64), mediaType: 'image/png', image: true }
  await act(async () => root!.render(<PanelProvider t={translator(en)}><AttachmentCard file={file} /></PanelProvider>))
  await click('Preview image')
  expect(request).toHaveBeenCalledWith(`/orchestrator/api/uploads/${file.id}/image`, expect.objectContaining({ headers: { 'x-orchestrator-request': '1' }, signal: expect.any(AbortSignal) }))
  expect(container!.querySelector('script')).toBeNull(); expect(container!.querySelector('img')?.getAttribute('src')).toBe('blob:preview')
  await act(async () => root!.render(<p>Another page</p>)); expect(revoke).toHaveBeenCalledWith('blob:preview')
})
