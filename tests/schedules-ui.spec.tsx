// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SchedulesPage } from '../src/client/schedules.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import type { Route } from '../src/client/route.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('creates a complete plan schedule, retries a lost response, pauses it and opens its occurrence through real routes', async () => {
  host = await startRuntime()
  await host.api('POST', 'executor/pause', { paused: true })
  let mission = host.runtime.workspace.create({ requestId: 'source', title: 'Scheduled review', objective: 'Review progress', acceptance: 'Check evidence' })
  mission = host.runtime.workspace.add(mission.id, { requestId: 'action', revision: mission.revision, title: 'Collect evidence', instructions: 'Create a brief', owner: 'agent' })
  let lose = true
  const submissions: unknown[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), body = init?.body ? JSON.parse(String(init.body)) : undefined
    const result = await host!.api(init?.method ?? 'GET', path, body)
    if (path === 'schedules' && init?.method === 'POST') {
      submissions.push(body)
      if (lose) { lose = false; throw new Error('Response lost after schedule commit') }
    }
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  let route: Route = { page: 'schedules', query: { mission: mission.id } }
  let renderKey = 0
  const render = () => root!.render(<PanelProvider t={translator(en)} navigate={next => { route = next; render() }}>
    {route.page === 'schedules' ? <SchedulesPage key={`${renderKey}:${route.id ?? route.query?.mission}`} id={route.id} missionId={route.query?.mission} /> : <p>Mission opened</p>}
  </PanelProvider>)
  const click = async (text: string) => {
    const button = [...container!.querySelectorAll('button')].find(item => item.textContent === text)
    expect(button, text).toBeTruthy(); await act(async () => { button!.click() })
  }
  const field = (label: string) => [...container!.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!.querySelector('input,select')! as HTMLInputElement | HTMLSelectElement
  const enter = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
    await act(async () => {
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
  }
  await act(async () => render())
  expect(container.textContent).toContain('Collect evidence')
  await enter(field('Cadence'), 'once')
  await enter(field('Start time (with UTC offset)'), new Date(Date.now() - 1000).toISOString())
  await act(async () => { (container!.querySelector('input[name="enabled"]') as HTMLInputElement).click() })
  await click('Create schedule')
  expect(container.textContent).toContain('Cannot reach the dsh-superagent service')
  await click('Retry original request')
  expect(submissions).toHaveLength(2); expect(submissions[0]).toEqual(submissions[1]); expect(host.runtime.schedules.list().items).toHaveLength(1)
  const id = host.runtime.schedules.list().items[0]!.id
  await click('Pause schedule'); expect(host.runtime.schedules.get(id).enabled).toBe(false)
  await host.api('POST', 'executor/pause', { paused: false }); await host.runtime.pump()
  expect(host.runtime.schedules.get(id).runs).toBe(0)
  await click('Enable schedule'); await host.runtime.pump(); await host.runtime.idle()
  expect(host.runtime.schedules.get(id).runs).toBe(1)
  await act(async () => { renderKey++; render() })
  expect(container.textContent).toContain('Running or awaiting review')
  await click('Open occurrence mission')
  expect(route).toEqual({ page: 'missions', id: host.runtime.schedules.get(id).occurrences[0]!.missionId })
})
