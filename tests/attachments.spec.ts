import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { createServer } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, expect, it, vi } from 'vitest'
import { Attachments } from '../src/attachments/service.ts'
import { COPY_INPUT_PROGRAM } from '../src/attachments/copy-program.ts'
import { UPLOAD_LIMITS as L } from '../src/attachments/model.ts'
import { attachmentBackend } from './fixtures/attachments.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { remoteFixture } from './fixtures/remote.ts'

let host: Host | undefined
const cleanup: (() => Promise<unknown>)[] = [], directories: string[] = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; await host?.stop(); host = undefined; for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const directory = () => { const root = mkdtempSync(join(tmpdir(), 'dsh-input-test-')); directories.push(root); return root }
async function fixture() {
  const backend = attachmentBackend(); host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, attachments: backend.backend })
  return { ...backend, uploads: host.runtime.attachments, store: host.runtime.store }
}
async function upload(uploads: Attachments, data: Buffer, name = 'input.txt', mediaType = 'text/plain') {
  const request = { requestId: randomUUID(), name, bytes: data.length, sha256: hash(data), mediaType }
  uploads.begin(request)
  for (let offset = 0; offset < data.length; offset += L.chunkBytes) uploads.chunk(request.requestId, { offset, data: data.subarray(offset, offset + L.chunkBytes).toString('base64') })
  return { request, value: await uploads.finish(request.requestId) }
}

it('resumes original upload chunks after response loss and binds files only when the ordinary inbox message is sent', async () => {
  const { uploads, store, files } = await fixture(), data = Buffer.from('name,value\nalpha,11\nbeta,31\n')
  const request = { requestId: randomUUID(), name: 'data.csv', bytes: data.length, sha256: hash(data), mediaType: 'text/csv' }
  expect(uploads.begin(request).received).toBe(0)
  const chunk = { offset: 0, data: data.toString('base64') }; uploads.chunk(request.requestId, chunk)
  expect(uploads.begin(request).received).toBe(data.length); expect(uploads.chunk(request.requestId, chunk).received).toBe(data.length)
  expect(() => uploads.chunk(request.requestId, { ...chunk, data: Buffer.from('changed').toString('base64') })).toThrow(/differs/)
  const ready = await uploads.finish(request.requestId); expect(await uploads.finish(request.requestId)).toEqual(ready)
  expect(files.get(request.sha256)).toEqual(data); expect(store.tickets.list()).toEqual([])
  const send = { requestId: randomUUID(), text: 'Read the attached CSV', attachments: [ready.id] }
  const item = host!.runtime.inbox.start(send)
  expect(host!.runtime.inbox.start(send).id).toBe(item.id); expect(store.tickets.list()).toHaveLength(1)
  const view = await host!.runtime.inbox.conversation(item.id)
  expect(view.messages.find(message => message.role === 'person')!.attachments).toMatchObject([{ name: 'data.csv', sha256: request.sha256 }])
  expect(await uploads.read(item.id, { id: ready.id }, undefined, new AbortController().signal)).toMatchObject({ text: data.toString(), nextOffset: null })
  await expect(uploads.cancel(ready.id)).rejects.toThrow(/sent message/)
  expect(() => host!.runtime.inbox.start({ ...send, attachments: [] })).toThrow(/another operation/)
})
it('attaches files to an exact reply, refuses cross-task reads, and revokes reads when the task stops', async () => {
  const { uploads } = await fixture(), first = host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Task one' })
  const second = host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Task two' })
  const { value } = await upload(uploads, Buffer.from('private input'))
  const item = host!.runtime.inbox.item(first.id), request = { requestId: randomUUID(), revision: item.revision, text: 'Here is the file', attachments: [value.id] }
  host!.runtime.inbox.reply(first.id, request); expect(host!.runtime.inbox.reply(first.id, request).id).toBe(first.id)
  const view = await host!.runtime.inbox.conversation(first.id)
  expect(view.messages.find(message => message.text === request.text)!.attachments?.[0]?.id).toBe(value.id)
  await expect(uploads.read(second.id, { id: value.id }, undefined, new AbortController().signal)).rejects.toThrow(/not an input/)
  host!.runtime.engine.stopTicket(first.id, 'Stop test')
  await expect(uploads.read(first.id, { id: value.id }, undefined, new AbortController().signal)).rejects.toThrow(/authorized/)
})
it('rolls back task creation for incomplete inputs and rejects bytes that differ from their declared digest', async () => {
  const { uploads, store } = await fixture(), id = randomUUID()
  uploads.begin({ requestId: id, name: 'data.txt', bytes: 4, sha256: hash(Buffer.from('good')) })
  expect(() => host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Read input', attachments: [id] })).toThrow(/Finish/)
  expect(store.tickets.list()).toEqual([])
  uploads.chunk(id, { offset: 0, data: Buffer.from('evil').toString('base64') })
  await expect(uploads.finish(id)).rejects.toThrow(/digest/)
  expect(uploads.get(id).phase).toBe('receiving')
})
it('retains checkpoint-contained source bytes across service/backend replacement and detects later corruption', async () => {
  const { uploads, store } = await fixture(), { value } = await upload(uploads, Buffer.from('durable source'))
  const replacement = new Attachments({ store, lifetime: new AbortController().signal, backend: () => attachmentBackend().backend, authorize: () => {} })
  expect(Buffer.concat([...replacement.download(value.id).chunks]).toString()).toBe('durable source')
  store.db.prepare('UPDATE inbox_upload_chunk SET bytes=? WHERE upload=?').run(Buffer.from('tampered source'), value.id)
  expect(() => replacement.download(value.id)).toThrow(/receipt/)
})
it('pages UTF-8 at byte boundaries and provides binary bytes without pretending they are text', async () => {
  const { uploads } = await fixture(), data = Buffer.from('\uFEFF' + 'a'.repeat(L.textBytes - 4) + '🌍' + 'tail'), text = await upload(uploads, data)
  const item = host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Read files', attachments: [text.value.id] })
  const first = await uploads.read(item.id, { id: text.value.id }, undefined, new AbortController().signal) as { text: string; nextOffset: number }
  const next = await uploads.read(item.id, { id: text.value.id, offset: first.nextOffset }, undefined, new AbortController().signal) as { text: string; nextOffset: null }
  expect(first.text + next.text).toBe(data.toString()); expect(next.nextOffset).toBeNull()
  const binary = await upload(uploads, Buffer.from([0, 1, 2, 255]), 'bytes.bin', 'application/octet-stream')
  const binaryItem = host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Inspect bytes', attachments: [binary.value.id] })
  await expect(uploads.read(binaryItem.id, { id: binary.value.id }, undefined, new AbortController().signal)).rejects.toThrow(/binary/)
  expect(await uploads.read(binaryItem.id, { id: binary.value.id, format: 'base64' }, undefined, new AbortController().signal)).toMatchObject({ data: 'AAEC/w==' })
})
it('refuses unsupported vision routes and reconstructs image projections from the original uploaded bytes', async () => {
  const { uploads } = await fixture(), data = Buffer.from('89504e470d0a1a0a00000000', 'hex'), file = await upload(uploads, data, 'image.png', 'image/png')
  const item = host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Inspect image', attachments: [file.value.id] })
  const agent = (modalities: string[]) => ({ session: { requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) }, options: {}, ctx: { get: () => ({ resolveModelInfo: async () => ({ inputModalities: modalities }) }) } }) as unknown as Agent
  await expect(uploads.read(item.id, { id: file.value.id, format: 'image' }, agent(['text']), new AbortController().signal)).rejects.toThrow(/cannot inspect/)
  expect(await uploads.read(item.id, { id: file.value.id, format: 'image' }, agent(['text', 'image']), new AbortController().signal)).toMatchObject({ image: { mediaType: 'image/png', width: 1 } })
})

