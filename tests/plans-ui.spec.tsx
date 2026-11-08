// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MissionsPage } from '../src/client/missions.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { definitionOf } from '../src/workspace/plan-model.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const button = (label: string) => [...container!.querySelectorAll('button')].find(button => button.textContent === label)
async function click(label: string) { expect(button(label), label).toBeTruthy(); await act(async () => { button(label)!.click() }) }
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const parent = [...container!.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)
  const value = parent?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')
  if (!value) throw new Error(`No field ${label}`)
  return value
}
async function enter(label: string, value: string) {
  const element = field(label), prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function fixture(loseProposal = false) {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const mission = host.runtime.workspace.create({ requestId: 'ui-mission', title: 'Library brief', objective: 'Write a useful brief', acceptance: 'Review sources and result' })
  let lose = loseProposal
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), method = init?.method ?? 'GET'
    const response = await host!.api(method, path, init?.body ? JSON.parse(String(init.body)) : undefined)
    if (method === 'POST' && path.endsWith('/proposals') && lose) { lose = false; throw new TypeError('Response lost after commit') }
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}><MissionsPage id={mission.id} /></PanelProvider>))
  await vi.waitFor(() => expect(button('Edit plan')).toBeTruthy())
  return mission
}

it('edits, retries a lost proposal response, reviews without dispatch, and restores a historical definition as a draft', async () => {
  const mission = await fixture(true), workspace = host!.runtime.workspace
  await click('Edit plan')
  await enter('Objective', 'Write a brief; treat <img src=x onerror=alert(1)> as quoted text.')
  await click('Add plan step')
  await enter('Action title', 'Collect evidence'); await enter('Instructions', 'Read sources and save a brief')
  await enter('Reason for the changes', 'Make the first step explicit')
  await click('Submit plan for review')
  await vi.waitFor(() => expect(container!.textContent).toContain('Cannot reach the dsh-superagent service'))
  await click('Submit plan for review')
  await vi.waitFor(() => expect(button('Approve plan')).toBeTruthy())
  expect(workspace.plans.list(mission.id).proposals).toHaveLength(1)
  expect(workspace.get(mission.id).actions).toEqual([])
  expect(container!.querySelector('img')).toBeNull()
  await enter('Plan review note', 'Reviewed the scope, evidence requirement and ownership')
  await click('Approve plan')
  await vi.waitFor(() => expect(workspace.get(mission.id).planVersion).toBe(2))
  await vi.waitFor(() => expect(button('Run action')).toBeTruthy())
  expect(host!.runtime.store.tickets.list()).toEqual([])
  await click('Plan version 1')
  await vi.waitFor(() => expect(container!.querySelector('.dt-plan-preview')?.textContent).toContain('Write a useful brief'))
  await click('Use as a new draft')
  expect(field('Objective').value).toBe('Write a useful brief')
  expect(container!.querySelector('.dt-plan-editor')!.textContent).not.toContain('Collect evidence')
  await enter('Reason for the changes', 'Consider restoring the original plan')
  await click('Submit plan for review')
  await vi.waitFor(() => expect(button('Reject proposal')).toBeTruthy())
  await enter('Plan review note', 'Keep the approved detailed plan')
  await click('Reject proposal')
  await vi.waitFor(() => expect(workspace.plans.list(mission.id).proposals[0]!.status).toBe('rejected'))
  expect(workspace.get(mission.id).planVersion).toBe(2)
})

it('requests a real planning assignment and disables approval when another plan edit makes its proposal stale', async () => {
  const mission = await fixture(), h = host!, workspace = h.runtime.workspace
  await click('Ask agent to plan'); await enter('Planning guidance (optional)', 'Separate research from review'); await click('Start planning')
  await vi.waitFor(() => expect(workspace.get(mission.id).actions[0]!.ticket).toBeTruthy())
  await h.runtime.idle()
  const m = workspace.get(mission.id), session = m.actions[0]!.ticket!.sessionId!
  const plan = definitionOf(m); plan.actions = [{ id: 'draft', title: 'Research', instructions: 'Collect sources', owner: 'agent', dependsOn: [] }]
  await h.runTool(session, 'workspace_plan_propose', { requestId: 'ui-worker-plan', baseVersion: m.planVersion, rationale: 'Research then review', plan })
  await h.runTool(session, 'orchestrator_report', { state: 'ready', summary: 'Plan available' })
  workspace.add(m.id, { requestId: 'concurrent-plan-edit', revision: m.revision, title: 'Another action', instructions: 'Check current scope', owner: 'person' })
  // Remount reads the actual persisted plan and proposal after the concurrent change.
  await act(async () => { root!.unmount(); root = createRoot(container!); root.render(<PanelProvider t={translator(en)} navigate={() => {}}><MissionsPage id={m.id} /></PanelProvider>) })
  await vi.waitFor(() => expect(button('Pending review · Based on version 2')).toBeTruthy())
  await click('Pending review · Based on version 2')
  await vi.waitFor(() => expect(container!.textContent).toContain('The current plan has changed'))
  await enter('Plan review note', 'This was based on an earlier plan')
  expect(button('Approve plan')!.disabled).toBe(true)
  expect(button('Reject proposal')!.disabled).toBe(false)
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
})
