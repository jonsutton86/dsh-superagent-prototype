// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionReceipts } from '../src/client/execution-receipts.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import type { ExecutionReceipt } from '../src/remote/effects.ts'
import { translator } from './fixtures/panel.tsx'

let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const button = (label: string) => [...container!.querySelectorAll('button')].find(node => node.textContent === label)
async function click(label: string) { expect(button(label), label).toBeTruthy(); await act(async () => button(label)!.click()) }
async function fixture(ticketId?: string) {
  const receipt: ExecutionReceipt = { id: 'original-command', world: 'a'.repeat(64), grantId: 'grant', epoch: 1, fingerprint: 'digest',
    kind: 'command', operation: 'job.spawn', target: '/work', program: 'bash', phase: 'unknown', quiescent: null,
    owner: { kind: 'assignment', ticketId: 'ticket-one', assignmentId: 'assignment-one', sessionId: 'worker-one', callId: 'call-one', tool: 'bash' },
    createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z' }
  const mutation: ExecutionReceipt = { ...receipt, id: 'file-change', kind: 'mutation', operation: 'fs.write', target: '/work/result.txt' }
  const requests: { path: string; method: string; body?: unknown }[] = []
  let lose = true
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method, body })
    if (path === 'state') return new Response(JSON.stringify({ load: { running: 0 } }))
    if (path.endsWith('/cancel')) {
      if (lose) { lose = false; throw new TypeError('Response lost; command may already be stopped') }
      receipt.quiescent = true
    }
    return new Response(JSON.stringify({ items: path.includes('offset=20') ? [{ ...receipt, id: 'older-receipt' }] : [receipt, mutation],
      total: 21, nextOffset: path.includes('offset=20') ? null : 20, blocked: receipt.quiescent === true ? 1 : 2 }))
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)}><ExecutionReceipts ticketId={ticketId} /></PanelProvider>))
  await vi.waitFor(() => expect(container!.textContent).toContain('original-command'))
  return requests
}

it('preserves the command ID and cancellation request across a lost response without claiming an unknown result succeeded', async () => {
  const requests = await fixture('ticket-one')
  expect(container!.textContent).toContain('Outcome unknown')
  expect(container!.textContent).toContain('Termination unconfirmed')
  expect(container!.querySelectorAll('[aria-label^="Cancel this command"]')).toHaveLength(1)
  await click('Cancel this command')
  expect(container!.querySelector('[role=alert]')?.textContent).toContain('Cannot reach')
  await click('Check remote status')
  await click('Cancel this command')
  const cancellations = requests.filter(item => item.path.endsWith('/cancel'))
  expect(cancellations).toHaveLength(2); expect(cancellations[1]).toEqual(cancellations[0])
  expect(cancellations[0]?.path).toBe('tickets/ticket-one/execution/original-command/cancel')
  expect(container!.textContent).toContain('Confirmed stopped')
  expect(container!.textContent).toContain('Outcome unknown')
  expect(button('Cancel this command')).toBeUndefined()
  expect(requests.filter(item => item.method === 'POST').every(item => /\/(cancel|refresh)$/.test(item.path))).toBe(true)
})

it('pages global receipts without losing their task and tool attribution', async () => {
  const requests = await fixture()
  expect(container!.textContent).toContain('assignment-one')
  expect(container!.textContent).toContain('call-one')
  await click('Next receipts')
  await vi.waitFor(() => expect(container!.textContent).toContain('older-receipt'))
  expect(requests.some(item => item.path === 'execution?offset=20&limit=20')).toBe(true)
  await click('Previous receipts')
  await vi.waitFor(() => expect(container!.textContent).toContain('original-command'))
  expect(button('Previous receipts')).toBeUndefined()
})
