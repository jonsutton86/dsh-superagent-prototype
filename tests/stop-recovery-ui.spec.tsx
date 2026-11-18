// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StopRecovery, StopHoldNotice, readStopAttestation, saveStopAttestation, type PendingStopAttestation } from '../src/client/stop-recovery.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import type { StopAttestationReceipt, StopDetail } from '../src/executor/stop-model.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement, detail: StopDetail
let receipt: StopAttestationReceipt | null, lookupUnavailable: boolean, losePost: boolean, refusePost: boolean
const sent: { path: string; method: string; body: unknown }[] = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function pending(): PendingStopAttestation { return { schema: 1, origin: location.origin, ticketId: 'ticket', assignmentId: 'original-assignment', stopId: 'stop-original',
  request: { schema: 1, requestId: 'original-confirmation', expectedRevision: 1, executionBindingHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64), confirmed: true, note: 'Inspected the original host and process range.' } } }
function result(original: PendingStopAttestation, phase: StopAttestationReceipt['phase'] = 'accepted'): StopAttestationReceipt {
  return { version: 1, requestId: original.request.requestId, stopId: original.stopId, ticketId: original.ticketId, assignmentId: original.assignmentId,
    request: original.request, requestHash: 'c'.repeat(64), phase, acceptedAt: '2026-01-01T00:00:00.000Z',
    settledAt: phase === 'pending' ? null : '2026-01-01T00:00:01.000Z', reason: 'Original scoped evidence recorded', observedRevision: 2 }
}
beforeEach(() => {
  sessionStorage.clear(); sent.length = 0; receipt = null; lookupUnavailable = false; losePost = false; refusePost = false
  detail = { id: 'stop-original', ticketId: 'ticket', assignmentId: 'original-assignment', sessionId: 'worker-ticket', revision: 1,
    scope: 'all', state: 'unknown', reason: 'Original work is not confirmed stopped', executionBindingHash: 'a'.repeat(64), scopeHash: 'b'.repeat(64),
    proof: null, legacy: false, execution: { directory: '/original-host/work', mode: 'local' }, world: null,
    createdAt: '2026-01-01T00:00:00.000Z', settledAt: null, targets: { jobIds: ['original-job'], sessions: ['worker-ticket'] }, canRecheck: true, canAttest: true }
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ path, method, body })
    if (path.endsWith('/state')) return json({ load: { running: 0 } })
    if (path.includes('/attestations/')) return lookupUnavailable ? new Response('', { status: 404 }) : json({ receipt, current: detail })
    if (path.includes('/attestations')) return json({ items: receipt ? [receipt] : [], nextCursor: null })
    if (path.endsWith('/attest')) {
      receipt = result({ ...pending(), request: body }, refusePost ? 'refused' : 'accepted')
      detail = refusePost ? { ...detail, revision: 2 } : { ...detail, revision: 2, canAttest: false, state: 'quiet', proof: 'operator' }
      if (losePost) throw new TypeError('Response lost after commit')
      return json({ receipt, current: detail })
    }
    if (path.endsWith('/recheck')) return json({ observationRequested: true, current: detail })
    return json(detail)
  })
  container = document.createElement('div'); document.body.append(container)
})
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function mount() {
  if (root) await act(async () => root!.unmount())
  root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}>
    <StopRecovery ticketId="ticket" assignmentId="original-assignment" stopId="stop-original" changed={() => {}} />
  </PanelProvider>))
  await wait(() => expect(container.textContent).toContain('/original-host/work'))
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); check() }) }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  expect(button, label).toBeTruthy(); await act(async () => button!.click())
}
async function enterNote() {
  const field = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Inspected the original host and process range.')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
}

it('retains an ambiguous request through unmounted404 and remount, then only reads the exact committed receipt', async () => {
  lookupUnavailable = true; losePost = true
  await mount(); await enterNote(); await click('Record local stop confirmation')
  await wait(() => expect(readStopAttestation('ticket').pending).toBeDefined())
  const original = readStopAttestation('ticket').pending!
  await wait(() => expect(container.textContent).toContain('The original request and scope are retained'))
  expect(sent.filter(item => item.method === 'POST')).toHaveLength(1)
  expect(container.querySelector('textarea')?.disabled ?? true).toBe(true)
  await mount(); expect(readStopAttestation('ticket').pending).toEqual(original)
  lookupUnavailable = false
  await click('Read original receipt')
  await wait(() => expect(readStopAttestation('ticket').pending).toBeUndefined())
  expect(sent.filter(item => item.method === 'POST')).toHaveLength(1)
  expect(sent.some(item => item.path.endsWith('/attestations/' + original.request.requestId))).toBe(true)
  expect(container.textContent).toContain('Operator stop confirmation recorded')
})

