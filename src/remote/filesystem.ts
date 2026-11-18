import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, type FsTarget, type FsInfo, type FsPathInfo, type FsDirEntry,
  type FsWriteIntent, type FsWriteOutcome, type FsEditRequest, type FsEditOutcome, type FsVersion } from '@deepseek-ai/dsh-fs'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAX_WINDOW, type RemoteGrant } from './protocol.ts'
import type { RemoteClient } from './client.ts'
import { worldBinding } from './world-journal.ts'

/** Harness filesystem provider paired with one authenticated remote process world. Host files are never implicitly mapped. */
export class RemoteFileSystem extends FileSystem {
  readonly executionBinding: string
  private readonly targets = new Map<string, string>()
  constructor(ctx: Context, private readonly client: RemoteClient, private readonly grant: RemoteGrant) {
    super(ctx); client.bindGrant(grant); this.executionBinding = worldBinding(client.connection.endpointId, grant)
  }
  private target(value: FsTarget): FsTarget {
    const key = FsTargetKey(`${this.client.connection.endpointId}:${this.grant.id}:${this.grant.epoch}:${value.targetKey}`)
    this.targets.set(key, value.displayPath)
    return { targetKey: key, displayPath: value.displayPath }
  }
  private path(target: FsTarget): string {
    const path = this.targets.get(target.targetKey)
    if (!path || path !== target.displayPath) throw new FsError('Target belongs to another execution world', 'FS_SANDBOX_DENIED')
    return path
  }
  async resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.target(await this.client.call<FsTarget>({ op: 'fs.resolve', path, cwd: options?.cwd ?? this.grant.root }, options?.signal))
  }
  processPath(target: FsTarget): string { return this.path(target) }
  fileUrl(target: FsTarget): string { return pathToFileURL(this.path(target), { windows: false }).href }
  contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.path(parent), this.path(child))
    return relative === '' || (!posix.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'))
  }
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> { return await this.client.call<FsInfo | null>({ op: 'fs.stat', path: this.path(target) }, signal) ?? undefined }
  async lstat(path: string, options?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return await this.client.call<FsPathInfo | null>({ op: 'fs.lstat', path, cwd: options?.cwd ?? this.grant.root }, signal) ?? undefined
  }
  readText(target: FsTarget, signal?: AbortSignal): Promise<string> { return this.client.call({ op: 'fs.read', path: this.path(target) }, signal) }
  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const fs = this
    return { async *[Symbol.asyncIterator]() {
      const decoder = new TextDecoder('utf-8', { fatal: true }); let offset = 0
      for (;;) {
        const bytes = await fs.readByteRange(target, { offset, length: MAX_WINDOW }, signal)
        if (bytes.includes(0)) throw new FsError('File is binary', 'FS_NOT_TEXT')
        let text: string
        try { text = decoder.decode(bytes, { stream: bytes.length > 0 }) } catch { throw new FsError('File is not UTF-8 text', 'FS_NOT_TEXT') }
        if (text) yield text
        if (!bytes.length) return
        offset += bytes.length
      }
    } }
  }
  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new FsError('Invalid read bound', 'FS_TOO_LARGE')
    const info = await this.stat(target, signal)
    if (!info) throw new FsError('File not found', 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError('Not a regular file', 'FS_NOT_REGULAR_FILE')
    if ((info.size ?? 0) > maxBytes) throw new FsError('File exceeds read bound', 'FS_TOO_LARGE')
    const chunks: Uint8Array[] = []; let offset = 0
    for (;;) {
      const bytes = await this.readByteRange(target, { offset, length: Math.min(MAX_WINDOW, maxBytes - offset + 1) }, signal)
      if (offset + bytes.length > maxBytes) throw new FsError('File grew beyond read bound', 'FS_TOO_LARGE')
      if (!bytes.length) return Buffer.concat(chunks)
      chunks.push(bytes); offset += bytes.length
    }
  }
  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 0)
      throw new FsError('Invalid byte range', 'FS_IO_ERROR')
    const chunks: Buffer[] = []; let count = 0
    while (count < range.length) {
      const size = Math.min(MAX_WINDOW, range.length - count)
      const result = await this.client.call<string>({ op: 'fs.bytes', path: this.path(target), offset: range.offset + count, length: size }, signal)
      const bytes = Buffer.from(result, 'base64'); if (bytes.length > size) throw new FsError('Endpoint exceeded requested range', 'FS_IO_ERROR')
      chunks.push(bytes); count += bytes.length
      if (bytes.length < size) break
    }
    return Buffer.concat(chunks)
  }
  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await this.client.call<FsDirEntry[]>({ op: 'fs.list', path: this.path(target) }, signal)
    return entries.map(entry => ({ ...entry, target: this.target(entry.target) }))
  }
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return this.client.mutation({ op: 'fs.write', path: this.path(target), content, expected }, signal)
  }
  editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return this.client.mutation({ op: 'fs.edit', path: this.path(target), ...edit, expected }, signal)
  }
}
