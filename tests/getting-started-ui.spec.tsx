// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { ApiResponse } from '../src/app/api.ts'
import { en } from '../src/client/locales.ts'
import { parseRoute } from '../src/client/route.ts'
import { usePanel, mount, remount, settle, all, click, tab, text, at } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
type Overrides = Partial<{ [K in 'GET models' | 'GET inbox/setup' | 'GET missions']: () => ApiResponse<K> | 'fail' }>
function override(reads: Overrides) {
  const fallback = globalThis.fetch, requests: { method: string; path: string }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://127.0.0.1').pathname.replace('/orchestrator/api/', ''), method = init?.method ?? 'GET'
    requests.push({ method, path })
    const key = `${method} ${path}` as keyof Overrides, read = reads[key]
    if (!read) return fallback(url, init)
    const value = read()
    return new Response(JSON.stringify(value === 'fail' ? { error: 'Catalog temporarily unavailable' } : value), { status: value === 'fail' ? 503 : 200 })
  })
  return requests
}
const catalog = (): ApiResponse<'GET models'> => ({ default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  groups: [], routableProviders: [], failures: [] })
const listed = (): ApiResponse<'GET models'> => ({ ...catalog(), groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] }], routableProviders: ['deepseek-official'] })
const start = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === en['guide.start'])!
async function refresh() { await act(async () => document.dispatchEvent(new Event('visibilitychange'))); await settle() }

it('opens the existing inbox draft without dispatching, filling a prompt, or requesting credentials', async () => {
  const requests = override({ 'GET models': catalog })
  await mount(en); await click(en['guide.open'])
  expect(tab(en['tab.guide']).getAttribute('aria-selected')).toBe('true')
  expect(text()).toContain(en['guide.modelUnlisted']); expect(text()).toContain(en['guide.catalogHint'])
  expect(document.querySelector('input[type="password"]')).toBeNull()
  expect(start().disabled).toBe(false) // Catalog omission is not an authority gate for custom models.
  await click(start())
  expect(tab(en['tab.inbox']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('')
  expect(text()).toContain(en['inbox.settings'])
  expect(requests.every(request => request.method === 'GET')).toBe(true)
  expect(parseRoute({ page: 'inbox', query: { compose: true } })).toEqual({ page: 'inbox', query: { compose: true } })
  expect(parseRoute({ page: 'inbox', id: 'existing', query: { compose: true } })).toEqual({ page: 'inbox', id: 'existing' })
  expect(parseRoute({ page: 'inbox', query: { compose: 'true' } })).toEqual({ page: 'inbox', query: undefined })
  await remount(en); expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('')
  await click(en.cancel); await remount(en); expect(document.querySelector('textarea')).toBeNull()
  expect(requests.every(request => request.method === 'GET')).toBe(true)
})

it('shows the task override separately from the default routing model and refreshes after provider configuration', async () => {
  let models = catalog()
  server.settings.executor.model = { provider: 'custom', model: 'private-model' }
  override({ 'GET models': () => models }); at({ page: 'guide' }); await mount(en)
  expect(text()).toContain('custom / private-model'); expect(text()).toContain('deepseek-official / deepseek-flash')
  expect(text()).not.toContain(en['guide.modelListed'])
  models = listed(); await refresh()
  expect(text()).toContain(en['guide.modelListed']); expect(text()).toContain(en['guide.modelUnlisted'])
  await click(en['guide.workerSettings'])
  expect(tab(en['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(JSON.parse(sessionStorage.getItem('dsh-superagent/route')!).route.query.group).toBe('execution')
})

it('keeps independent setup steps usable on catalog failure without presenting stale catalog success', async () => {
  let fail = false
  const requests = override({ 'GET models': () => fail ? 'fail' : listed() })
  at({ page: 'guide' }); await mount(en); expect(text()).toContain(en['guide.modelListed'])
  fail = true; await refresh()
  expect(text()).toContain(en['guide.modelUnknown']); expect(text()).not.toContain(en['guide.modelListed'])
  expect(start().disabled).toBe(false)
  await click(all('.dt-guide-actions button').find(button => button.textContent === en['tab.personas'])!)
  expect(tab(en['tab.personas']).getAttribute('aria-selected')).toBe('true')
  expect(requests.every(request => request.method === 'GET')).toBe(true)
})

it('guides explicit managed selection when no default exists and disables task entry during a pause', async () => {
  override({ 'GET models': catalog, 'GET inbox/setup': () => ({ defaultEnvironment: { available: false, problem: 'Select a managed world' } }) })
  at({ page: 'guide' }); await mount(en)
  expect(text()).toContain(en['guide.chooseWorld']); expect(start().disabled).toBe(false)
  server.settings.paused = true; await refresh()
  expect(text()).toContain(en['guide.paused']); expect(start().disabled).toBe(true)
  await click(en['guide.executionControls']); expect(tab(en['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('keeps task entry unavailable while the host is offline and recovers without changing settings', async () => {
  server.down = true; at({ page: 'guide' }); await mount(en)
  expect(start().disabled).toBe(true)
  expect(text()).toContain(en['guide.environmentUnknown'])
  server.down = false; await refresh()
  expect(start().disabled).toBe(false)
  expect(server.requests.every(request => request.method === 'GET')).toBe(true)
})

it('shows persisted mission review state and removes stale success when its refresh fails', async () => {
  let fail = false
  const requests = override({ 'GET models': listed, 'GET missions': () => fail ? 'fail' : { items: [
    { id: 'ready', title: 'Ready for review', objective: 'A result', status: 'active', completed: 0, total: 1, needsReview: false, updatedAt: '2026-11-09T00:00:00Z' },
    { id: 'changed', title: 'Changed evidence', objective: 'A result', status: 'completed', completed: 1, total: 1, needsReview: true, updatedAt: '2026-11-09T00:00:00Z' },
    { id: 'done', title: 'Accepted result', objective: 'A result', status: 'completed', completed: 1, total: 1, needsReview: false, updatedAt: '2026-11-09T00:00:00Z' },
  ], nextOffset: null } })
  at({ page: 'guide' }); await mount(en)
  const items = all('.dt-guide-missions li')
  expect(items[0]!.textContent).toContain('Active: 0/1 actions reviewed.')
  expect(items[1]!.textContent).toContain(en['guide.reviewAgain'])
  expect(items[2]!.textContent).toContain(en['guide.missionComplete'])
  fail = true; await refresh()
  expect(text()).toContain(en['guide.missionsUnknown']); expect(document.querySelector('.dt-guide-missions')).toBeNull()
  expect(requests.every(request => request.method === 'GET')).toBe(true)
})
