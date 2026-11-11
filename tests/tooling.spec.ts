/** Acceptance coverage for operator triggers, the repository profile, bounded fetch, attachment reads and the prepare command. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { LOCAL_GITHUB_UNAVAILABLE } from '../src/sources/repository.ts'

const REPO = 'https://github.com/jonsutton86/dsh-superagent-prototype'
const PAGE = 256 * 1024

async function operatorMessage(h: Host, id: string, text: string, file?: { path: string; name: string }) {
  const agent = h.agents.get(h.runtime.masterId) as unknown as { ctx: { get(name: string): { path?: string } | undefined; reflect: { provide(name: string, value: unknown): void } } }
  let service = agent.ctx.get('attachments')
  if (!service) {
    service = {}
    agent.ctx.reflect.provide('attachments', { fileHostPath: () => service!.path, imageHostPath: () => undefined })
  }
  service.path = file?.path
  h.ctx.emit('agent/inbox/claimed', { agent, message: { id, role: 'user', source: { kind: 'user' }, content: [
    { type: 'text', text }, ...file ? [{ type: 'file', attachment: { attachmentId: id, name: file.name, bytes: 4 } }] : [],
  ] } } as never)
}

async function triggers(h: Host) {
  return await h.runTool(h.runtime.masterId, 'orchestrator_read', { resource: 'triggers' }) as { items: { trigger_id: string; preview: string }[] }
}

it('records a Web GUI message as a trigger and lets orchestrator_route accept it, and the worker reads the attachment', async () => {
  const h = await startRuntime()
  try {
    const saved = join(h.directory, 'home', 'attachments', 'note.txt')
    mkdirSync(join(h.directory, 'home', 'attachments'), { recursive: true })
    writeFileSync(saved, 'hello attachment\n')
    const before = (await triggers(h)).items.length
    h.ctx.emit('agent/inbox/claimed', { agent: h.agents.get(h.runtime.masterId), message: { id: 'relay', role: 'user', source: { kind: 'dsh-superagent' },
      content: [{ type: 'text', text: 'not an operator message' }] } } as never)
    expect((await triggers(h)).items).toHaveLength(before)
    await operatorMessage(h, 'gui-1', `check this repo ${REPO}`, { path: saved, name: 'note.txt' })
    await operatorMessage(h, 'gui-1', `check this repo ${REPO}`, { path: saved, name: 'note.txt' })
    await h.runtime.idle()
    const page = await triggers(h)
    const item = page.items.find(entry => entry.preview.includes('check this repo'))
    expect(item?.trigger_id).toEqual(expect.any(String))
    expect(page.items.filter(entry => entry.preview.includes('check this repo'))).toHaveLength(1)
    const accepted = await h.route({ kind: 'accept', trigger_id: item!.trigger_id, title: 'Check repo', worktree_name: 'check-repo', acknowledgement: 'Checking the repository.' })
    expect(accepted).toMatchObject({ decision: 'accept', ticket: { title: 'Check repo' } })
    const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
    await h.runtime.idle()
    const sessionId = `worker-${ticketId}`
    expect(await h.runTool(sessionId, 'orchestrator_file_read', { path: saved })).toMatchObject({ text: 'hello attachment\n' })
    expect(await h.runTool(h.runtime.masterId, 'orchestrator_file_read', { path: saved })).toMatchObject({ text: 'hello attachment\n' })
    const directory = h.runtime.store.tickets.get(ticketId)!.execution!.directory
    const staged = readdirSync(join(directory, 'attachments'))
    expect(readFileSync(join(directory, 'attachments', staged[0]!), 'utf8')).toBe('hello attachment\n')
    writeFileSync(join(directory, 'notes.txt'), 'inside the ticket')
    expect(await h.runTool(sessionId, 'orchestrator_file_read', { path: join(directory, 'notes.txt') })).toMatchObject({ text: 'inside the ticket' })
    const outside = join(h.directory, 'secret.txt')
    writeFileSync(outside, 'no')
    await expect(h.runTool(sessionId, 'orchestrator_file_read', { path: outside })).rejects.toThrow(/outside/)
    await expect(h.runTool(h.runtime.masterId, 'orchestrator_file_read', { path: outside })).rejects.toThrow(/outside/)
  } finally { await h.stop() }
})

it('reads the repository profile root and a file, and refuses GitHub work until the profile is set in local mode', async () => {
  const h = await startRuntime()
  try {
    const read = (resource: string) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource }) as Promise<{ text: string }>
    await expect(read('repository/directory/')).rejects.toThrow(/No repository profile is configured/)
    const github = h.runtime.store.settings().sources.github!
    await h.runtime.settings.save('source:github', { enabled: false, config: github.config }, h.runtime.store.blockRevision('source:github'), 'panel')
    await expect(read('repository/directory/')).rejects.toThrow(LOCAL_GITHUB_UNAVAILABLE)
    const root = join(h.directory, 'checkout')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# demo\n')
    writeFileSync(join(root, '.secret'), 'hidden')
    writeFileSync(join(root, 'node_modules', 'pkg.js'), 'nope')
    writeFileSync(join(root, 'src', 'main.ts'), 'export const n = 1\n')
    await h.runtime.settings.save('source:repository', { enabled: true, config: { root, repository: 'jonsutton86/dsh-superagent-prototype', branch: 'main' } },
      h.runtime.store.blockRevision('source:repository'), 'panel')
    const listing = await read('repository/directory/')
    expect(listing.text).toContain('jonsutton86/dsh-superagent-prototype main')
    expect(listing.text).toContain('README.md')
    expect(listing.text).toContain('src')
    expect(listing.text).not.toContain('.secret')
    expect(listing.text).not.toContain('pkg.js')
    expect(await read('repository/file/src/main.ts')).toMatchObject({ text: 'export const n = 1\n' })
    await expect(read('repository/file/.secret')).rejects.toThrow(/non-hidden/)
    await expect(read('repository/file/../secret.txt')).rejects.toThrow(/non-hidden/)
    await operatorMessage(h, 'gui-repo', 'read the checkout')
    await h.runtime.idle()
    const item = (await triggers(h)).items.find(entry => entry.preview.includes('read the checkout'))!
    const accepted = await h.route({ kind: 'accept', trigger_id: item.trigger_id, title: 'Read checkout', worktree_name: 'read-checkout', acknowledgement: 'Reading the checkout.' })
    await h.runtime.idle()
    const sessionId = `worker-${(accepted.ticket as { ticket_id: string }).ticket_id}`
    expect(await h.runTool(sessionId, 'orchestrator_read', { resource: 'repository/directory/' })).toMatchObject({ text: expect.stringContaining('README.md') })
  } finally { await h.stop() }
})

it('fetches only an allowlisted or operator-supplied https URL, and skips that while GitHub is configured', async () => {
  const h = await startRuntime()
  try {
    const fetch = (url: string) => h.runTool(h.runtime.masterId, 'orchestrator_fetch', { url })
    await expect(fetch(REPO)).rejects.toThrow(/GitHub source is configured/)
    const github = h.runtime.store.settings().sources.github!
    await h.runtime.settings.save('source:github', { enabled: false, config: github.config }, h.runtime.store.blockRevision('source:github'), 'panel')
    h.runtime.httpFetch = vi.fn(async () => new Response('should not run', { status: 200 }))
    await expect(fetch('http://example.com/a')).rejects.toThrow(/https/)
    await expect(fetch('https://user:pass@example.com/a')).rejects.toThrow(/userinfo/)
    await expect(fetch('https://example.com/not-named')).rejects.toThrow(/not on the fetch allowlist/)
    expect(h.runtime.httpFetch).not.toHaveBeenCalled()
    await operatorMessage(h, 'gui-fetch', `check this repo ${REPO}`)
    h.runtime.httpFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('manual')
      return new Response('readme', { status: 200, headers: { 'content-type': 'text/plain' } })
    })
    const page = await fetch(REPO) as { url: string; status: number; text: string; retrieved_at: string; truncated: boolean }
    expect(page).toMatchObject({ url: `${REPO}`, status: 200, text: 'readme', truncated: false })
    expect(page.retrieved_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
    h.runtime.httpFetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/secret' } }))
    await expect(fetch(REPO)).rejects.toThrow(/redirect leaves/)
    expect(h.runtime.httpFetch).toHaveBeenCalledOnce()
    await h.runtime.settings.save('source:operator', { enabled: true, config: { operatorId: 'local', fetchAllowlist: [{ prefix: 'https://example.com/public' }] } },
      h.runtime.store.blockRevision('source:operator'), 'panel')
    h.runtime.httpFetch = vi.fn(async () => new Response('page', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect(await fetch('https://example.com/public/page')).toMatchObject({ status: 200, text: 'page' })
    await expect(fetch('https://example.com/public-evil')).rejects.toThrow(/not on the fetch allowlist/)
    h.runtime.httpFetch = vi.fn(async () => new Response('x'.repeat(PAGE + 10), { status: 200, headers: { 'content-type': 'text/plain' } }))
    expect(await fetch('https://example.com/public/big')).toMatchObject({ truncated: true, text: 'x'.repeat(PAGE) })
    await operatorMessage(h, 'gui-worker', `check this repo ${REPO}`)
    await h.runtime.idle()
    const item = (await triggers(h)).items.find(entry => entry.trigger_id && entry.preview.includes('check this repo'))!
    const accepted = await h.route({ kind: 'accept', trigger_id: item.trigger_id, title: 'Fetch repo', worktree_name: 'fetch-repo', acknowledgement: 'Fetching the page.' })
    await h.runtime.idle()
    const sessionId = `worker-${(accepted.ticket as { ticket_id: string }).ticket_id}`
    h.runtime.httpFetch = vi.fn(async () => new Response('worker page', { status: 200, headers: { 'content-type': 'text/plain' } }))
    expect(await h.runTool(sessionId, 'orchestrator_fetch', { url: REPO })).toMatchObject({ status: 200, text: 'worker page' })
  } finally { await h.stop() }
})

it('runs settings/executor.prepare before the worker starts, with blocked commands on PATH', async () => {
  const h = await startRuntime()
  try {
    const executor = h.runtime.store.settings().executor
    await h.runtime.settings.save('executor', { ...executor, prepare: 'echo prepared > "$DSH_SUPERAGENT_DIR/.ready"', blockedCommands: ['curl'] },
      h.runtime.store.blockRevision('executor'), 'panel')
    expect(h.runtime.store.settings().executor.prepare).toContain('echo prepared')
    const createsBefore = h.controller.create.mock.calls.length
    await operatorMessage(h, 'gui-prepare', 'prepare a checkout')
    await h.runtime.idle()
    const item = (await triggers(h)).items.find(entry => entry.preview.includes('prepare a checkout'))!
    await h.route({ kind: 'accept', trigger_id: item.trigger_id, title: 'Prepare checkout', worktree_name: 'prepare-checkout', acknowledgement: 'Preparing the checkout.' })
    await h.runtime.idle()
    const spawned = h.subprocess.spawn.mock.calls.map((call, index) => ({ spec: call[0] as { argv: string[]; env?: Record<string, string> }, order: h.subprocess.spawn.mock.invocationCallOrder[index]! }))
    const prepare = spawned.find(call => call.spec.argv[0] === 'sh' && call.spec.argv[2]?.includes('echo prepared'))
    expect(prepare?.spec.env?.PATH?.startsWith(join(h.directory, 'worker-bin'))).toBe(true)
    expect(prepare?.spec.env?.DSH_SUPERAGENT_BLOCKED_COMMANDS).toBe('curl')
    expect(prepare?.spec.env?.DSH_SUPERAGENT_DIR).toEqual(expect.stringContaining('prepare-checkout'))
    const workerCreate = h.controller.create.mock.invocationCallOrder.at(-1)!
    expect(h.controller.create.mock.calls.length).toBeGreaterThan(createsBefore)
    expect(prepare!.order).toBeLessThan(workerCreate)
  } finally { await h.stop() }
})
