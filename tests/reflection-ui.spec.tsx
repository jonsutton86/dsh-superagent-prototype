// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ReflectionsPage } from '../src/client/reflections.tsx'
import { SchedulesPage } from '../src/client/schedules.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import type { Route } from '../src/client/route.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('creates a reflection schedule and reviews captured evidence with an exact retry after a lost approval response', async () => {
  host = await startRuntime(); await host.api('POST', 'executor/pause', { paused: true })
  const source = host.runtime.library.publish({ requestId: 'source', kind: 'memory', title: 'Captured lesson', summary: 'Source evidence', content: 'Remember the integration constraint.' })
  let lose = true; const submissions: unknown[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined
    const result = await host!.api(init?.method ?? 'GET', path, body)
    if (path.endsWith('/review') && init?.method === 'POST') {
      submissions.push(body)
      if (lose) { lose = false; throw new Error('Lost approval response after commit') }
    }
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  let route: Route = { page: 'reflections' }
  const render = () => root!.render(<PanelProvider t={translator(en)} navigate={next => { route = next; render() }}>
    {route.page === 'reflections' ? <ReflectionsPage key={route.id ?? 'list'} id={route.id} /> : route.page === 'schedules'
      ? <SchedulesPage key={route.id} id={route.id} /> : <p>Approved memory opened</p>}
  </PanelProvider>)
  const click = async (text: string) => {
    const button = [...container!.querySelectorAll('button')].find(item => item.textContent === text)
    expect(button, text).toBeTruthy(); await act(async () => { button!.click() })
  }
  const field = (label: string) => [...container!.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!.querySelector('input,select,textarea')! as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  const enter = async (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
  }
  await act(async () => render()); await click('New reflection schedule')
  expect(container.textContent).toContain('Reflection guidance')
  await enter(field('Cadence'), 'once'); await enter(field('Start time (with UTC offset)'), new Date(Date.now() - 1000).toISOString())
  await enter(field('Maximum missions'), '0'); await enter(field('Maximum library records'), '1')
  await act(async () => { (container!.querySelector('input[name="enabled"]') as HTMLInputElement).click() })
  await click('Create schedule')
  const schedule = host.runtime.schedules.list().items[0]!
  expect(host.runtime.schedules.get(schedule.id).definition.reflection).toMatchObject({ maxMissions: 0, maxRecords: 1 })
  await host.api('POST', 'executor/pause', { paused: false }); await host.runtime.pump(); await host.runtime.idle()
  const run = host.runtime.reflections.list().items[0]!, ticket = host.runtime.workspace.get(run.missionId).actions[0]!.runs[0]!
  host.runtime.reflections.propose(ticket, { requestId: 'candidate', rationale: 'Reusable integration knowledge', evidence: { records: [source.id] },
    candidate: { kind: 'memory', title: 'Reviewed integration lesson', summary: 'Keep this constraint', content: 'Remember the integration constraint.' } })
  await act(async () => { route = { page: 'reflections', id: run.id }; render() })
  expect(container.textContent).toContain('Captured lesson'); expect(container.textContent).toContain('Approval publishes this as shared workspace memory.')
  await enter(field('Review note'), 'Verified the captured source and workspace scope')
  await click('Save review decision'); expect(container.textContent).toContain('Cannot reach the dsh-superagent service')
  expect(host.runtime.library.list().items).toHaveLength(2)
  await click('Retry original request')
  expect(submissions).toHaveLength(2); expect(submissions[0]).toEqual(submissions[1])
  expect(host.runtime.library.list().items).toHaveLength(2); expect(container.textContent).toContain('Approved')
  await click('Open approved result'); expect(route.page).toBe('library')
})
