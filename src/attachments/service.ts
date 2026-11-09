/** Immutable chunked inputs in the checkpointed Store, with native Harness attachment projection. */
import { createHash } from 'node:crypto'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { extname, join } from 'node:path'
import { COPY_INPUT_PROGRAM } from './copy-program.ts'
import { personaDenial } from '../personas/runtime.ts'
import { liveTicket, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { AttachmentIds, BeginUpload, ReadAttachment, UploadChunk, UploadError, UPLOAD_LIMITS as L,
  type AttachmentView, type UploadRecord, type UploadView, type AttachmentCapabilities } from './model.ts'

interface Host { store: Store; lifetime: AbortSignal; backend(): AttachmentStore | undefined; authorize(ticket: Ticket): void }
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const images = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** Uploads are inert until an explicit inbox transaction binds them to a task input. */
export class Attachments {
  private readonly finishing = new Map<string, Promise<UploadView>>()
  constructor(private readonly host: Host, private readonly now = Date.now) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS inbox_upload (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox_upload_chunk (upload TEXT NOT NULL, offset INTEGER NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(upload,offset));
      CREATE TABLE IF NOT EXISTS inbox_attachment_binding (ticket TEXT NOT NULL, message TEXT NOT NULL, upload TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ticket,message,upload));`)
    this.expire()
  }
  capabilities(): AttachmentCapabilities { return { available: !!this.host.backend(), fileBytes: L.fileBytes, chunkBytes: L.chunkBytes, perMessage: L.perMessage, messageBytes: L.messageBytes } }
  private backend(): AttachmentStore { const service = this.host.backend(); if (!service) throw new UploadError(503, 'Harness attachment storage is unavailable'); return service }
  private record(id: string): UploadRecord {
    const row = this.host.store.db.prepare('SELECT value FROM inbox_upload WHERE id=?').get(id)
    if (!row) throw new UploadError(404, 'Upload not found')
    return JSON.parse(row.value as string) as UploadRecord
  }
  private save(value: UploadRecord): void { this.host.store.db.prepare('INSERT INTO inbox_upload VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value)) }
  private bound(id: string): boolean { return !!this.host.store.db.prepare('SELECT 1 FROM inbox_attachment_binding WHERE upload=? LIMIT 1').get(id) }
  private view(value: UploadRecord): UploadView {
    const { fingerprint: _fingerprint, file: _file, image, ...rest } = value
    return { ...rest, image: !!image, bound: this.bound(value.id) }
  }
  private expire(): void {
    for (const row of this.host.store.db.prepare("SELECT value FROM inbox_upload u WHERE json_extract(value,'$.phase') IN ('receiving','ready') AND json_extract(value,'$.createdAt')<=? AND NOT EXISTS (SELECT 1 FROM inbox_attachment_binding b WHERE b.upload=u.id)").all(this.now() - L.pendingMs)) {
      const value = JSON.parse(row.value as string) as UploadRecord
      if (!this.finishing.has(value.id)) this.host.store.atomic(() => { this.save({ ...value, phase: 'expired' }); this.host.store.db.prepare('DELETE FROM inbox_upload_chunk WHERE upload=?').run(value.id) })
    }
  }
  get(id: string): UploadView { this.expire(); return this.view(this.record(id)) }
  begin(input: unknown): UploadView {
    this.host.lifetime.throwIfAborted(); this.backend(); this.expire()
    const value = BeginUpload.parse(input), fingerprint = sha256(JSON.stringify(value))
    const existing = this.host.store.db.prepare('SELECT value FROM inbox_upload WHERE id=?').get(value.requestId)
    if (existing) {
      const prior = JSON.parse(existing.value as string) as UploadRecord
      if (prior.fingerprint !== fingerprint) throw new UploadError(409, 'Upload request ID was used with different metadata')
      return this.view(prior)
    }
    const pending = this.host.store.db.prepare("SELECT count(*) AS count, coalesce(sum(json_extract(value,'$.bytes')),0) AS bytes FROM inbox_upload u WHERE json_extract(value,'$.phase') IN ('receiving','ready') AND NOT EXISTS (SELECT 1 FROM inbox_attachment_binding b WHERE b.upload=u.id)").get()!
    if (Number(pending.count) >= L.pendingCount || Number(pending.bytes) + value.bytes > L.pendingBytes) throw new UploadError(413, 'Pending upload capacity is full; send or cancel existing uploads')
    const { requestId: id, ...metadata } = value
    const record: UploadRecord = { ...metadata, id, fingerprint, phase: 'receiving', received: 0, createdAt: this.now() }
    this.save(record); return this.view(record)
  }
  chunk(id: string, input: unknown): UploadView {
    this.host.lifetime.throwIfAborted(); this.expire()
    const request = UploadChunk.parse(input), bytes = Buffer.from(request.data, 'base64'), digest = sha256(bytes), value = this.record(id)
    if (bytes.length > L.chunkBytes || bytes.toString('base64') !== request.data) throw new UploadError(400, 'Invalid upload chunk')
    const previous = this.host.store.db.prepare('SELECT bytes,sha256 FROM inbox_upload_chunk WHERE upload=? AND offset=?').get(id, request.offset)
    if (previous) {
      if (previous.sha256 !== digest || !Buffer.from(previous.bytes as Uint8Array).equals(bytes)) throw new UploadError(409, 'Chunk retry differs from the original bytes')
      return this.view(value)
    }
    if (value.phase !== 'receiving' || this.finishing.has(id)) throw new UploadError(409, 'Upload is not accepting chunks')
    if (request.offset !== value.received || value.received + bytes.length > value.bytes) throw new UploadError(409, 'Chunk offset or length does not match the upload')
    return this.host.store.atomic(() => {
      this.host.store.db.prepare('INSERT INTO inbox_upload_chunk VALUES (?,?,?,?)').run(id, request.offset, bytes, digest)
      value.received += bytes.length; this.save(value); return this.view(value)
    })
  }
  /** Each chunk and the complete ordered object are verified before its reference is admitted or consumed. */
  private *chunks(value: UploadRecord): Generator<Buffer> {
    let offset = 0; const hash = createHash('sha256')
    // Never hold an SQLite cursor across an asynchronous native-store write or HTTP stream.
    const next = this.host.store.db.prepare('SELECT offset,bytes,sha256 FROM inbox_upload_chunk WHERE upload=? AND offset>=? ORDER BY offset LIMIT 1')
    for (;;) {
      const row = next.get(value.id, offset); if (!row) break
      const bytes = Buffer.from(row.bytes as Uint8Array)
      if (row.offset !== offset || !bytes.length || bytes.length > L.chunkBytes || offset + bytes.length > value.bytes || sha256(bytes) !== row.sha256) throw new UploadError(409, 'Stored attachment chunks do not match their receipt')
      offset += bytes.length; hash.update(bytes); yield bytes
    }
    if (offset !== value.bytes || hash.digest('hex') !== value.sha256) throw new UploadError(409, 'Stored attachment does not match its declared digest or length')
  }
  private verify(value: UploadRecord): void { for (const _ of this.chunks(value)) { /* Verify without assembling the object. */ } }
  finish(id: string): Promise<UploadView> {
    this.expire()
    const pending = this.finishing.get(id); if (pending) return pending
    const run = this.commit(id).finally(() => this.finishing.delete(id)); this.finishing.set(id, run); return run
  }
  private async commit(id: string): Promise<UploadView> {
    this.host.lifetime.throwIfAborted(); const value = this.record(id), backend = this.backend()
    if (value.phase === 'ready') { this.verify(value); return this.view(value) }
    if (value.phase !== 'receiving' || value.received !== value.bytes) throw new UploadError(409, 'Upload is incomplete or cancelled')
    this.verify(value)
    const owner = this
    const file = await backend.saveFileStream({ name: value.name, signal: this.host.lifetime, data: { async *[Symbol.asyncIterator]() { for (const chunk of owner.chunks(value)) { owner.host.lifetime.throwIfAborted(); yield chunk } } } })
    // Attachment identifiers are opaque (the current backend prefixes hashes with "sha256:"). Verify content, not their spelling.
    const savedHash = createHash('sha256'); let savedBytes = 0
    for await (const chunk of backend.readFileStream(file, this.host.lifetime)) {
      savedBytes += chunk.byteLength; if (savedBytes > value.bytes) throw new UploadError(409, 'Harness file exceeds the uploaded object')
      savedHash.update(chunk)
    }
    if (file.bytes !== value.bytes || savedBytes !== value.bytes || savedHash.digest('hex') !== value.sha256) throw new UploadError(409, 'Harness file differs from the uploaded object')
    let image = value.image
    if (images.has(value.mediaType)) {
      if (value.bytes > backend.imageLimits.maxImageBytes) throw new UploadError(413, 'Image exceeds the Harness image limit')
      image = await backend.saveImage({ data: Buffer.concat([...this.chunks(value)]), mediaType: value.mediaType as ImageMediaType, name: value.name })
    }
    this.host.lifetime.throwIfAborted()
    if (this.record(id).phase !== 'receiving') throw new UploadError(409, 'Upload was cancelled while being prepared')
    value.phase = 'ready'; value.file = file; if (image) value.image = image
    this.save(value); return this.view(value)
  }
  async cancel(id: string): Promise<UploadView> {
    const value = this.record(id)
    if (this.bound(id)) throw new UploadError(409, 'This attachment belongs to a sent message and cannot be deleted')
    this.host.store.atomic(() => { this.save({ ...value, phase: 'cancelled' }); this.host.store.db.prepare('DELETE FROM inbox_upload_chunk WHERE upload=?').run(id) })
    await this.finishing.get(id)?.catch(() => {})
    return this.get(id)
  }
  selection(ids: unknown): AttachmentView[] {
    this.expire()
    const selected = AttachmentIds.parse(ids).map(id => {
      const value = this.record(id); if (value.phase !== 'ready') throw new UploadError(409, 'Finish every upload before sending')
      this.verify(value); const { id: key, name, bytes, sha256: digest, mediaType } = value
      return { id: key, name, bytes, sha256: digest, mediaType, image: !!value.image }
    })
    if (selected.reduce((bytes, item) => bytes + item.bytes, 0) > L.messageBytes) throw new UploadError(413, 'Message attachments exceed the combined limit')
    return selected
  }
  bind(ticket: string, message: string, selected: AttachmentView[]): void {
    selected.forEach((item, position) => this.host.store.db.prepare('INSERT INTO inbox_attachment_binding VALUES (?,?,?,?,?)').run(ticket, message, item.id, position, JSON.stringify(item)))
  }
  list(ticket: string, message?: string): AttachmentView[] {
    const rows = message === undefined ? this.host.store.db.prepare('SELECT DISTINCT value FROM inbox_attachment_binding WHERE ticket=? ORDER BY rowid').all(ticket)
      : this.host.store.db.prepare('SELECT value FROM inbox_attachment_binding WHERE ticket=? AND message=? ORDER BY position').all(ticket, message)
    return rows.map(row => JSON.parse(row.value as string) as AttachmentView)
  }
  private authorized(ticketId: string, id: string): UploadRecord {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) throw new UploadError(409, 'The task is no longer authorized')
    this.host.lifetime.throwIfAborted(); this.host.authorize(ticket)
    const binding = this.list(ticketId).find(item => item.id === id), value = this.record(id)
    if (!binding || value.phase !== 'ready' || binding.sha256 !== value.sha256 || binding.bytes !== value.bytes) throw new UploadError(404, 'Attachment is not an input of this task')
    return value
  }
  workerList(ticketId: string): AttachmentView[] {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) throw new UploadError(409, 'The task is no longer authorized')
    this.host.lifetime.throwIfAborted(); this.host.authorize(ticket)
    return this.list(ticketId)
  }
  async read(ticketId: string, input: unknown, agent: Agent | undefined, signal: AbortSignal): Promise<unknown> {
    const request = ReadAttachment.parse(input), value = this.authorized(ticketId, request.id)
    signal.throwIfAborted(); this.verify(value)
    if (request.format === 'image') {
      if (!value.image || !images.has(value.mediaType) || !agent) throw new UploadError(400, 'This attachment is not an available image')
      const route = agent.session.requestHeader()?.config, provider = route?.provider ?? agent.options.provider, model = route?.model ?? agent.options.model
      const llm = agent.ctx.get('llm')
      if (!provider || !model || !llm || !(await llm.resolveModelInfo(provider, model, signal)).inputModalities?.includes('image'))
        throw new UploadError(409, 'The selected model cannot inspect images; choose a vision-capable model')
      const image = await this.backend().saveImage({ data: Buffer.concat([...this.chunks(value)]), mediaType: value.mediaType as ImageMediaType, name: value.name })
      await this.backend().readImage(image, signal)
      signal.throwIfAborted(); this.authorized(ticketId, request.id)
      return { id: value.id, name: value.name, sha256: value.sha256, image, untrusted: true }
    }
    if (request.offset > value.bytes) throw new UploadError(400, 'Attachment offset exceeds its length')
    const parts: Buffer[] = []; let position = 0, size = 0
    for (const bytes of this.chunks(value)) {
      if (position + bytes.length > request.offset && size < L.textBytes) { const part = bytes.subarray(Math.max(0, request.offset - position), Math.min(bytes.length, request.offset + L.textBytes - position)); parts.push(part); size += part.length }
      position += bytes.length
    }
    const bytes = Buffer.concat(parts)
    let text: string | undefined
    if (request.format === 'text') {
      if (bytes.includes(0)) throw new UploadError(400, 'Attachment is binary; request base64 or a file copy')
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: request.offset + size < value.bytes }) }
      catch { throw new UploadError(400, 'Attachment is not UTF-8 text; request base64 or a file copy') }
      // Do not lose a partial UTF-8 character at the page boundary.
      size = Buffer.byteLength(text)
    }
    this.authorized(ticketId, request.id)
    return { id: value.id, name: value.name, sha256: value.sha256, offset: request.offset, ...(text === undefined ? { data: bytes.toString('base64') } : { text }),
      nextOffset: request.offset + size < value.bytes ? request.offset + size : null, untrusted: true }
  }
  download(id: string): { value: UploadView; chunks: Iterable<Buffer> } {
    this.expire()
    const value = this.record(id); if (value.phase !== 'ready') throw new UploadError(409, 'Attachment is not ready')
    this.verify(value); return { value: this.view(value), chunks: this.chunks(value) }
  }
  async preview(id: string): Promise<{ mediaType: string; data: Uint8Array }> {
    this.expire()
    const value = this.record(id)
    if (value.phase !== 'ready' || !value.image || !images.has(value.mediaType)) throw new UploadError(409, 'An image preview is unavailable')
    this.verify(value); const backend = this.backend()
    const reference = await backend.saveImage({ data: Buffer.concat([...this.chunks(value)]), mediaType: value.mediaType as ImageMediaType, name: value.name })
    const image = await backend.readImage(reference, this.host.lifetime)
    return { mediaType: image.ref.mediaType, data: image.data }
  }
  /** Rebuild missing native image objects before resumed Sessions can reference them on a fresh installation. */
  async restoreImages(): Promise<void> {
    const ids = this.host.store.db.prepare("SELECT DISTINCT upload FROM inbox_attachment_binding b JOIN inbox_upload u ON u.id=b.upload WHERE json_extract(u.value,'$.image') IS NOT NULL ORDER BY upload").all().map(row => String(row.upload))
    if (!ids.length) return
    const backend = this.backend()
    for (const id of ids) {
      this.host.lifetime.throwIfAborted(); const value = this.record(id)
      if (value.phase !== 'ready' || !value.image) continue
      this.verify(value)
      const image = await backend.saveImage({ data: Buffer.concat([...this.chunks(value)]), mediaType: value.mediaType as ImageMediaType, name: value.name })
      const expected = value.image
      if (image.attachmentId !== expected.attachmentId || image.mediaType !== expected.mediaType || image.bytes !== expected.bytes || image.width !== expected.width || image.height !== expected.height)
        throw new UploadError(409, 'Restored image normalization differs from its original Session reference; use the matching Harness attachment backend')
      await backend.readImage(image, this.host.lifetime)
    }
  }
  async copy(ticketId: string, id: string, agent: Agent | undefined, signal: AbortSignal): Promise<{ path: string; sha256: string; bytes: number; untrusted: true }> {
    signal.throwIfAborted()
    const value = this.authorized(ticketId, id), ticket = this.host.store.tickets.get(ticketId)!
    const cwd = ticket.execution?.directory
    if (!agent || !cwd || agent.session.header.cwd !== cwd) throw new UploadError(409, 'Input copy requires the task’s bound execution directory')
    const persona = ticket.execution?.persona
    if (persona && (personaDenial(persona, 'write') || personaDenial(persona, 'bash'))) throw new UploadError(409, 'Input copy requires this persona’s write and command capabilities')
    this.verify(value)
    const suffix = extname(value.name), name = `input-${value.id}-${value.sha256.slice(0, 12)}${/^\.[A-Za-z0-9]{1,12}$/.test(suffix) ? suffix : ''}`
    // Agent contexts do not inject subprocess. Resolve the actual mounted preset service explicitly,
    // retaining its execution binding; an unavailable remote provider must never fall back to local execution.
    const registry = agent.ctx.get('agentPresets') as { serviceFor?: (agent: Agent, name: string) => SubprocessRuntime | undefined } | undefined
    const subprocess = (registry?.serviceFor?.(agent, 'subprocess') ?? agent.ctx.get('subprocess')) as (SubprocessRuntime & { executionBinding?: string }) | undefined
    const world = ticket.execution?.environment?.world
    if (!subprocess || (world && subprocess.executionBinding !== world)) throw new UploadError(409, 'The task’s Harness process service is unavailable or belongs to a different execution world')
    const node = await subprocess.resolveExecutable('node', undefined, signal)
    let offset = 0
    const copy = async (bytes: Buffer): Promise<boolean> => {
      signal.throwIfAborted(); this.authorized(ticketId, id)
      const handle = subprocess.spawn({ argv: [node, '--input-type=commonjs', '-e', COPY_INPUT_PROGRAM, name, String(value.bytes), value.sha256, String(offset), sha256(bytes)],
        cwd, signal, graceMs: 1000, stdio: { stdin: { data: bytes.toString('base64') }, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
      const result = await handle.done
      if (!await handle.waitForExit(signal) || result.exitCode !== 0 || handle.collected.stdout?.readFrom(0).lossy)
        throw new UploadError(409, 'Input copy did not complete; inspect its execution receipts before retrying')
      let output: { complete?: boolean; bytes?: number; sha256?: string }
      try { output = JSON.parse(handle.collected.stdout!.readFrom(0).text) as typeof output } catch { throw new UploadError(409, 'Input copy returned an invalid receipt') }
      if (output.sha256 !== value.sha256 || typeof output.complete !== 'boolean' || output.bytes !== (output.complete ? value.bytes : offset + bytes.length))
        throw new UploadError(409, 'Input copy receipt differs from its original source')
      this.authorized(ticketId, id); return output.complete
    }
    for (const bytes of this.chunks(value)) { if (await copy(bytes)) return { path: join(cwd, name), sha256: value.sha256, bytes: value.bytes, untrusted: true }; offset += bytes.length }
    if (!await copy(Buffer.alloc(0))) throw new UploadError(409, 'Input copy was not committed')
    return { path: join(cwd, name), sha256: value.sha256, bytes: value.bytes, untrusted: true }
  }
  async stop(): Promise<void> { await Promise.allSettled(this.finishing.values()) }
}
