// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivateWorldForm, WorldPoolPanel, WorldSelector } from '../src/client/worlds.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import type { WorldView } from '../src/environments/pool-model.ts'

let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks() })
const world = (id = 'a'.repeat(64)): WorldView => ({ id, name: 'Remote work', endpointId: '00000000-0000-4000-8000-000000000001',
  grantId: 'work', epoch: 1, revision: 1, root: '/work', ready: true, enabled: true, createdAt: '', updatedAt: '' })
const button = (label: string) => [...container!.querySelectorAll('button')].find(node => node.textContent === label)
async function click(label: string) { expect(button(label), label).toBeTruthy(); await act(async () => { button(label)!.click() }) }
async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function render(children: ReactNode) {
  if (!container) { container = document.createElement('div'); document.body.append(container); root = createRoot(container) }
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}>{children}</PanelProvider>))
}

it('retries the submitted activation after response loss without substituting edited repository fields or a new request ID', async () => {
  const requests: unknown[] = [], value = world()
  const repository = { url: 'https://example.invalid/source.git', commit: 'a'.repeat(40), credentialId: 'git-read', username: 'x-access-token' }
  value.repository = repository
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/state')) return new Response(JSON.stringify({ load: { running: 0 } }))
    requests.push(JSON.parse(String(init.body)))
    if (requests.length === 1) throw new TypeError('Response lost after commit')
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  })
  await render(<ActivateWorldForm endpointId={value.endpointId} commandId="original-grant" name="Original world" />)
  await act(async () => { container!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
  for (const [name, text] of Object.entries({ repositoryUrl: repository.url, repositoryCommit: repository.commit, repositoryCredential: repository.credentialId }))
    await enter(container!.querySelector<HTMLInputElement>(`input[name=${name}]`)!, text)
  await click('Activate in this coordinator')
  await enter(container!.querySelector('input')!, 'Edited after response loss')
  await enter(container!.querySelector<HTMLInputElement>('input[name=repositoryCommit]')!, 'b'.repeat(40))
  await enter(container!.querySelector<HTMLInputElement>('input[name=repositoryUrl]')!, 'https://example.invalid/other.git')
  await click('Retry submitted change')
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0])
  expect(requests[0]).toMatchObject({ endpointId: value.endpointId, commandId: 'original-grant', name: 'Original world', repository })
  expect(container!.querySelector('[role=status]')!.textContent).toContain(value.id)
})

it('retains an exact selection outside the current page and requires an explicit change to select a newer generation', async () => {
  const original = world(), newer = { ...world('b'.repeat(64)), epoch: 2 }, change = vi.fn()
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(String(url).endsWith('/state') ? { load: { running: 0 } } : { items: [newer], nextOffset: null })))
  await render(<WorldSelector value={original.id} change={change} />)
  expect(container!.querySelector('select')!.value).toBe(original.id)
  expect(change).not.toHaveBeenCalled()
  await act(async () => {
    const select = container!.querySelector('select')!
    select.value = newer.id; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(change).toHaveBeenCalledWith(newer.id)
})

it('retries the original revocation revision after a lost reply and directs receipt reads to that world', async () => {
  let value = world()
  value.repository = { url: 'https://example.invalid/source.git', commit: 'c'.repeat(40), username: 'x-access-token' }
  const requests: { path: string; body?: any }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === 'state') return new Response(JSON.stringify({ load: { running: 0 } }))
    requests.push({ path, body })
    if (path.endsWith('/revoke')) {
      value = { ...value, ready: false, enabled: false, revision: 2 }
      if (requests.filter(item => item.path.endsWith('/revoke')).length === 1) throw new TypeError('Response lost after commit')
      return new Response(JSON.stringify(value))
    }
    return new Response(JSON.stringify(path.includes('/execution') ? { items: [], total: 0, nextOffset: null } : { items: [value], nextOffset: null }))
  })
  await render(<WorldPoolPanel />)
  expect(container!.textContent).toContain(value.repository.url)
  expect(container!.textContent).toContain(value.repository.commit)
  await enter(container!.querySelector('textarea')!, 'Retire this machine')
  await click('Revoke this execution world')
  await click('Refresh')
  expect(button('Revoke this execution world')).toBeUndefined()
  await click('Retry submitted change')
  const revocations = requests.filter(item => item.path.endsWith('/revoke'))
  expect(revocations).toHaveLength(2); expect(revocations[1]).toEqual(revocations[0])
  expect(revocations[1]!.body).toMatchObject({ revision: 1, reason: 'Retire this machine' })
  await click(en['execution.title']!)
  expect(requests.some(item => item.path.startsWith(`worlds/${value.id}/execution`))).toBe(true)
})
