// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PublicationCard } from '../src/client/publications.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { pullReviewFixture } from './fixtures/pull-review.ts'
import * as localVerification from '../src/verification/local.ts'
import type { ApprovePublication } from '../src/publication/runtime.ts'

const cleanup: (() => Promise<unknown>)[] = []
let root: Root | undefined, container: HTMLDivElement | undefined, pending = 0
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove(); root = undefined; container = undefined
  vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks()
})
const settle = async () => { await vi.waitFor(() => expect(pending).toBe(0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = (text: string) => [...container!.querySelectorAll('button')].find(value => value.textContent === text)!
const click = async (text: string) => { await act(async () => { button(text).click(); await settle() }) }
const consent = () => [...container!.querySelectorAll('label')].find(label => label.textContent === en['publication.approve'])!.querySelector<HTMLInputElement>('input')!

async function fixture(lostReply = false) {
  vi.spyOn(localVerification, 'snapshotHelperPath').mockReturnValue(resolve('src/verification/snapshot-worker.ts'))
  const h = await pullReviewFixture(cleanup), nativeFetch = globalThis.fetch, requests: ApprovePublication[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('/orchestrator/api/')) return nativeFetch(input, init)
    pending++
    try {
      const url = new URL(String(input), 'http://localhost'), path = url.pathname.slice('/orchestrator/api/'.length)
      let value: unknown
      if (path === 'publication/destinations') value = await h.publications.destinations()
      else if (path === `publication/destinations/${h.destination.id}/pull`) value = await h.publications.inspectPull(h.destination.id, url.searchParams.get('hash')!)
      else if (path === `library/${h.artifact.id}/content`) value = h.library.content(h.artifact.id)
      else if (path === `library/${h.artifact.id}/review-checks`) value = h.verification.reviewChoices(h.artifact.id)
      else if (path === `library/${h.artifact.id}/publications`) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)); requests.push(body); value = await h.publications.publish(h.artifact.id, body)
          if (lostReply && requests.length === 1) throw new Error('Panel acknowledgement lost')
        } else value = lostReply && requests.length < 2 ? { items: [] } : h.publications.list(h.artifact.id)
      } else throw new Error(`Unexpected panel request: ${path}`)
      return new Response(JSON.stringify(value), { status: 200 })
    } finally { pending-- }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}><PublicationCard record={h.library.read(h.artifact.id)} /></PanelProvider>))
  await act(settle)
  const select = container.querySelector('select')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, h.destination.id); select.dispatchEvent(new Event('change', { bubbles: true })); await settle() })
  return { ...h, requests }
}
it('requires exact head inspection and selected check consent, retaining the original review ID after a lost UI response', async () => {
  const h = await fixture(true)
  expect(consent().disabled).toBe(true); expect(container!.textContent).toContain('APPROVE')
  await click(en['publication.inspectPull']); expect(container!.textContent).toContain(h.pull.binding.head.sha)
  await click(en['publication.preview']); expect(consent().disabled).toBe(true)
  const choices = [...container!.querySelectorAll<HTMLInputElement>('fieldset input[type=checkbox]')]
  expect(choices).toHaveLength(1)
  await act(async () => choices[0]!.click()); expect(consent().disabled).toBe(false)
  await act(async () => consent().click()); await click(en['publication.send'])
  expect(container!.querySelector('[role=alert]')).toBeTruthy(); expect(h.publisher.posts).toBe(1)
  await click(en['publication.send'])
  expect(h.requests).toHaveLength(2); expect(h.requests[0]).toEqual(h.requests[1])
  expect(h.requests[0]).toMatchObject({ pullHash: h.pull.hash, checks: [h.checked.selection] })
  expect(h.publisher.posts).toBe(1); expect(container!.textContent).toContain('APPROVED')
  expect(container!.querySelector('a')!.href).toContain('#pullrequestreview-1')
})
it('clears consent and selections when the inspected head changes and hides checks for the old commit', async () => {
  const h = await fixture()
  await click(en['publication.inspectPull']); await click(en['publication.preview'])
  await act(async () => container!.querySelector<HTMLInputElement>('fieldset input')!.click())
  await act(async () => consent().click()); expect(button(en['publication.send']).disabled).toBe(false)
  await writeFile(join(h.source, 'dependency.txt'), 'new head'); h.commit()
  await click(en['publication.inspectPull'])
  expect(consent().checked).toBe(false); expect(consent().disabled).toBe(true)
  expect(container!.querySelectorAll('fieldset input')).toHaveLength(0)
  expect(container!.textContent).toContain(en['publication.pullNoChecks']); expect(h.publisher.posts).toBe(0)
})