it.each([false, ...(process.env.DSH_REMOTE_ISOLATION === '1' ? [true] : [])])('copies multi-chunk binary input through existing Harness process authority (native confinement: %s)', async native => {
  const { uploads, store } = await fixture(), data = Buffer.alloc(L.chunkBytes * 2 + 17, 177), { value } = await upload(uploads, data, 'file.pdf', 'application/pdf')
  const item = host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Process the attached document', attachments: [value.id] })
  const ticket = store.tickets.get(item.id)!, context = new Context()
  const remote = native ? await remoteFixture(cleanup, { native: true }) : undefined
  const cwd = remote ? join(remote.enrolled.grant.root, 'input-copy') : directory(); mkdirSync(cwd, { recursive: true })
  ticket.execution!.directory = cwd; store.tickets.save(ticket)
  const processor = remote?.remoteProcess ?? new LocalSubprocessRuntime(context)
  const agent = { session: { header: { cwd } }, ctx: { get subprocess() { throw new Error('subprocess is not injected on Agent contexts') },
    get: (name: string) => name === 'agentPresets' ? { serviceFor: () => processor } : undefined } } as unknown as Agent
  const result = await uploads.copy(item.id, value.id, agent, new AbortController().signal)
  expect(readFileSync(result.path)).toEqual(data); expect(result.sha256).toBe(value.sha256)
  expect(await uploads.copy(item.id, value.id, agent, new AbortController().signal)).toEqual(result)
  chmodSync(result.path, 0o600); writeFileSync(result.path, 'changed')
  await expect(uploads.copy(item.id, value.id, agent, new AbortController().signal)).rejects.toThrow(/did not complete/)
  await context.fiber.dispose()
}, 30000)

