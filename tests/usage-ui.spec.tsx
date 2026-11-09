// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { UsagePage } from '../src/client/usage.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { parseRoute } from '../src/client/route.ts'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('edits scoped budgets through real routes, retries a committed request, and reconciles an unpriced call', async () => {
  host = await startRuntime(); await host.api('POST', 'executor/pause', { paused: true })
  const usage = host.runtime.usage, owner = { sessionId: 'worker-task', root: 'worker-task', role: 'worker' as const, missionId: 'mission' }
  const original = usage.begin(owner, 'test-provider', 'test-model', 'conversation', 100)
  usage.settle(original.id, 'stop', { inputTokens: 10, outputTokens: 5 })
  let lose = true; const submissions: unknown[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined
    const result = await host!.api(init?.method ?? 'GET', path, body)
    if (path === 'usage' && init?.method === 'PUT') { submissions.push(body); if (lose) { lose = false; throw new Error('Lost response after commit') } }
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const render = () => root!.render(<PanelProvider t={translator(en)}><UsagePage scope="mission" subject="mission" /></PanelProvider>)
  const click = async (text: string) => {
    const button = [...container!.querySelectorAll('button')].find(item => item.textContent === text)
    expect(button, text).toBeTruthy(); await act(async () => { button!.click() })
  }
  const enter = async (name: string, value: string) => {
    const element = container!.querySelector(`form [name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement
    expect(element, name).toBeTruthy()
    await act(async () => {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await act(async () => render())
  expect(container.textContent).toContain('Tracking since'); expect(container.textContent).toContain('Unreported')
  await click('Add limit'); await enter('title', 'Mission allowance'); await enter('calls', '1'); await click('Save')
  expect(container.textContent).toContain('Cannot reach the dsh-superagent service'); await click('Retry original request')
  expect(submissions).toHaveLength(2); expect(submissions[0]).toEqual(submissions[1])
  expect(usage.configuration().budgets[0]!.scope).toEqual({ kind: 'mission', id: 'mission' })
  expect(() => usage.begin(owner, 'test-provider', 'test-model', 'conversation', 100)).toThrow('Model call limit')
  expect(container.textContent).toContain('Allowance exhausted')
  await click('Reconcile usage'); await enter('input', '10'); await enter('output', '5'); await enter('cost', '0.000125'); await enter('note', 'Verified provider record 123')
  await click('Record reconciliation')
  expect(usage.get(original.id)).toMatchObject({ phase: 'reconciled', cost: 125, tokens: { inputTokens: 10, outputTokens: 5 } })
  expect(container.textContent).toContain('Verified provider record 123')
  await click('Add price'); await enter('provider', 'test-provider'); await enter('model', 'test-model')
  for (const name of ['input', 'output', 'cacheRead', 'cacheWrite']) await enter(name, '0.5')
  await enter('note', 'Synthetic price source'); await click('Save')
  expect(usage.configuration().prices[0]!.input).toBe(500000)
  await click('Add price'); await enter('provider', 'second-provider'); await enter('model', 'test-model')
  for (const name of ['input', 'output', 'cacheRead', 'cacheWrite']) await enter(name, '0.75')
  await enter('note', 'Second synthetic price'); await click('Save')
  const priceButtons = [...container.querySelectorAll('button')].filter(item => item.textContent === 'Edit price')
  await act(async () => { priceButtons[0]!.click() })
  expect((container.querySelector('input[name="provider"]') as HTMLInputElement).value).toBe('test-provider')
  await act(async () => { priceButtons[1]!.click() })
  expect((container.querySelector('input[name="provider"]') as HTMLInputElement).value).toBe('second-provider')
  await enter('output', '2'); await click('Save')
  expect(usage.configuration().prices.find(item => item.provider === 'second-provider')!.output).toBe(2000000)
  expect(usage.configuration().prices.find(item => item.provider === 'test-provider')!.output).toBe(500000)
  expect((await host.api('GET', 'usage/versions/1')).body).toMatchObject({ revision: 1, prices: [] })
  expect((await host.api('GET', 'usage?scope=mission')).status).toBe(400)
  expect(parseRoute({ page: 'usage', query: { scope: 'mission' } })).toEqual({ page: 'usage' })
  expect(parseRoute({ page: 'usage', query: { scope: 'schedule', subject: 'scheduled' } })).toEqual({ page: 'usage', query: { scope: 'schedule', subject: 'scheduled' } })
})
