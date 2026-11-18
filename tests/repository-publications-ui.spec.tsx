// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RepositoryPublicationCard } from '../src/client/repository-publications.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import type { RepositoryExportView } from '../src/publication/repository-export-model.ts'
import type { PrepareRepositoryPublication, RepositoryPublicationView } from '../src/publication/repository-runtime-model.ts'
import { translator } from './fixtures/panel.tsx'

let root: Root | undefined, container: HTMLDivElement | undefined, pending = 0
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove(); root = undefined; container = undefined
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const settle = async () => { await vi.waitFor(() => expect(pending).toBe(0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = (text: string) => [...container!.querySelectorAll('button')].find(value => value.textContent === text)
const click = async (text: string) => {
  expect(button(text), text).toBeTruthy()
  await act(async () => { button(text)!.click(); await settle() })
}
const field = (label: string) => [...container!.querySelectorAll('label')].find(value => value.textContent === label)!.querySelector<HTMLInputElement>('input, textarea, select')!
const fill = async (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const approve = async () => { await act(async () => field(en['repositoryPublication.approve']).click()) }

async function fixture(options: { losePrepare?: boolean; losePublish?: boolean; unknown?: boolean; cancelUnconfirmed?: boolean } = {}) {
  const at = new Date().toISOString(), hash = 'a'.repeat(64), head = 'b'.repeat(40), base = 'c'.repeat(40)
  const destination = { id: 'project', name: 'Project', repository: 'acme/project', repositoryId: 71, baseRef: 'main', login: 'publisher', hash }
  const exported: RepositoryExportView = { id: randomUUID(), artifactId: randomUUID(), world: hash, ticketId: 'ticket', assignmentId: 'assignment',
    source: { url: 'https://github.com/acme/project.git', commit: base, username: 'x-access-token' }, head, tree: 'd'.repeat(40),
    phase: 'ready', received: 100, createdAt: at, updatedAt: at, bundle: { version: 1, base, head, tree: 'd'.repeat(40), bytes: 100, sha256: hash } }
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = []
  let item: RepositoryPublicationView | undefined, prepareLost = false, publishLost = false, dispatches = 0, current = true, cancellations = 0
  const makeItem = (body: PrepareRepositoryPublication): RepositoryPublicationView => {
    const artifact = { id: exported.artifactId, revision: 1, hash }, ownership = { coordinatorId: 'coordinator', epoch: 1, nonce: randomUUID(), instanceId: randomUUID() }
    return { id: body.requestId, exportId: exported.id, destination, phase: 'ready', cancelRequested: false, createdAt: at, updatedAt: at, received: 100,
      transfer: { id: body.requestId, artifact, source: exported.source.url, bundle: exported.bundle! },
      publication: { ...body, id: body.requestId, transferId: body.requestId, transferHash: hash, checks: [{ runId: 'check', evidenceHash: hash }] }, approvals: [],
      receipt: { id: body.requestId, requestHash: hash, destination: destination.id, destinationHash: hash, transferId: body.requestId, transferHash: hash,
        artifact, bundle: exported.bundle!, branch: `agentic/${body.requestId}`, ownership, phase: 'held', step: 'branch', createdAt: at, updatedAt: at, attempts: [] } }
  }
  const published = () => {
    item!.phase = 'published'; item!.receipt!.phase = 'published'
    const branch = { repository: destination.repository, repositoryId: destination.repositoryId, ref: item!.receipt!.branch, sha: head }
    item!.receipt!.branchResult = branch
    item!.receipt!.pullResult = { id: 101, number: 12, url: 'https://github.com/acme/project/pull/12', repositoryId: destination.repositoryId,
      head: branch, base: { ...branch, ref: 'main', sha: base }, bodyHash: hash, title: item!.publication.title, draft: item!.publication.draft, state: 'open', merged: false }
  }
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    pending++
    try {
      const path = String(input).slice('/orchestrator/api/'.length), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ path, method, ...(body ? { body } : {}) })
      let value: unknown
      if (path === 'repository-publication/destinations') value = { configured: true, items: [destination] }
      else if (path === `repository-exports/${exported.id}/publications`) {
        if (method === 'GET') value = { items: item ? [item] : [] }
        else {
          item ??= makeItem(body); value = item
          if (options.losePrepare && !prepareLost) { prepareLost = true; throw new Error('Preparation reply lost') }
        }
      } else if (path === `repository-publications/${item?.id}/publish`) {
        if (!item!.approvals.some(approval => approval.id === body.requestId)) {
          item!.approvals.push({ id: body.requestId, at, dispatched: true }); dispatches++
          if (options.unknown) { item!.phase = 'unknown'; item!.receipt!.phase = 'unknown' } else published()
        }
        value = item
        if (options.losePublish && !publishLost) { publishLost = true; throw new Error('Approval reply lost') }
      } else if (path === `repository-publications/${item?.id}/refresh`) { if (item!.phase === 'unknown') published(); value = item }
      else if (path === `repository-publications/${item?.id}/retry`) { item!.phase = 'ready'; value = item }
      else if (path === `repository-publications/${item?.id}/cancel`) {
        item!.phase = options.cancelUnconfirmed && cancellations++ === 0 ? 'held' : 'cancelled'; item!.cancelRequested = true; value = item
      }
      else if (path.startsWith('evidence-reviews/')) value = { status: 'ready', attempts: [] }
      else throw new Error(`Unexpected panel request: ${path}`)
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    } finally { pending-- }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const render = () => root!.render(<PanelProvider t={translator(en)}><RepositoryPublicationCard exported={exported} current={current} /></PanelProvider>)
  await act(async () => { render(); await settle() })
  await fill(container.querySelector('select')!, destination.id)
  await fill(field(en['repositoryPublication.pullTitle']), 'Publish checked work')
  await fill(field(en['repositoryPublication.pullBody']), 'Exact reviewed body')
  return { requests, exported, destination, item: () => item!, dispatches: () => dispatches,
    setCurrent: async (value: boolean) => { current = value; await act(async () => { render(); await settle() }) } }
}

it('separates private preparation from fresh approval and preserves both original IDs after response loss', async () => {
  const h = await fixture({ losePrepare: true, losePublish: true })
  expect(button(en['repositoryPublication.publish'])).toBeUndefined()
  await click(en['repositoryPublication.prepare'])
  expect(container!.querySelector('[role=alert]')).toBeTruthy(); expect(h.dispatches()).toBe(0)
  await click(en['repositoryPublication.recoverRequest'])
  const prepare = h.requests.filter(request => request.method === 'POST' && request.path.endsWith('/publications'))
  expect(prepare).toHaveLength(2); expect(prepare[0]!.body).toEqual(prepare[1]!.body)
  expect(prepare[0]!.body).toMatchObject({ destination: h.destination.id, destinationHash: h.destination.hash, title: 'Publish checked work', body: 'Exact reviewed body', draft: true })
  for (const text of [h.destination.repository, h.destination.baseRef, h.destination.login, h.exported.head, h.exported.source.commit, h.item().receipt!.branch, 'Exact reviewed body'])
    expect(container!.textContent).toContain(text)
  expect(button(en['repositoryPublication.publish'])!.disabled).toBe(true)
  await approve(); await click(en['repositoryPublication.publish'])
  expect(h.dispatches()).toBe(1); expect(container!.querySelector('[role=alert]')).toBeTruthy()
  expect(button(en['repositoryPublication.publish'])!.disabled).toBe(true)
  await click(en['repositoryPublication.recoverRequest'])
  const approvals = h.requests.filter(request => request.path.endsWith('/publish'))
  expect(approvals).toHaveLength(2); expect(approvals[0]!.body).toEqual(approvals[1]!.body)
  expect(h.dispatches()).toBe(1); expect(container!.textContent).toContain(en['repositoryPublication.phase.published'])
  expect(container!.querySelector('a')!.href).toBe('https://github.com/acme/project/pull/12')
  const details = [...container!.querySelectorAll('details')].find(node => node.querySelector('summary')!.textContent!.startsWith(en['verification.approvalEvidence']))!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); await settle() })
  expect(h.requests.some(request => request.path === `evidence-reviews/${String(approvals[0]!.body!.requestId)}`)).toBe(true)
})

