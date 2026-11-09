// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MissionsPage } from '../src/client/missions.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'
import * as localVerification from '../src/verification/local.ts'

let host: Host | undefined, root: Root | undefined, container: HTMLElement | undefined, ctx: Context | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove()
  await host?.stop(); await ctx?.fiber.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

it('requires a selected real check for every artifact and accepts through the rendered review form and management API', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const { workspace, library, verification } = host.runtime
  let mission = workspace.create({ requestId: randomUUID(), title: 'Checked deliverables', objective: 'Produce two files', acceptance: 'Both files are host checked' })
  mission = workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Prepare files', instructions: 'Write both files', owner: 'agent' })
  mission = workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.get(mission.actions[0]!.ticket!.id)!, source = join(host.directory, 'review-source')
  await mkdir(source)
  ticket.execution!.directory = source; ticket.assignments.at(-1)!.execution = { directory: source, mode: ticket.execution!.mode, environment: ticket.execution!.environment }
  host.runtime.store.tickets.save(ticket)
  ctx = new Context(); const subprocess = new LocalSubprocessRuntime(ctx)
  // jsdom rewrites import.meta.url for assets; the subprocess must receive a real filesystem helper path.
  vi.spyOn(localVerification, 'snapshotHelperPath').mockReturnValue(resolve('src/verification/snapshot-worker.ts'))
  // The fixture's models remain deterministic; check execution uses actual Harness subprocesses.
  host.subprocess.spawn.mockImplementation(spec => subprocess.spawn(spec as Parameters<typeof subprocess.spawn>[0]) as never)
  Object.assign(host.subprocess, { resolveExecutable: subprocess.resolveExecutable.bind(subprocess) })
  await writeFile(join(source, 'first.txt'), 'one'); await writeFile(join(source, 'second.txt'), 'two')
  const runIds: string[] = []
  for (const [filename, content] of [['first.txt', 'one'], ['second.txt', 'two']] as const) {
    const artifact = library.publish({ requestId: randomUUID(), kind: 'artifact', title: filename, summary: 'Actual output', filename, content }, { role: 'worker', ticketId: ticket.id })
    const definition = verification.definitions.create({ requestId: randomUUID(), enabled: true, definition: { name: `Validate ${filename}`, description: 'The output is nonempty',
      argv: ['/bin/sh', '-c', 'test -s "$1"', 'check', filename], artifactPath: filename, confinement: 'host-process' } })
    const run = await verification.request(artifact.id, { requestId: randomUUID(), artifactHash: artifact.hash, artifactRevision: artifact.revision, check: { id: definition.id, version: 1 } })
    await vi.waitFor(() => expect(verification.get(run.id).status, verification.get(run.id).problem).toBe('passed'), { timeout: 10000 })
    runIds.push(run.id)
  }
  await host.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'ready', summary: 'Two files ready' })
  let pending = 0
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    pending++
    try {
      const response = await host!.api(init?.method ?? 'GET', String(input).replace('/orchestrator/api/', ''), init?.body ? JSON.parse(String(init.body)) : undefined)
      return new Response(JSON.stringify(response.body), { status: response.status })
    } finally { pending-- }
  })
  const settle = async () => { await vi.waitFor(() => expect(pending).toBe(0)); await new Promise(resolve => setTimeout(resolve, 0)) }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={() => {}}><MissionsPage id={mission.id} /></PanelProvider>))
  await act(settle)
  const accept = () => [...container!.querySelectorAll('button')].find(button => button.textContent === en['mission.acceptResult'])!
  const note = [...container.querySelectorAll('label')].find(label => label.firstChild?.textContent === en['mission.reviewNote'])!.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Reviewed both actual check receipts')
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const boxes = [...container.querySelectorAll<HTMLInputElement>('fieldset input[type=checkbox]')]
  expect(boxes).toHaveLength(2); expect(accept().disabled).toBe(true)
  await act(async () => boxes[0]!.click()); expect(accept().disabled).toBe(true)
  await act(async () => boxes[1]!.click()); expect(accept().disabled).toBe(false)
  await act(async () => { accept().click(); await settle() })
  const result = workspace.get(mission.id).actions[0]!
  expect(result.status).toBe('done'); expect(result.accepted?.basis).toBe('checks')
  expect(result.accepted?.evidence?.map(seal => seal.selection.runId).sort()).toEqual(runIds.sort())
  expect(new Set(result.accepted?.evidence?.map(seal => seal.capture.id)).size).toBe(1)
  expect(container.textContent).toContain(en['verification.acceptedChecks'])
}, 20_000)