it('recovers a partially written transfer and the link-before-cleanup crash window without overwriting a conflicting destination', () => {
  const cwd = directory(), data = Buffer.from('complete input'), digest = hash(data), name = `input-${randomUUID()}-${digest.slice(0, 12)}.bin`, stage = join(cwd, `.${name}.partial`)
  const run = (offset: number, input: Buffer) => spawnSync(process.execPath, ['--input-type=commonjs', '-e', COPY_INPUT_PROGRAM, name, String(data.length), digest, String(offset), hash(input)], { cwd, input: input.toString('base64'), encoding: 'utf8' })
  writeFileSync(stage, data.subarray(0, 4), { mode: 0o600 })
  expect(run(0, data).status).toBe(0); linkSync(stage, join(cwd, name))
  expect(run(data.length, Buffer.alloc(0)).status).toBe(0); expect(existsSync(stage)).toBe(false); expect(readFileSync(join(cwd, name))).toEqual(data)
  chmodSync(join(cwd, name), 0o600); writeFileSync(join(cwd, name), 'different'); expect(run(0, data).status).not.toBe(0)
  expect(readFileSync(join(cwd, name), 'utf8')).toBe('different')
})
it('refuses symbolic links and extra hard links while leaving the other file unchanged', () => {
  const cwd = directory(), data = Buffer.from('source'), digest = hash(data), name = `input-${randomUUID()}-${digest.slice(0, 12)}.bin`, outside = join(directory(), 'outside')
  writeFileSync(outside, 'sentinel'); symlinkSync(outside, join(cwd, `.${name}.partial`))
  const run = () => spawnSync(process.execPath, ['--input-type=commonjs', '-e', COPY_INPUT_PROGRAM, name, String(data.length), digest, '0', hash(data)], { cwd, input: data.toString('base64') })
  expect(run().status).not.toBe(0); rmSync(join(cwd, `.${name}.partial`)); linkSync(outside, join(cwd, `.${name}.partial`)); expect(run().status).not.toBe(0)
  expect(readFileSync(outside, 'utf8')).toBe('sentinel')
})

