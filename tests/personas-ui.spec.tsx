// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PersonasPage } from '../src/client/personas.tsx'
import { MissionsPage } from '../src/client/missions.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const button = (label: string) => [...container!.querySelectorAll('button')].find(node => node.textContent === label)
async function click(label: string) { expect(button(label), label).toBeTruthy(); await act(async () => { button(label)!.click() }) }
function field(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const element = [...container!.querySelectorAll('label')].find(node => node.firstChild?.textContent === label)?.querySelector('input,textarea,select')
  if (!element) throw new Error(`Missing field ${label}`)
  return element as HTMLInputElement
}
async function enter(label: string, value: string) {
  const input = field(label), prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })
}
async function fixture() {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  let lose = false
  const requests: { method: string; path: string; body?: any }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, body })
    const response = await host!.api(method, path, body)
    if (lose && method === 'POST' && path === 'personas') { lose = false; throw new TypeError('Response lost after commit') }
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  const render = async (view: 'personas' | string = 'personas') => {
    await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}>{view === 'personas' ? <PersonasPage /> : <MissionsPage id={view} />}</PanelProvider>))
  }
  return { h: host, render, requests, loseResponse: () => { lose = true } }
}

it('replays a lost create response, edits immutable versions, restores a historical draft and archives without erasing history', async () => {
  const f = await fixture(); await f.render()
  await click('New persona'); await enter('Persona name', 'Evidence researcher'); await enter('Persona instructions', 'Original evidence procedure')
  f.loseResponse(); await click('Create persona')
  await vi.waitFor(() => expect(button('Retry submitted change')).toBeTruthy())
  await click('Retry submitted change')
  await vi.waitFor(() => expect(button('Edit persona')).toBeTruthy())
  const creates = f.requests.filter(item => item.method === 'POST' && item.path === 'personas')
  expect(creates).toHaveLength(2); expect(creates[1]).toEqual(creates[0])
  const persona = f.h.runtime.personas.list().items[0]!
  await click('Edit persona'); await enter('Persona instructions', 'Updated evidence procedure'); await click('Save new version')
  await vi.waitFor(() => expect(f.h.runtime.personas.get(persona.id).version).toBe(2))
  await enter('Historical version number', '1'); await click('View version')
  await vi.waitFor(() => expect(button('Use this version as an editing draft')).toBeTruthy())
  await click('Edit persona')
  expect(field('Persona instructions').value).toBe('Updated evidence procedure')
  await click('Use this version as an editing draft')
  expect(field('Persona instructions').value).toBe('Original evidence procedure')
  await click('Save new version')
  await vi.waitFor(() => expect(f.h.runtime.personas.get(persona.id).version).toBe(3))
  await enter('Reason for the persona status change', 'Retired from new runs'); await click('Archive persona')
  await vi.waitFor(() => expect(button('Restore persona')).toBeTruthy())
  expect(f.h.runtime.personas.version(persona.id, 2).definition.instructions).toBe('Updated evidence procedure')
  await click('Restore persona')
  await vi.waitFor(() => expect(button('Archive persona')).toBeTruthy())
  expect(f.h.runtime.personas.get(persona.id)).toMatchObject({ version: 3, revision: 5, archived: false })
})

it('preserves an older persona selection while editing a plan after the catalog gains a newer version', async () => {
  const f = await fixture(), personas = f.h.runtime.personas, workspace = f.h.runtime.workspace
  const definition = { name: 'Pinned researcher', description: '', instructions: 'Original scope', model: null, capabilities: ['read'] as const, skills: [] }
  const persona = await personas.create({ requestId: 'ui-persona', definition })
  let m = workspace.create({ requestId: 'ui-mission', title: 'Evidence brief', objective: 'Research', acceptance: 'Review' })
  m = workspace.add(m.id, { requestId: 'ui-action', revision: m.revision, title: 'Read', owner: 'agent', instructions: 'Read evidence', persona: { id: persona.id, version: 1 } })
  await personas.update(persona.id, { requestId: 'ui-version', revision: 1, definition: { ...definition, instructions: 'Future scope' } })
  await f.render(m.id)
  await vi.waitFor(() => expect(button('Edit plan')).toBeTruthy())
  await click('Edit plan')
  const selectors = [...container!.querySelectorAll('select')].filter(node => [...node.options].some(option => option.value === `${persona.id}:1`))
  expect(selectors).toHaveLength(1); expect(selectors[0]!.value).toBe(`${persona.id}:1`)
  await enter('Reason for the changes', 'Keep the reviewed persona'); await click('Submit plan for review')
  await vi.waitFor(() => expect(button('Approve plan')).toBeTruthy())
  const proposal = workspace.plans.list(m.id).proposals[0]!
  expect(workspace.plans.proposal(m.id, proposal.id).plan.actions[0]!.persona).toEqual({ id: persona.id, version: 1 })
  expect(f.h.runtime.store.tickets.list()).toEqual([])
})
