// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WatchdogConsole } from '../src/supervision/console.tsx'
import { watchdogServer } from './fixtures/watchdog.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: Awaited<ReturnType<typeof watchdogServer>> | undefined, root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); host = undefined; root = undefined; container = undefined })
async function waitFor(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); check() })
}
async function mount() {
  if (!container) { container = document.createElement('div'); document.body.append(container) }
  else await act(async () => root?.unmount())
  root = createRoot(container); await act(async () => root!.render(<WatchdogConsole />))
}
const text = () => container!.textContent!
async function click(label: string) {
  let button: HTMLButtonElement | undefined
  await vi.waitFor(() => { button = [...container!.querySelectorAll('button')].find(value => value.textContent === label || value.querySelector('strong')?.textContent === label); expect(button, label).toBeTruthy() })
  await act(async () => button!.click())
}
function connect(loseFirst = false) {
  const requests: string[] = []; let lose = loseFirst
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const response = await host!.request(url, init)
    if (url.endsWith('/acknowledgements')) {
      requests.push(String(init.body))
      if (lose) { lose = false; await response.text(); throw new TypeError('Response lost after commit') }
    }
    return response
  })
  return requests
}

it('reviews an incident during a main outage and replays an unconfirmed acknowledgement after remount against changed evidence', async () => {
  host = await watchdogServer(); host.journal.unavailable(host.now, 'Main service offline')
  const requests = connect(true)
  await mount(); await click('Prepare release evidence')
  await waitFor(() => expect(text()).toContain('Waiting for the target platform.'))
  expect(text()).toContain('Unreachable'); expect(text()).toContain('Main service offline')
  const textarea = container!.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Reviewing platform choices.')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Acknowledge evidence')
  await waitFor(() => expect(text()).toContain('Response lost after commit'))
  expect(host.journal.counts()).toMatchObject({ open: 1, unacknowledged: 0 })
  const incident = host.journal.open()[0]!
  host.journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'drift', evidence: 'New scope mismatch observed.' }, host.now + 1)
  await mount(); await click('Retry acknowledgement')
  await waitFor(() => expect(text()).toContain('Evidence acknowledged.')); expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1])
  expect(host.journal.history(incident.id).items.filter(item => item.kind === 'acknowledged')).toHaveLength(1)
  expect(host.journal.counts()).toMatchObject({ open: 1, unacknowledged: 1 })
  expect(sessionStorage.getItem('dsh.watchdog.ack.v1')).toBeNull()
  await click('Prepare release evidence')
  await waitFor(() => expect(text()).toContain('New evidence since acknowledgement'))
  expect(text()).toContain('New scope mismatch observed.')
})

it('refuses acknowledgement of evidence changed after rendering and escapes observed task content', async () => {
  host = await watchdogServer(); connect()
  host.snapshot.tickets[0]!.title = '<img src=x onerror=alert(1)> Suspicious task'
  host.snapshot.tickets[0]!.revision = 'new-title'; host.journal.reconcile(host.snapshot, host.now + 1, 1000, 3600000)
  await mount(); await click('<img src=x onerror=alert(1)> Suspicious task')
  await waitFor(() => expect(container!.querySelector('textarea')).not.toBeNull())
  expect(container!.querySelector('img')).toBeNull(); expect(container!.querySelector('script')).toBeNull()
  const incident = host.journal.open()[0]!
  host.journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'unknown', evidence: 'Evidence changed during review.' }, host.now + 2)
  await click('Acknowledge evidence')
  await waitFor(() => expect(text()).toContain('New evidence is available'))
  expect(host.journal.counts().unacknowledged).toBe(1)
  await waitFor(() => expect(text()).toContain('Evidence changed during review.'))
  await click('Acknowledge evidence')
  await waitFor(() => expect(host!.journal.counts().unacknowledged).toBe(0))
  expect(text()).toContain('Monitoring continues.')
})

it('pages incidents and history without treating a changed cursor as an empty successful page', async () => {
  host = await watchdogServer(); connect()
  host.snapshot.tickets = Array.from({ length: 60 }, (_, index) => ({ ...host!.snapshot.tickets[0]!, id: `many-${index}`, title: `Incident ${index}` }))
  host.journal.reconcile(host.snapshot, host.now + 1, 1000, 3600000)
  await mount(); await click('More incidents')
  await waitFor(() => expect(container!.querySelectorAll('.wd-list li')).toHaveLength(10))
  await click('Previous incidents')
  await waitFor(() => expect(container!.querySelectorAll('.wd-list li')).toHaveLength(50))
  const incident = host.journal.open()[0]!
  host.journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'unknown', evidence: 'Changed snapshot' }, host.now + 2)
  await click('More incidents')
  await waitFor(() => expect(text()).toContain('Incidents changed while paging'))
  await click('Refresh'); await click('Older events')
  await waitFor(() => expect(text()).toContain('Newer events'))
  expect(container!.querySelector('footer')!.textContent).toContain('Open incidents are retained')
})