it('on absent receipt resubmits only the saved body and original revision after the displayed evidence changes', async () => {
  const original = pending(); saveStopAttestation(original); detail = { ...detail, revision: 7 }
  await mount(); await wait(() => expect(container.textContent).toContain('No receipt observed yet'))
  expect(sent.every(item => item.method === 'GET')).toBe(true)
  await click('Resubmit original request')
  await wait(() => expect(readStopAttestation('ticket').pending).toBeUndefined())
  expect(sent.find(item => item.method === 'POST')?.body).toEqual(original.request)
  expect(receipt?.request.expectedRevision).toBe(1)
})

it('refuses to send if browser storage cannot retain the original request', async () => {
  await mount(); await enterNote()
  const storage = sessionStorage
  vi.stubGlobal('sessionStorage', { getItem: storage.getItem.bind(storage), clear: storage.clear.bind(storage),
    removeItem: storage.removeItem.bind(storage), setItem: () => { throw new Error('Storage unavailable') } })
  await click('Record local stop confirmation')
  expect(sent.every(item => item.method === 'GET')).toBe(true)
  expect(container.textContent).toContain('Storage unavailable')
})

it('does not overwrite another unresolved request saved after this form mounted', async () => {
  await mount(); await enterNote()
  const original = pending(); saveStopAttestation(original)
  await click('Record local stop confirmation')
  expect(sent.every(item => item.method === 'GET')).toBe(true)
  expect(readStopAttestation('ticket').pending).toEqual(original)
  expect(container.textContent).toContain('A different original confirmation request must be recovered first')
})

it('retains a stale-review refusal receipt and permits fresh explicit review without automatic replacement', async () => {
  await mount(); await enterNote(); refusePost = true
  // The server's evidence changed after the last GET, before this original request arrived.
  detail = { ...detail, revision: 2 }
  await click('Record local stop confirmation')
  await wait(() => expect(readStopAttestation('ticket').pending).toBeUndefined())
  expect(receipt).toMatchObject({ phase: 'refused', request: { expectedRevision: 1 } })
  expect(sent.filter(item => item.method === 'POST')).toHaveLength(1)
  expect(container.querySelector('textarea')?.disabled).toBe(false)
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  expect(container.textContent).toContain('The original confirmation request was refused')
})

it('keeps wrong-target and malformed receipts uncertain without replacing the original request', async () => {
  const original = pending(); saveStopAttestation(original); receipt = { ...result(original), assignmentId: 'different-assignment' }
  await mount(); await wait(() => expect(container.textContent).toContain('does not match the original request'))
  expect(readStopAttestation('ticket').pending).toEqual(original)
  expect(sent.every(item => item.method === 'GET')).toBe(true)
})

it('rechecks only the original scope and describes descendants-only coverage without confirming handed-off jobs', async () => {
  detail = { ...detail, scope: 'descendants', canAttest: false }
  await mount(); await click('Observe original scope again')
  expect(sent.filter(item => item.method === 'POST')).toEqual([{ path: '/orchestrator/api/tickets/ticket/assignments/original-assignment/stops/stop-original/recheck',
    method: 'POST', body: { expectedRevision: 1, executionBindingHash: detail.executionBindingHash, scopeHash: detail.scopeHash } }])
  expect(container.textContent).toContain('intentionally handed-off jobs are preserved')
  expect(container.textContent).toContain('not a new cancellation or a durable per-request receipt')
})

it('shows original hold and pending replacement separately, including for a single ended assignment', async () => {
  root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}><StopHoldNotice ticketId="ended-ticket" hold={{
    held: true, count: 1, revision: 'a'.repeat(64), pendingAssignmentId: 'saved-replacement', pendingInputs: 2,
    originals: [{ id: 'original-stop', assignmentId: 'original-assignment', revision: 1, scope: 'all', state: 'unknown', proof: null, legacy: false }], truncated: false,
  }} /></PanelProvider>))
  expect(container.textContent).toContain('Original work is not confirmed stopped')
  expect(container.textContent).toContain('Pending replacement assignment: saved-replacement')
  expect(container.textContent).toContain('2 saved message(s)')
})
