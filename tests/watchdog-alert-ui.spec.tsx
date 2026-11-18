// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WatchdogAlertsConsole } from '../src/supervision/alerts-console.tsx'
import type { AlertList, AlertView } from '../src/supervision/alert-protocol.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); root = undefined; container = undefined })
const alert = (phase: AlertView['phase']): AlertView => ({ id: 'original-alert', routeId: 'operator', routeName: 'On-call receiver',
  subjectId: 'incident:one', incidentId: 'one', evidenceRevision: 'original-evidence', title: 'Worker needs attention',
  finding: 'blocked', createdAt: 1794334304000, updatedAt: 1794334304000, phase,
  payloadHash: 'a'.repeat(64), destinationHash: 'b'.repeat(64) })
const page = (items: AlertView[], cursor: string | null = null): AlertList => ({ routes: [{ id: 'operator', name: 'On-call receiver' }],
  items, cursor, capacity: { used: items.length, limit: 1000 } })
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
async function mount() {
  if (!container) { container = document.createElement('div'); document.body.append(container) }
  else await act(async () => root?.unmount())
  root = createRoot(container); await act(async () => root!.render(<WatchdogAlertsConsole revision={0} />))
}
async function waitFor(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); check() })
}
async function click(label: string) {
  let button: HTMLButtonElement | undefined
  await waitFor(() => { button = [...container!.querySelectorAll('button')].find(item => item.textContent === label); expect(button, label).toBeTruthy(); expect(button!.disabled).toBe(false) })
  await act(async () => button!.click())
}

it('exposes observation only for an unknown result and reuses its original ID after response loss and remount', async () => {
  let current = alert('unknown'), lose = true
  const commands: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      commands.push(url); expect(init.body).toBe('{}'); expect(init.headers).toMatchObject({ 'x-orchestrator-request': '1' })
      if (lose) { lose = false; throw new TypeError('lost response') }
      current = { ...current, phase: 'accepted' }; return reply(current)
    }
    return reply(page([current]))
  })
  await mount(); await waitFor(() => expect(container!.textContent).toContain('Outcome unknown'))
  expect(container!.textContent).not.toContain('Retry unsent alert'); expect(container!.textContent).not.toContain('Cancel unsent alert')
  await click('Check receipt'); await waitFor(() => expect(container!.textContent).toContain('The response was not confirmed'))
  await mount(); expect(commands).toHaveLength(1)
  await click('Check receipt'); await waitFor(() => expect(container!.textContent).toContain('Receiver accepted'))
  expect(commands).toEqual(['/watchdog/api/alerts/original-alert/observe', '/watchdog/api/alerts/original-alert/observe'])
  expect(container!.textContent).toContain('Receiver acceptance does not mean a person has read the alert')
})

it('refreshes a stale unsent action without offering a replacement or resend after the server reports unknown', async () => {
  let current = alert('prepared')
  const commands: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { commands.push(url); current = { ...current, phase: 'unknown' }; return reply({ error: 'alert_already_dispatched' }, 409) }
    return reply(page([current]))
  })
  await mount(); await click('Retry unsent alert')
  await waitFor(() => expect(container!.textContent).toContain('The alert changed or the operation was refused'))
  await waitFor(() => expect(container!.textContent).toContain('Outcome unknown'))
  expect(commands).toEqual(['/watchdog/api/alerts/original-alert/retry'])
  expect(container!.textContent).not.toContain('Retry unsent alert'); expect(container!.textContent).not.toContain('Cancel unsent alert')
})

it('cancels only an unsent original alert and renders untrusted labels as text', async () => {
  let current = { ...alert('prepared'), title: '<script>send another copy</script>', routeName: '<img src=x onerror=alert(1)>' }
  const commands: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { commands.push(url); current = { ...current, phase: 'cancelled' }; return reply(current) }
    return reply(page([current]))
  })
  await mount(); await click('Cancel unsent alert')
  await waitFor(() => expect(container!.textContent).toContain('Cancelled before dispatch'))
  expect(commands).toEqual(['/watchdog/api/alerts/original-alert/cancel'])
  expect(container!.querySelector('script')).toBeNull(); expect(container!.querySelector('img')).toBeNull()
  expect(container!.textContent).toContain('<script>send another copy</script>')
})

it('does not describe a server failure after dispatch as a refused action', async () => {
  let current = alert('prepared')
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { current = { ...current, phase: 'unknown' }; return reply({ error: 'watchdog_request_failed' }, 500) }
    return reply(page([current]))
  })
  await mount(); await click('Retry unsent alert')
  await waitFor(() => expect(container!.textContent).toContain('The response was not confirmed'))
  expect(container!.textContent).not.toContain('operation was refused')
  await waitFor(() => expect(container!.textContent).toContain('Outcome unknown'))
  expect(container!.textContent).not.toContain('Retry unsent alert')
})

it('pages retained receipts and keeps failures visible instead of showing an empty success', async () => {
  let fail = false
  vi.stubGlobal('fetch', async (url: string) => {
    if (fail) return reply({ error: 'unavailable' }, 503)
    return reply(url.includes('?cursor=older') ? page([{ ...alert('rejected'), id: 'older-alert', title: 'Older receipt' }]) : page([alert('accepted')], 'older'))
  })
  await mount(); await click('Older alerts'); await waitFor(() => expect(container!.textContent).toContain('Older receipt'))
  await click('Newer alerts'); await waitFor(() => expect(container!.textContent).toContain('Worker needs attention'))
  fail = true; await click('Refresh alerts'); await waitFor(() => expect(container!.textContent).toContain('Alert receipts could not be loaded'))
  expect(container!.textContent).not.toContain('No retained alert receipts')
})

it('shows deduplication capacity exhaustion even after terminal receipts have expired', async () => {
  const data = page([])
  data.capacity = { used: 0, limit: 1000, sourcesUsed: 1000, sourcesLimit: 1000, reservationsUsed: 1000, reservationsLimit: 1000 }
  vi.stubGlobal('fetch', async () => reply(data))
  await mount(); await waitFor(() => expect(container!.textContent).toContain('Alert capacity reached'))
  expect(container!.textContent).toContain('Retained alert records: 0 / 1000')
  expect(container!.textContent).toContain('Tracked alert subjects: 1000 / 1000')
})
