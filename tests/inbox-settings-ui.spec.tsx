// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { InboxPage } from '../src/client/inbox.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'
import { remoteFixture } from './fixtures/remote.ts'
let host: Host | undefined, root: Root | undefined, container: HTMLDivElement | undefined
const cleanup: (() => Promise<unknown>)[] = []
const rid = () => randomUUID()
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); host = undefined;
  for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks() })
const button = (label: string) => [...container!.querySelectorAll('button')].find(value => value.textContent === label)!
const settle = async (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); assertion() })
async function click(label: string) { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()) }
async function poll() { await act(async () => document.dispatchEvent(new Event('visibilitychange'))) }
async function mount(intercept?: (path: string, method: string, body: any, result: any) => Promise<void> | void) {
  const requests: any[] = []
  const network = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('/orchestrator/api/')) return network(url, init)
    const path = String(url).replace('/orchestrator/api/', ''), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (method === 'POST' && path === 'inbox') requests.push(body)
    const result = await host!.api(method, path, body); await intercept?.(path, method, body, result)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  let id: string | undefined
  const render = () => root!.render(<PanelProvider t={translator(en)} navigate={next => { id = next.id; render() }}><InboxPage key={id ?? 'list'} id={id} /></PanelProvider>)
  await act(async () => render()); await click('New task')
  const textarea = container.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Prepare the briefing'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  return requests
}
async function select(index: number, value: string) {
  await act(async () => { const input = container!.querySelectorAll('select')[index]!; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) })
}
it('keeps an exact persona version through catalog updates and retries a committed Send after that persona is archived', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const definition = { name: 'Evidence reader', description: '', instructions: 'Read carefully.', model: null, capabilities: ['read' as const], skills: [] }
  const persona = await host.runtime.personas.create({ requestId: rid(), definition }); let lose = true
  const requests = await mount(async (path, method, _body, result) => {
    if (path === 'inbox' && method === 'POST' && result.status === 200 && lose) {
      lose = false; host!.runtime.personas.archive(persona.id, { requestId: rid(), revision: 2, archived: true, reason: 'Retire new selection' })
      throw new TypeError('Response lost after commit')
    }
  })
  await select(0, `${persona.id}:1`)
  await settle(() => expect(container!.textContent).toContain('Read and search files'))
  await host.runtime.personas.update(persona.id, { requestId: rid(), revision: 1, definition: { ...definition, name: 'Future persona', instructions: 'Future version.' } })
  await poll(); await settle(() => expect(container!.querySelectorAll('select')[0]!.value).toBe(`${persona.id}:1`))
  await click('Start task'); expect(container!.querySelector('[role=alert]')).not.toBeNull()
  await poll(); await settle(() => expect(container!.textContent).toContain('This persona is archived'))
  expect(button('Start task').disabled).toBe(false)
  await click('Start task')
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(requests[0].persona).toEqual({ id: persona.id, version: 1 })
  expect(requests[0].expectedDefault).toBeTruthy(); expect(host.runtime.store.tickets.list()).toHaveLength(1)
  await settle(() => expect(container!.textContent).toContain('Settings for this task'))
  expect(container!.textContent).toContain('Evidence reader · Version 1'); expect(container!.textContent).not.toContain('Future persona')
  expect(container!.querySelector('select')).toBeNull()
})
it('retains the reviewed default until an authorization change is explicitly reviewed', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true }); const requests = await mount()
  await settle(() => expect(button('Start task').disabled).toBe(false))
  const before = host.runtime.environments.list().items.find(item => item.current)!
  await host.runtime.environments.update(before.id, { requestId: rid(), revision: before.revision, enabled: false, reason: 'Rotate authorization' })
  await host.runtime.environments.update(before.id, { requestId: rid(), revision: before.revision + 1, enabled: true, reason: 'Restore authorization' })
  await poll(); await settle(() => expect(container!.textContent).toContain('The default environment changed'))
  expect(button('Start task').disabled).toBe(true); expect(requests).toHaveLength(0)
  await click('Use current default'); expect(button('Start task').disabled).toBe(false)
  await click('Start task'); expect(requests[0].expectedDefault).toMatchObject({ environmentId: before.id, revision: before.revision + 2 })
})
it('lets the operator explicitly select a remote environment while the default remains unavailable', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true })
  const endpoint = await remoteFixture(cleanup)
  vi.spyOn(endpoint.endpoint, 'identity').mockReturnValue({ ...endpoint.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const registered = await host.runtime.endpoints.register({ requestId: rid(), endpointId: endpoint.endpoint.journal.id, url: endpoint.url, credentialFile: endpoint.connection.credentialFile, revision: 0, name: 'Remote test' })
  const command = await host.runtime.endpoints.submit(registered.id, { revision: registered.revision, request: { op: 'grant.create', requestId: rid(), owner: 'coordinator', workspace: 'selected-inbox', operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 } })
  const world = await host.runtime.worlds.activate({ requestId: rid(), endpointId: registered.id, commandId: command.id, name: 'Research workspace' })
  const settings = host.runtime.store.settings(); host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, directory: join(host.directory, 'not-enrolled') } })
  const requests = await mount()
  await settle(() => expect(container!.textContent).toContain('The default environment is unavailable'))
  expect(button('Start task').disabled).toBe(true)
  await select(1, world.id); await settle(() => expect(button('Start task').disabled).toBe(false)); await click('Start task')
  expect(requests[0].environment).toBe(world.id); expect(requests[0].expectedDefault).toBeUndefined()
  await settle(() => expect(container!.textContent).toContain('Settings for this task'))
  expect(container!.textContent).toContain('Research workspace')
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.list()[0]!
  expect(ticket.execution?.environment?.world).toBe(world.id)
  expect(() => host!.runtime.worlds.assertMounted(host!.ctx.agents.get(`worker-${ticket.id}` as never)!, world.id)).not.toThrow()
}, 15000)
