// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MissionsPage } from '../src/client/missions.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { channelPublicationFixture } from './fixtures/channel-publication.ts'
import { HostProcessIsolation } from '../src/verification/local.ts'

const cleanup: (() => Promise<unknown>)[] = []
let root: Root | undefined, container: HTMLDivElement | undefined, pending = 0
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove(); root = undefined; container = undefined
  vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks()
})
const settle = async () => { await vi.waitFor(() => expect(pending).toBe(0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const button = (text: string) => [...container!.querySelectorAll('button')].find(value => value.textContent === text)!
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); await act(async () => { button(text).click(); await settle() }); await act(settle) }

async function fixture(lostCompletion = false) {
  const h = await channelPublicationFixture(cleanup, 'github-pr-review'), { host, publisher, mission } = h
  if (process.env.DSH_REMOTE_ISOLATION !== '1') h.remote.host.isolation = new HostProcessIsolation()
  h.remote.host.snapshotHelper = resolve('src/verification/snapshot-worker.ts')
  const nativeFetch = globalThis.fetch, requests: { path: string; body: any }[] = []; let lost = false
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('/orchestrator/api/')) return nativeFetch(input, init)
    pending++
    try {
      const path = String(input).slice('/orchestrator/api/'.length), body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (body) requests.push({ path, body })
      const response = await host.api(init?.method ?? 'GET', path, body)
      if (lostCompletion && !lost && path === `missions/${mission.id}` && body?.status === 'completed' && response.status === 200) { lost = true; throw new Error('Completion reply lost') }
      return new Response(JSON.stringify(response.body), { status: response.status })
    } finally { pending-- }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}><MissionsPage id={mission.id} /></PanelProvider>))
  await act(settle)
  return { ...h, requests }
}

it('binds through the rendered operator form, accepts exact-head checks and closes through fresh whole-mission verification despite reply loss', async () => {
  const h = await fixture(true)
  await click(en['missionPull.configure'])
  const card = container!.querySelector(`[aria-label="${en['missionPull.title']}"]`)!, select = card.querySelector('select')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'project-updates'); select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(button(en['missionPull.bind']).disabled).toBe(true)
  await click(en['publication.inspectPull']); expect(container!.textContent).toContain(h.publisher.pull.head.sha)
  await act(async () => card.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  await click(en['missionPull.bind'])
  let mission = h.host.runtime.workspace.get(h.mission.id)
  expect(mission.actions[0]!.pull).toBe(h.requests.find(item => item.path.endsWith('/pull'))!.body.requestId)
  mission = h.host.runtime.workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
  await h.host.runtime.idle()
  const ticket = h.host.runtime.store.tickets.get(mission.actions[0]!.ticket!.id)!
  const source = ticket.execution!.directory
  await mkdir(source, { recursive: true }); await writeFile(join(source, 'result.txt'), 'checked result')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Result')
  h.publisher.pull.head.sha = git('rev-parse', 'HEAD'); h.publisher.tree(git('rev-parse', 'HEAD^{tree}'))
  const artifact = h.host.runtime.library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'PR output', summary: 'Host checked output', filename: 'result.txt', content: 'checked result' },
    { role: 'worker', ticketId: ticket.id })
  const definition = h.host.runtime.verification.definitions.create({ requestId: randomUUID(), enabled: true, definition: { name: 'Verify PR bytes', description: 'Check actual file',
    artifactPath: 'result.txt', argv: ['/bin/sh', '-c', 'test -s result.txt'], confinement: process.env.DSH_REMOTE_ISOLATION === '1' ? 'linux-bubblewrap' : 'host-process' } })
  const run = await h.host.runtime.verification.request(artifact.id, { requestId: randomUUID(), artifactRevision: artifact.revision, artifactHash: artifact.hash, check: { id: definition.id, version: 1 } })
  await vi.waitFor(() => expect(h.host.runtime.verification.get(run.id).status).toBe('passed'), { timeout: 10000 })
  await h.host.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'ready', summary: 'Checked PR result ready' })
  await act(async () => { root!.render(<PanelProvider t={translator(en)} navigate={() => {}}><MissionsPage key="accepted" id={mission.id} /></PanelProvider>); await settle() })
  expect(button(en['mission.acceptResult']).disabled).toBe(true)
  await click(en['publication.inspectPull'])
  const checkbox = container!.querySelector<HTMLInputElement>('fieldset input[type=checkbox]')!
  await act(async () => checkbox.click())
  const note = [...container!.querySelectorAll('label')].find(label => label.firstChild?.textContent === en['mission.reviewNote'])!.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Reviewed current GitHub head and actual host evidence'); note.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(button(en['mission.acceptResult']).disabled).toBe(false)
  await click(en['mission.acceptResult'])
  const accepted = h.host.runtime.workspace.get(mission.id).actions[0]!.accepted!
  expect(accepted.pull!.observation.binding.head.sha).toBe(h.publisher.pull.head.sha)
  await click(en['mission.finish'])
  expect(container!.querySelector('[role=alert]')).toBeTruthy()
  const completed = h.host.runtime.workspace.get(mission.id)
  expect(completed.status).toBe('completed')
  expect(h.host.runtime.verificationReviews.get(completed.completion!.actions[0]!.reviewId!).evidence![0]!.capture.id).not.toBe(accepted.evidence![0]!.capture.id)
  await click(en['mission.refresh'])
  expect(container!.textContent).toContain(en['missionCompletion.recorded'])
  expect(h.host.runtime.workspace.completions.list(mission.id).items).toHaveLength(1)
  expect(h.publisher.posts).toBe(0)
}, 30000)
