// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { EnvironmentsPage } from '../src/client/environments.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const button = (label: string) => [...container!.querySelectorAll('button')].find(button => button.textContent === label)
async function click(label: string) { expect(button(label), label).toBeTruthy(); await act(async () => { button(label)!.click() }) }
async function enter(label: string, text: string) {
  const element = [...container!.querySelectorAll('label')].find(node => node.firstChild?.textContent === label)!.querySelector('input,textarea')!
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function fixture(options: { lose?: boolean; newRoot?: boolean } = {}) {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  if (options.newRoot) {
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, directory: join(host.directory, 'next') } })
  }
  let lose = options.lose
  const requests: { method: string; path: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, body })
    const response = await host!.api(method, path, body)
    if (method === 'PUT' && path.startsWith('environments/') && lose) { lose = false; throw new TypeError('Response lost after commit') }
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)}><EnvironmentsPage /></PanelProvider>))
  await vi.waitFor(() => expect(container!.textContent).toContain('Configured workspace root'))
  return requests
}

it('retries the exact revoked grant after an ambiguous response and a refreshed UI, then authorizes only new work', async () => {
  const requests = await fixture({ lose: true }), env = host!.runtime.environments
  const record = env.list().items[0]!
  expect(container!.textContent).toContain('do not provide OS isolation')
  expect(button('Revoke execution')?.disabled).toBe(true)
  await enter('Reason for the grant change', 'Maintenance window')
  await click('Revoke execution')
  await vi.waitFor(() => expect(button('Retry submitted change')).toBeTruthy())
  await click('Refresh')
  await vi.waitFor(() => expect(button('Authorize new work')).toBeTruthy())
  await click('Retry submitted change')
  await vi.waitFor(() => expect(button('Retry submitted change')).toBeUndefined())
  const mutations = requests.filter(request => request.method === 'PUT')
  expect(mutations).toHaveLength(2); expect(mutations[1]).toEqual(mutations[0])
  expect(env.list().items[0]).toMatchObject({ id: record.id, revision: 2, enabled: false })
  await enter('Reason for the grant change', 'Maintenance complete')
  await click('Authorize new work')
  await vi.waitFor(() => expect(button('Revoke execution')).toBeTruthy())
  expect(env.list().items[0]).toMatchObject({ revision: 3, enabled: true })
})

it('enrolls a changed profile, surfaces failed identity proof, and explicitly replaces it', async () => {
  const requests = await fixture({ newRoot: true }), env = host!.runtime.environments
  await enter('Environment name', 'Research workspace')
  await click('Enroll environment')
  await vi.waitFor(() => expect(button('Enroll environment')).toBeUndefined())
  const record = env.list().items.find(record => record.current)!
  expect(record.name).toBe('Research workspace')
  expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({ root: env.list().currentRoot, mode: 'local' })
  await unlink(join(record.root, `.dsh-environment-${record.id}`))
  await click('Verify directory again')
  await vi.waitFor(() => expect(container!.querySelector('[role=alert]')?.textContent).toContain('ENOENT'))
  await click('Replace enrollment')
  expect(container!.textContent).toContain('Existing tasks are not transferred')
  await click('Replace and stop old tasks')
  await vi.waitFor(() => expect(env.list().items).toHaveLength(3))
  expect(env.list().items.find(item => item.id === record.id)?.retired).toBe(true)
  expect(env.ready()).toBe(true)
})
