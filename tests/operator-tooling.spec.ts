/** GUI triggers, the local repository profile, scoped reads, public fetch, and prepare on this architecture. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { workerBin } from '../src/infra/environment.ts'
import { GITHUB_UNAVAILABLE } from '../src/sources/repository-profile.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
afterEach(async () => { vi.unstubAllGlobals(); if (h) await h.stop() })

async function local(): Promise<Host> {
  h = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  return h
}
const message = (id: string, text: string, file?: string) => ({
  id, role: 'user' as const, source: { kind: 'user' as const },
  content: [{ type: 'text' as const, text }, ...file ? [{ type: 'file' as const, attachment: { attachmentId: file, name: 'note.txt', bytes: 4 } }] : []],
})

it('stores a GUI message as a trigger and accepts that id', async () => {
  const host = await local()
  const agent = host.agents.get(host.runtime.masterId)!
  agent.steer(message('gui-1', 'check this repo https://github.com/jonsutton86/rea') as never)
  const page = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'triggers' }) as { items: { trigger_id: string; text?: string }[] }
  const card = page.items.find(item => JSON.stringify(item).includes('check this repo'))
  expect(card?.trigger_id).toMatch(/^[a-f0-9]{32}$/)
  host.ctx.emit('agent/inbox/claimed', { agent, message: { ...message('notice-1', 'host relay'), source: { kind: 'dsh-superagent' } }, turn: 2 } as never)
  const again = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'triggers' }) as { items: unknown[] }
  expect(JSON.stringify(again)).not.toContain('host relay')
  const accepted = await host.route({ kind: 'accept', trigger_id: card!.trigger_id, title: 'Check the repo', worktree_name: 'check-repo', acknowledgement: 'Checking the repository.' })
  expect(accepted.ticket).toMatchObject({ ticket_id: expect.any(String) })
})

it('reads the repository profile root and an attached file from the worker', async () => {
  const host = await local()
  const checkout = join(host.directory, 'rea')
  mkdirSync(join(checkout, 'src'), { recursive: true })
  mkdirSync(join(checkout, 'node_modules'), { recursive: true })
  writeFileSync(join(checkout, 'README.md'), 'rea checkout\n')
  writeFileSync(join(checkout, '.hidden'), 'nope\n')
  writeFileSync(join(checkout, 'node_modules', 'pkg.js'), 'nope\n')
  await expect(host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'repository/directory/' })).rejects.toThrow(GITHUB_UNAVAILABLE)
  await host.runtime.settings.save('source:repository', { enabled: true, config: { root: checkout, repository: 'jonsutton86/rea', branch: 'main' } },
    host.runtime.store.blockRevision('source:repository'), 'panel')
  const listing = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'repository/directory/' }) as { text: string }
  expect(JSON.parse(listing.text)).toMatchObject({ repository: 'jonsutton86/rea', branch: 'main', path: '', content: 'README.md\nsrc' })
  await expect(host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'repository/file/../README.md' })).rejects.toThrow('Only non-hidden')
  const attached = join(host.directory, 'note.txt')
  writeFileSync(attached, 'attached note\n')
  host.ctx.reflect.provide('attachments', { fileHostPath: (ref: { attachmentId?: string }) => ref.attachmentId === 'sha256:note' ? attached : undefined })
  const agent = host.agents.get(host.runtime.masterId)!
  agent.steer(message('gui-2', 'check this repo https://github.com/jonsutton86/rea', 'sha256:note') as never)
  const page = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'triggers' }) as { items: { trigger_id: string }[] }
  const id = page.items[0]!.trigger_id
  const accepted = await host.route({ kind: 'accept', trigger_id: id, title: 'Read the note', worktree_name: 'read-note', acknowledgement: 'Reading the note.' })
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  const sessionId = `worker-${ticket.id}`
  const read = await host.runTool(sessionId, 'orchestrator_file_read', { path: attached }) as { content: string }
  expect(read.content).toContain('attached note')
  expect(readFileSync(join(ticket.execution!.directory, 'attachments', 'note.txt'), 'utf8')).toBe('attached note\n')
  await expect(host.runTool(sessionId, 'orchestrator_file_read', { path: join(host.directory, 'orchestrator.sqlite') })).rejects.toThrow('outside this ticket')
  const repo = await host.runTool(sessionId, 'orchestrator_read', { resource: 'repository/file/README.md' }) as { text: string }
  expect(JSON.parse(repo.text).content).toBe('rea checkout\n')
})

it('fetches only an allowed public URL and refuses one while GitHub is configured', async () => {
  const host = await local()
  await host.runtime.settings.save('source:operator', { enabled: true, config: { fetchAllowlist: ['https://example.com/allowed'] } },
    host.runtime.store.blockRevision('source:operator'), 'panel')
  const agent = host.agents.get(host.runtime.masterId)!
  agent.steer(message('gui-3', 'check this repo https://github.com/jonsutton86/rea') as never)
  const page = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'triggers' }) as { items: { trigger_id: string }[] }
  const accepted = await host.route({ kind: 'accept', trigger_id: page.items[0]!.trigger_id, title: 'Fetch the page', worktree_name: 'fetch-page', acknowledgement: 'Fetching the page.' })
  await host.runtime.idle()
  const sessionId = `worker-${(accepted.ticket as { ticket_id: string }).ticket_id}`
  const body = (text: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/plain' }) => ({
    status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: { getReader: () => { let sent = false; return { async read() { if (sent) return { done: true as const, value: undefined }; sent = true; return { done: false as const, value: Buffer.from(text) } }, async cancel() {} } } },
  })
  vi.stubGlobal('fetch', vi.fn(async () => body('page')))
  expect(await host.runTool(sessionId, 'orchestrator_fetch', { url: 'https://example.com/allowed/a' })).toMatchObject({ url: 'https://example.com/allowed/a', status: 200, content: 'page' })
  expect(await host.runTool(sessionId, 'orchestrator_fetch', { url: 'https://github.com/jonsutton86/rea' })).toMatchObject({ status: 200, content: 'page' })
  expect(await host.runTool(sessionId, 'orchestrator_fetch', { url: 'https://evil.example/secret' })).toMatchObject({ refused: expect.stringContaining('allowlist') })
  vi.stubGlobal('fetch', vi.fn(async () => body('', 302, { location: 'https://evil.example/secret' })))
  expect(await host.runTool(sessionId, 'orchestrator_fetch', { url: 'https://example.com/allowed/go' })).toMatchObject({ refused: expect.stringContaining('left the allowed') })
})

it('does not fetch while a GitHub source is configured', async () => {
  h = await startRuntime()
  const ticket = await h.acceptedTicket(feishu('fetch-1', '@bot look'))
  expect(await h.runTool(ticket.sessionId, 'orchestrator_fetch', { url: 'https://example.com/allowed/a' })).toMatchObject({ refused: expect.stringContaining('GitHub source') })
})

it('runs prepare in local mode on the shim PATH and leaves a non-empty directory in place', async () => {
  const host = await local()
  const settings = host.runtime.store.settings()
  await host.runtime.settings.save('executor', { ...settings.executor, prepare: 'printf prepared', blockedCommands: ['curl'] },
    host.runtime.store.blockRevision('executor'), 'panel')
  expect(readFileSync(join(workerBin(host.directory), 'curl'), 'utf8')).toContain('curl is blocked')
  host.subprocess.spawn.mockClear()
  const agent = host.agents.get(host.runtime.masterId)!
  agent.steer(message('gui-4', 'prepare the checkout') as never)
  const page = await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'triggers' }) as { items: { trigger_id: string }[] }
  const accepted = await host.route({ kind: 'accept', trigger_id: page.items[0]!.trigger_id, title: 'Prepare checkout', worktree_name: 'prepare-checkout', acknowledgement: 'Preparing the checkout.' })
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  const runs = () => host.subprocess.spawn.mock.calls.map(([spec]) => spec as { argv: string[]; env?: Record<string, string> }).filter(spec => spec.argv[0] === 'sh')
  expect(runs()[0]).toEqual(expect.objectContaining({ argv: ['sh', '-c', 'printf prepared'], env: expect.objectContaining({ PATH: expect.stringMatching(new RegExp(`^${workerBin(host.directory).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) }) }))
  writeFileSync(join(ticket.execution!.directory, 'kept.txt'), 'keep me\n')
  await host.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'failed', summary: 'retry after files exist' })
  await host.runtime.settings.save('executor', { ...host.runtime.store.settings().executor, prepare: 'echo should-not-run' }, host.runtime.store.blockRevision('executor'), 'panel')
  const before = runs().length
  await host.runtime.engine.retryTicket(ticket.id)
  await host.runtime.idle()
  expect(runs().slice(before).some(spec => spec.argv.join(' ').includes('should-not-run'))).toBe(false)
  expect(readFileSync(join(ticket.execution!.directory, 'kept.txt'), 'utf8')).toBe('keep me\n')
})
