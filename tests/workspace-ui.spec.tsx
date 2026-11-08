// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MissionsPage } from '../src/client/missions.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import type { Route } from '../src/client/route.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLElement | undefined
function field<T extends HTMLElement>(label: string): T {
  const parent = [...container!.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)
  const input = parent?.querySelector('input,textarea,select')
  if (!input) throw new Error(`No field ${label}`)
  return input as T
}
async function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove()
  await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

it('creates, delegates, reviews and completes a mission through rendered forms and actual management routes', async () => {
  host = await startRuntime()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', '')
    const result = await host!.api(init?.method ?? 'GET', path, init?.body ? JSON.parse(String(init.body)) : undefined)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  let route: Route = { page: 'missions' }
  const render = () => root!.render(<PanelProvider t={translator(en)} navigate={next => { route = next; render() }}>
    <MissionsPage key={route.id ?? 'list'} id={route.id} /></PanelProvider>)
  const text = () => container!.textContent ?? ''
  const click = async (label: string) => {
    const button = [...container!.querySelectorAll('button')].find(button => button.textContent === label)
    expect(button, label).toBeTruthy()
    await act(async () => { button!.click() })
  }
  await act(async () => render())
  await click('New mission')
  await enter(field<HTMLInputElement>('Mission title'), 'Research workspace')
  await enter(field<HTMLTextAreaElement>('Objective'), 'Produce a durable research brief')
  await enter(field<HTMLTextAreaElement>('Acceptance criteria'), 'Review the evidence and the final brief')
  await click('Create mission')
  await vi.waitFor(() => expect(text()).toContain('Break the objective into actions'))
  await click('Add action')
  await enter(field<HTMLInputElement>('Action title'), 'Prepare the brief')
  await enter(field<HTMLTextAreaElement>('Instructions'), 'Inspect the project and write the brief')
  const form = field<HTMLInputElement>('Action title').closest('form')!
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(text()).toContain('Run action'))
  await click('Run action')
  await host.runtime.idle()
  await vi.waitFor(() => expect(text()).toContain('Working'))
  const mission = host.runtime.workspace.get(route.id!), ticketId = mission.actions[0]!.ticket!.id
  await host.runTool(`worker-${ticketId}`, 'orchestrator_report', { state: 'ready', summary: 'Research brief written with evidence' })
  // Remounting proves the view comes from persisted host state rather than optimistic client state.
  await act(async () => { root!.unmount(); root = createRoot(container!); render() })
  await vi.waitFor(() => expect(text()).toContain('Research brief written with evidence'))
  expect(text()).toContain('Review result')
  const completeButton = [...container.querySelectorAll('button')].find(button => button.textContent === 'Complete mission')!
  expect(completeButton.disabled).toBe(true)
  await enter(field<HTMLTextAreaElement>('Result or evidence you reviewed'), 'Read the brief and checked its evidence')
  await click('Accept result')
  await vi.waitFor(() => expect(text()).toContain('1 of 1 actions complete'))
  await click('Complete mission')
  await vi.waitFor(() => expect(text()).toContain('Reopen mission'))
  expect(host.runtime.workspace.get(route.id!).status).toBe('completed')
})
