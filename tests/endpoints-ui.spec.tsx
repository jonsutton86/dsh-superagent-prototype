// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { EndpointManagement } from '../src/client/endpoints.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime } from './fixtures/host.ts'
import { remoteFixture } from './fixtures/remote.ts'
import type { ResourceStatus } from '../src/remote/resource-model.ts'

const cleanup: (() => Promise<unknown>)[] = []
let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove()
  vi.unstubAllGlobals()
  for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; vi.restoreAllMocks()
})
const button = (label: string, within: ParentNode = container!) => [...within.querySelectorAll('button')].find(node => node.textContent === label)
async function click(label: string, within?: ParentNode) {
  expect(button(label, within), label).toBeTruthy()
  await act(async () => { button(label, within)!.click() })
}
async function enter(label: string, value: string, within: ParentNode = container!) {
  const input = [...within.querySelectorAll('label')].find(node => node.firstChild?.textContent === label)!.querySelector('input,textarea')!
  const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function fixture(resources?: ResourceStatus) {
  const h = await remoteFixture(cleanup), host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  if (resources) vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), resources })
  cleanup.push(() => host.stop())
  const nativeFetch = globalThis.fetch, requests: { method: string; path: string; body?: unknown }[] = []
  let lose = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(h.url)) return nativeFetch(url, init)
    const path = String(url).replace('/orchestrator/api/', ''), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, body })
    const response = await host.api(method, path, body)
    if (lose && method === 'POST' && path.endsWith('/commands')) { lose = false; throw new TypeError('Operator response lost after commit') }
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)}><EndpointManagement /></PanelProvider>))
  await enter('Endpoint name', 'Research machine')
  await enter('Pinned endpoint UUID', h.endpoint.journal.id)
  await enter('Endpoint origin', h.url)
  await enter('Local administrator credential file path', h.connection.credentialFile)
  await click('Register endpoint')
  await vi.waitFor(() => expect(button('Manage endpoint')).toBeTruthy())
  await click('Manage endpoint')
  await vi.waitFor(() => expect(button('Create workspace grant')).toBeTruthy())
  return Object.assign(h, { host, requests, loseOperatorResponse: () => { lose = true } })
}

it('shows configured resource limits and kernel-derived command receipts without claiming current usage from registration metadata', async () => {
  const policy = { cgroupRoot: '/private/delegated', pool: { cpuPercent: 200, memoryBytes: 1024 ** 3, processes: 128 },
    command: { cpuPercent: 100, memoryBytes: 256 * 1024 ** 2, processes: 32 } }
  const h = await fixture({ kind: 'linux-cgroup-v2', policy, ready: true, memoryBytes: 10, processes: 1, activeScopes: 1 })
  expect(container!.textContent).toContain('Pool: 2 CPUs · 1024 MiB RAM · 128 processes')
  expect(container!.textContent).toContain('Per command: 1 CPUs · 256 MiB RAM · 32 processes')
  expect(container!.textContent).not.toContain('/private/delegated')
  const at = new Date().toISOString()
  h.endpoint.journal.saveJob({ id: 'quota-receipt', grantId: h.enrolled.grant.id, epoch: 1, revision: 1, fingerprint: 'proof', phase: 'settled',
    createdAt: at, updatedAt: at, request: { ...h.spawn('true'), requestId: 'quota-receipt' }, cancelRequested: false, quiescent: true,
    resources: { scopes: 1, complete: true, cpuMicroseconds: 1500000, throttledPeriods: 2, oomKills: 1, processLimitEvents: 3 } })
  await click('Refresh')
  await vi.waitFor(() => expect(container!.textContent).toContain('CPU time 1.500 s · Out-of-memory kills 1 · Process-limit refusals 3'))
  expect(container!.textContent).toContain('CPU throttling was observed')
})

it('registers an endpoint, preserves a lost submission ID and generates an inspectable profile without exposing credentials', async () => {
  const h = await fixture()
  expect(container!.querySelector('input[type=password]')).toBeNull()
  await enter('Workspace identifier', 'ui-research')
  h.loseOperatorResponse(); await click('Create workspace grant')
  await vi.waitFor(() => expect(button('Retry submitted change')).toBeTruthy())
  await click('Refresh'); await click('Retry submitted change')
  await vi.waitFor(() => expect(button('Generate remote Harness profile')).toBeTruthy())
  const submissions = h.requests.filter(item => item.method === 'POST' && item.path.endsWith('/commands'))
  expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0])
  const grants = h.endpoint.journal.grants().filter(grant => grant.workspace === 'ui-research')
  expect(grants).toHaveLength(1)
  vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  await click('Generate remote Harness profile')
  await vi.waitFor(() => expect(container!.textContent).toContain('Configuration saved; execution has not started'))
  expect(container!.textContent).toContain('dsh-superagent/remote-world')
  expect(container!.textContent).toContain('YOUR_DEDICATED_PROFILE')
  expect(container!.textContent).not.toContain(await readFile(h.connection.credentialFile, 'utf8'))
  expect(container!.textContent).not.toContain(h.endpoint.journal.credential(grants[0]!.id, 1))
})

it('shows an ambiguous endpoint mutation and retries its durable ID from the administration receipt', async () => {
  const h = await fixture(), rpc = h.endpoint.rpc.bind(h.endpoint)
  let lose = true
  vi.spyOn(h.endpoint, 'rpc').mockImplementation(async (principal, input) => {
    const value = await rpc(principal, input)
    if (lose && (input as any).op === 'grant.create') { lose = false; throw new Error('Lost after endpoint commit') }
    return value
  })
  await enter('Workspace identifier', 'ui-uncertain'); await click('Create workspace grant')
  await vi.waitFor(() => expect(button('Retry original request')).toBeTruthy())
  expect(container!.textContent).toContain('Outcome unconfirmed')
  const original = h.host.runtime.endpoints.commands(h.endpoint.journal.id).items[0]!
  await click('Close endpoint'); await click('Manage endpoint')
  await vi.waitFor(() => expect(button('Retry original request')).toBeTruthy())
  await click('Retry original request')
  await vi.waitFor(() => expect(button('Retry original request')).toBeUndefined())
  expect(h.host.runtime.endpoints.commands(h.endpoint.journal.id).items[0]).toMatchObject({ id: original.id, phase: 'done' })
  expect(h.endpoint.journal.grants().filter(grant => grant.workspace === 'ui-uncertain')).toHaveLength(1)
})