it('limits abandoned zero-byte and ready uploads and expires only unbound selections', async () => {
  const { store } = await fixture(), backend = attachmentBackend(); let now = Date.now()
  const uploads = new Attachments({ store, lifetime: new AbortController().signal, backend: () => backend.backend, authorize: () => {} }, () => now)
  const bound = await upload(uploads, Buffer.from('kept'))
  host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Keep this file', attachments: [bound.value.id] })
  const first = await upload(uploads, Buffer.alloc(0))
  for (let count = 1; count < L.pendingCount; count++) uploads.begin({ requestId: randomUUID(), name: 'empty', bytes: 0, sha256: hash(Buffer.alloc(0)) })
  const request = { requestId: randomUUID(), name: 'extra', bytes: 0, sha256: hash(Buffer.alloc(0)) }
  expect(() => uploads.begin(request)).toThrow(/capacity/)
  now += L.pendingMs + 1
  expect(uploads.begin(request).phase).toBe('receiving')
  expect(uploads.get(first.value.id).phase).toBe('expired'); expect(uploads.get(bound.value.id).phase).toBe('ready')
  expect(() => uploads.selection([first.value.id])).toThrow(/Finish/)
})
it('cancels a native-store write without publishing a ready reference or holding an SQLite cursor', async () => {
  const { uploads, backend, store } = await fixture(), data = Buffer.from('private'), id = randomUUID()
  uploads.begin({ requestId: id, name: 'input', bytes: data.length, sha256: hash(data) }); uploads.chunk(id, { offset: 0, data: data.toString('base64') })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const save = backend.saveFileStream.bind(backend)
  vi.spyOn(backend, 'saveFileStream').mockImplementation(async input => { entered(); await gate; return save(input) })
  const finishing = uploads.finish(id); const failed = expect(finishing).rejects.toThrow(/digest|cancelled/)
  await started; const cancelled = uploads.cancel(id); release()
  await failed; expect((await cancelled).phase).toBe('cancelled')
  expect(store.db.prepare('SELECT count(*) AS n FROM inbox_upload_chunk WHERE upload=?').get(id)!.n).toBe(0)
})
it('uses native Harness image validation and rebuilds exact Session references in a fresh attachment store', async () => {
  const { store } = await fixture(), contexts: Context[] = []
  const backend = () => { const ctx = new Context(); contexts.push(ctx); return new LocalAttachmentStore(ctx, { dshHome: directory() }) }
  const first = backend(), uploads = new Attachments({ store, lifetime: new AbortController().signal, backend: () => first, authorize: () => {} })
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4ISJyQkSEAUIBAB0eA8HLJ80gAAAAAElFTkSuQmCC', 'base64')
  const file = await upload(uploads, data, 'pixel.png', 'image/png')
  host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Keep this image', attachments: [file.value.id] })
  const original = await uploads.preview(file.value.id)
  const second = backend(), fresh = new Attachments({ store, lifetime: new AbortController().signal, backend: () => second, authorize: () => {} })
  await fresh.restoreImages(); expect(await fresh.preview(file.value.id)).toEqual(original)
  expect(Buffer.concat([...fresh.download(file.value.id).chunks])).toEqual(data)
  await expect(upload(fresh, Buffer.from('<svg>not a PNG</svg>'), 'fake.png', 'image/png')).rejects.toThrow()
  const normalize = second.saveImage.bind(second)
  vi.spyOn(second, 'saveImage').mockImplementation(async input => ({ ...await normalize(input), width: 3 }))
  await expect(fresh.restoreImages()).rejects.toThrow(/normalization differs/)
  for (const ctx of contexts) await ctx.fiber.dispose()
})
it('streams authenticated downloads with safe headers and refuses cross-origin access or corrupted source bytes', async () => {
  const { uploads, store } = await fixture(), data = Buffer.alloc(L.chunkBytes * 2 + 7, 9), { value } = await upload(uploads, data, 'résumé.pdf', 'application/pdf')
  const server = createServer((req, res) => { void host!.http(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const port = (server.address() as { port: number }).port
  ;(host!.ctx.webServer as { port: number }).port = port
  const url = `http://127.0.0.1:${port}/orchestrator/api/uploads/${value.id}/download`
  const headers = { 'x-orchestrator-request': '1' }
  const response = await fetch(url, { headers })
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-disposition')).toContain(encodeURIComponent(value.name))
  expect(Buffer.from(await response.arrayBuffer())).toEqual(data)
  expect((await fetch(url, { headers: { ...headers, origin: 'https://attacker.invalid' } })).status).toBe(403)
  expect((await fetch(url)).status).toBe(403)
  store.db.prepare('UPDATE inbox_upload_chunk SET bytes=? WHERE upload=? AND offset=0').run(Buffer.from('corrupt'), value.id)
  const corrupt = await fetch(url, { headers }); expect(corrupt.status).toBe(409); expect((await corrupt.json() as { error: string }).error).toMatch(/receipt/)
})
it('detects staging substitution between its identity check and publication', () => {
  const cwd = directory(), data = Buffer.from('source'), digest = hash(data), name = `input-${randomUUID()}-${digest.slice(0, 12)}.bin`
  writeFileSync(join(cwd, `.${name}.partial`), data)
  const injection = `const fs=require('node:fs'), link=fs.linkSync;fs.linkSync=(from,to)=>{fs.renameSync(from,from+'.original');fs.writeFileSync(from,'forged');return link(from,to)};`
  const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', injection + COPY_INPUT_PROGRAM, name, String(data.length), digest, String(data.length), hash(Buffer.alloc(0))], { cwd, input: '' })
  expect(result.status).not.toBe(0); expect(result.stdout.toString()).not.toContain('"complete":true')
  expect(readFileSync(join(cwd, `.${name}.partial.original`))).toEqual(data)
})

it('requires both persona write/command capabilities, the exact task directory, and a live tool signal before copying', async () => {
  const { uploads, store } = await fixture(), { value } = await upload(uploads, Buffer.from('scoped source'))
  const item = host!.runtime.inbox.start({ requestId: randomUUID(), text: 'Use this input', attachments: [value.id] }), ticket = store.tickets.get(item.id)!
  const resolveExecutable = vi.fn(), agent = { session: { header: { cwd: ticket.execution!.directory } }, ctx: { subprocess: { resolveExecutable } } } as unknown as Agent
  for (const capabilities of [['read', 'write'], ['read', 'commands']] as const) {
    const persona = await host!.runtime.personas.create({ requestId: randomUUID(), definition: { name: 'Limited', description: '', instructions: 'Stay within scope', model: null, capabilities: [...capabilities], skills: [] } })
    ticket.execution!.persona = host!.runtime.personas.snapshot({ id: persona.id, version: 1 }); store.tickets.save(ticket)
    await expect(uploads.copy(item.id, value.id, agent, new AbortController().signal)).rejects.toThrow(/write and command/)
  }
  delete ticket.execution!.persona; store.tickets.save(ticket)
  const wrong = { ...agent, session: { header: { cwd: directory() } } } as unknown as Agent
  await expect(uploads.copy(item.id, value.id, wrong, new AbortController().signal)).rejects.toThrow(/bound execution/)
  await expect(uploads.copy(item.id, value.id, agent, AbortSignal.abort())).rejects.toThrow()
  expect(resolveExecutable).not.toHaveBeenCalled()
})
