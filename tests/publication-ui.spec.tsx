// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PublicationCard } from '../src/client/publications.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { publicationFixture } from './fixtures/publication.ts'
import { startRuntime } from './fixtures/host.ts'

const cleanup: (() => Promise<unknown>)[] = []
let root: Root | undefined, container: HTMLDivElement | undefined
let pendingRequests = 0
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove(); root = undefined; container = undefined
  vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks()
})
const button = (text: string) => [...container!.querySelectorAll('button')].find(value => value.textContent === text)!
// Wait for the real service responses inside act; DOM assertions alone can precede asynchronous state commits.
const settle = async () => { await vi.waitFor(() => expect(pendingRequests).toBe(0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); await act(async () => { button(text).click(); await settle() }) }
async function fixture(losePanelReply = false) {
  const authority = await ownershipAuthority(cleanup), publisher = await publicationFixture(cleanup, authority.resource)
  const host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true, ownership: authority.config, publication: publisher.connection })
  cleanup.push(() => host.stop())
  const artifact = host.runtime.library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'Report', summary: 'Reviewed report', content: 'Complete report to review' })
  const nativeFetch = globalThis.fetch, requests: { requestId: string }[] = []
  let lost = false
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('/orchestrator/api/')) return nativeFetch(input, init)
    pendingRequests++
    try {
    const path = String(input).slice('/orchestrator/api/'.length), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === `library/${artifact.id}/publications` && method === 'POST') requests.push(body)
    const response = await host.api(method, path, body)
    if (losePanelReply && method === 'POST' && path === `library/${artifact.id}/publications` && !lost) { lost = true; throw new Error('Panel reply lost') }
    // A lagging poll must not force a new request ID when the operator retries the unchanged approval.
    if (losePanelReply && method === 'GET' && path === `library/${artifact.id}/publications` && requests.length < 2)
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } })
    } finally { pendingRequests-- }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}>
    <PublicationCard record={host.runtime.library.read(artifact.id)} />
  </PanelProvider>))
  await act(settle)
  expect(container!.querySelectorAll('option'), container!.textContent ?? '').toHaveLength(2)
  const select = container.querySelector('select')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'project-updates'); select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(button(en['publication.send']).disabled).toBe(true)
  await click(en['publication.preview'])
  expect(container.querySelector('pre')!.textContent).toBe('Complete report to review')
  const checkbox = container.querySelector<HTMLInputElement>('input[type=checkbox]')!
  await act(async () => checkbox.click())
  expect(button(en['publication.send']).disabled).toBe(false)
  return { host, publisher, requests, artifact }
}

it('reviews complete content and retries a lost UI response with the original approval ID', async () => {
  const { publisher, requests } = await fixture(true)
  await click(en['publication.send'])
  expect(container!.querySelector('[role=alert]')).toBeTruthy(); expect(publisher.posts).toBe(1)
  await click(en['publication.send'])
  expect(requests).toHaveLength(2); expect(requests[0]!.requestId).toBe(requests[1]!.requestId)
  expect(publisher.posts).toBe(1); expect(container!.textContent).toContain(en['publication.phase.sent'])
  expect(button(en['publication.send']).disabled).toBe(true)
  expect(container!.querySelector('a')!.href).toBe('https://github.com/acme/project/issues/7#issuecomment-1')
})

it('shows an unknown result and observes its original provider receipt without publishing again', async () => {
  const { publisher } = await fixture()
  publisher.loseProviderReply(); await click(en['publication.send'])
  expect(container!.textContent).toContain(en['publication.phase.unknown'])
  expect(button(en['publication.send']).disabled).toBe(true)
  await click(en['publication.observe'])
  expect(container!.textContent).toContain(en['publication.phase.sent']); expect(publisher.posts).toBe(1)
})

it('prepares managed repository exports without a publisher and retries the exact submitted review after a lost response', async () => {
  const host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true }); cleanup.push(() => host.stop())
  const artifact = host.runtime.library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'Committed result', summary: 'Repository review', content: 'Result' })
  const record = { ...host.runtime.library.read(artifact.id), execution: { directory: '/remote/task', mode: 'local' as const,
    assignmentId: 'assignment', sessionId: 'worker', capturedAt: new Date().toISOString(),
    environment: { environmentId: 'remote', revision: 1, epoch: 1, world: 'a'.repeat(64) } } }
  const selection = { runId: 'check', evidenceHash: 'b'.repeat(64) }, requests: unknown[] = []
  let receipt: Record<string, any> | undefined
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice('/orchestrator/api/'.length), method = init?.method ?? 'GET'
    let data: unknown
    if (path === 'publication/destinations') data = { configured: false, items: [] }
    else if (path.includes('/review-checks')) data = { items: [{ run: { id: 'check', check: { name: 'Checked commit', version: 1 } },
      binding: { selection, checkedAt: new Date().toISOString(), confinement: 'linux-bubblewrap', snapshotHash: 'c'.repeat(64), repository: { commit: 'd'.repeat(40) } } }], nextOffset: null }
    else if (path.endsWith('/publications')) data = { items: [] }
    else if (path === `library/${artifact.id}/repository-exports` && method === 'GET') data = { items: receipt ? [receipt] : [] }
    else if (path === `library/${artifact.id}/repository-exports`) {
      const body = JSON.parse(String(init!.body)); requests.push(body)
      receipt = { id: body.requestId, phase: 'held', source: { url: 'https://example.invalid/source.git', commit: 'e'.repeat(40) }, head: 'd'.repeat(40), received: 0 }
      if (requests.length === 1) throw new Error('Export response lost')
      data = receipt
    } else if (path === `repository-exports/${receipt?.id}/retry`) data = receipt = { ...receipt, phase: 'ready', received: 100, bundle: { bytes: 100, sha256: 'f'.repeat(64) } }
    else if (path === `repository-exports/${receipt?.id}/cancel`) data = receipt = { ...receipt, phase: 'cancelled' }
    else throw new Error('Unexpected panel request')
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const render = (revision: number) => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}><PublicationCard record={{ ...record, revision }} /></PanelProvider>)
  await act(async () => { render(record.revision); await settle() })
  expect(container.textContent).toContain(en['repositoryExport.title'])
  expect(button(en['repositoryExport.prepare']).disabled).toBe(true)
  await act(async () => container!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await click(en['repositoryExport.prepare'])
  expect(container.querySelector('[role=alert]')).toBeTruthy()
  await act(async () => { render(record.revision + 1); await settle() })
  await click(en['repositoryExport.retryRequest'])
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0])
  expect(requests[0]).toMatchObject({ revision: record.revision, checks: [selection] })
  await click(en['repositoryExport.resume']); expect(button(en['repositoryExport.download'])).toBeTruthy()
  await click(en['repositoryExport.cancel']); expect(container.textContent).toContain(en['repositoryExport.phase.cancelled'])
})