it('offers only observation for an unknown external outcome and uses the original operation after remount', async () => {
  const h = await fixture({ unknown: true })
  await click(en['repositoryPublication.prepare']); await approve(); await click(en['repositoryPublication.publish'])
  const id = h.item().id
  expect(container!.textContent).toContain(en['repositoryPublication.unknownHint'])
  expect(button(en['repositoryPublication.publish'])).toBeUndefined()
  expect(button(en['repositoryPublication.resume'])).toBeUndefined()
  expect(button(en['repositoryPublication.cancel'])).toBeUndefined()
  expect(button(en['repositoryPublication.prepare'])!.disabled).toBe(true)
  await act(async () => root!.unmount()); root = createRoot(container!)
  await act(async () => { root!.render(<PanelProvider t={translator(en)}><RepositoryPublicationCard exported={h.exported} current /></PanelProvider>); await settle() })
  expect(container!.textContent).toContain(id)
  await click(en['repositoryPublication.observe'])
  expect(h.dispatches()).toBe(1)
  expect(h.requests.filter(request => request.path.endsWith('/refresh')).at(-1)!.path).toBe(`repository-publications/${id}/refresh`)
  expect(container!.textContent).toContain(en['repositoryPublication.phase.published'])
})

it('clears approval when current authority changes and requires a new check after private continuation', async () => {
  const h = await fixture()
  await click(en['repositoryPublication.prepare']); await approve()
  expect(button(en['repositoryPublication.publish'])!.disabled).toBe(false)
  await h.setCurrent(false)
  expect(field(en['repositoryPublication.approve']).checked).toBe(false)
  expect(button(en['repositoryPublication.publish'])!.disabled).toBe(true)
  await h.setCurrent(true)
  expect(field(en['repositoryPublication.approve']).checked).toBe(false)
  expect(button(en['repositoryPublication.publish'])!.disabled).toBe(true)
  h.item().phase = 'held'; h.item().receipt!.phase = 'branch_ready'
  await click(en['repositoryPublication.observe'])
  await h.setCurrent(true)
  await click(en['repositoryPublication.resume'])
  expect(field(en['repositoryPublication.approve']).checked).toBe(false)
  expect(button(en['repositoryPublication.publish'])!.disabled).toBe(true)
  expect(h.dispatches()).toBe(0)
})

it('can confirm an unacknowledged original cancellation without re-enabling preparation or publishing', async () => {
  const h = await fixture({ cancelUnconfirmed: true })
  await click(en['repositoryPublication.prepare']); const id = h.item().id
  await click(en['repositoryPublication.cancel'])
  expect(container!.textContent).toContain(en['repositoryPublication.cancelRequested'])
  expect(button(en['repositoryPublication.publish'])).toBeUndefined()
  expect(button(en['repositoryPublication.resume'])).toBeUndefined()
  await click(en['repositoryPublication.retryCancel'])
  const cancellations = h.requests.filter(request => request.path.endsWith('/cancel'))
  expect(cancellations.map(request => request.path)).toEqual([`repository-publications/${id}/cancel`, `repository-publications/${id}/cancel`])
  expect(container!.textContent).toContain(en['repositoryPublication.phase.cancelled']); expect(h.dispatches()).toBe(0)
})
