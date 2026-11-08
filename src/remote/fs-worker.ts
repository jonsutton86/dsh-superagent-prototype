/** One bounded filesystem RPC executed INSIDE the same bubblewrap world as worker commands. No endpoint credentials enter this process. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { realpath, readlink, stat, lstat, readdir, open, writeFile, rename, unlink, link, type FileHandle } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute, join } from 'node:path'
import type { FsTarget, FsInfo, FsPathInfo, FsWriteOutcome, FsEditOutcome } from '@deepseek-ai/dsh-fs'
import type { RpcRequest } from './protocol.ts'
import { MAX_TEXT, MAX_WINDOW } from './limits.ts'

/** Stable filesystem error vocabulary without importing the Harness runtime into this confined helper. */
class FileFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}
const fail = (code: string, message: string): never => { throw new FileFailure(code, message) }
const contains = (root: string, path: string) => { const value = relative(root, path); return !isAbsolute(value) && value !== '..' && !value.startsWith('../') }
async function canonical(path: string, links = 0): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A missing target can still have a symlink directory entry. Follow that entry before resolving an absent leaf.
    const entry = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined })
    if (entry?.isSymbolicLink()) {
      if (links >= 40) return fail('FS_IO_ERROR', 'Too many symbolic links')
      return canonical(resolve(dirname(path), await readlink(path)), links + 1)
    }
    const parent = dirname(path); if (parent === path) throw error
    return join(await canonical(parent, links), path.slice(parent.length))
  }
}
async function metadata(path: string, follow = true): Promise<(FsInfo | FsPathInfo) | null> {
  try {
    const value = await (follow ? stat : lstat)(path, { bigint: true })
    const version = createHash('sha256').update(`${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`).digest('hex') as FsInfo['version']
    return { version, type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'other', size: Number(value.size) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
async function readWindow(handle: FileHandle, length: number, offset: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length); let received = 0
  while (received < length) {
    const { bytesRead } = await handle.read(bytes, received, length - received, offset + received)
    if (!bytesRead) break
    received += bytesRead
  }
  return bytes.subarray(0, received)
}
async function text(path: string): Promise<string> {
  const info = await metadata(path)
  if (!info) return fail('FS_NOT_FOUND', 'File not found')
  if (info.type !== 'file') return fail('FS_NOT_REGULAR_FILE', 'Not a regular file')
  if (info.size! > MAX_TEXT) return fail('FS_TOO_LARGE', 'Text exceeds the bounded mutation/read limit')
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) return fail('FS_NOT_REGULAR_FILE', 'Not a regular file')
    const bytes = await readWindow(handle, MAX_TEXT + 1, 0)
    if (bytes.length > MAX_TEXT) return fail('FS_TOO_LARGE', 'File grew beyond read limit')
    if (bytes.includes(0)) return fail('FS_NOT_TEXT', 'File contains binary data')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { return fail('FS_NOT_TEXT', 'File is not UTF-8 text') }
  } finally { await handle.close() }
}
async function execute(root: string, request: RpcRequest): Promise<unknown> {
  if (!request.op.startsWith('fs.') || !('path' in request)) return fail('FS_PERMISSION_DENIED', 'Filesystem operation required')
  const path = resolve('cwd' in request ? request.cwd ?? root : root, request.path)
  if (!contains(root, path)) return fail('FS_SANDBOX_DENIED', 'Path is outside the granted workspace')
  const targetPath = request.op === 'fs.lstat' ? await canonical(path === root ? root : dirname(path)) : await canonical(path)
  if (!contains(root, targetPath)) return fail('FS_SANDBOX_DENIED', 'Path resolves outside the granted workspace')
  const target = (path: string): FsTarget => ({ targetKey: path as FsTarget['targetKey'], displayPath: path })
  switch (request.op) {
    case 'fs.resolve': return target(targetPath)
    case 'fs.stat': return metadata(targetPath)
    case 'fs.lstat': return metadata(path, false)
    case 'fs.read': return text(targetPath)
    case 'fs.bytes': {
      if (request.length > MAX_WINDOW) return fail('FS_TOO_LARGE', 'Byte window exceeds the endpoint limit')
      const handle = await open(targetPath, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        if (!(await handle.stat()).isFile()) return fail('FS_NOT_REGULAR_FILE', 'Not a regular file')
        return (await readWindow(handle, request.length, request.offset)).toString('base64')
      } finally { await handle.close() }
    }
    case 'fs.list': {
      const names = await readdir(targetPath)
      if (names.length > 2000) return fail('FS_TOO_LARGE', 'Directory exceeds listing limit')
      const result = []
      for (const name of names.sort()) {
        const path = await canonical(join(targetPath, name))
        if (!contains(root, path)) return fail('FS_SANDBOX_DENIED', 'Directory contains a link outside the workspace')
        const info = await metadata(path)
        if (info) result.push({ name, ...info, target: target(path) })
      }
      return result
    }
    case 'fs.write': case 'fs.edit': {
      const beforeInfo = await metadata(targetPath), normalize = (value: string) => value.replace(/\r\n/g, '\n')
      if (beforeInfo && beforeInfo.type !== 'file') return fail('FS_NOT_REGULAR_FILE', 'Not a regular file')
      if (request.expected && 'kind' in request.expected && request.expected.kind === 'createIfAbsent' && beforeInfo)
        return fail('FS_NOT_OBSERVED', 'File already exists')
      if (request.expected && 'version' in request.expected && request.expected.version !== beforeInfo?.version)
        return fail('FS_STALE_VERSION', 'File changed since it was observed')
      let before: string | null = null, after: string
      if (beforeInfo) {
        try { before = normalize(await text(targetPath)) }
        catch (error) { if (!(request.op === 'fs.write' && error instanceof FileFailure && error.code === 'FS_NOT_TEXT')) throw error }
      }
      if (request.op === 'fs.write') after = normalize(request.content)
      else {
        if (before === null) return fail('FS_NOT_FOUND', 'File not found')
        const old = normalize(request.oldString), replacement = normalize(request.newString)
        const count = before.split(old).length - 1
        if (!count) return fail('FS_EDIT_NOT_FOUND', 'Text to replace was not found')
        if (!request.replaceAll && count !== 1) return fail('FS_AMBIGUOUS_EDIT', 'Text to replace matches more than once')
        after = request.replaceAll ? before.split(old).join(replacement) : before.replace(old, () => replacement)
      }
      if (Buffer.byteLength(after) > MAX_TEXT) return fail('FS_TOO_LARGE', 'Result exceeds mutation limit')
      const temporary = join(dirname(targetPath), `.dsh-write-${randomUUID()}`)
      await writeFile(temporary, after, { flag: 'wx', mode: 0o600 })
      try {
        const current = await metadata(targetPath)
        if (current?.version !== beforeInfo?.version) return fail('FS_STALE_VERSION', 'File changed during mutation')
        if (request.op === 'fs.write' && request.expected?.kind === 'createIfAbsent') await link(temporary, targetPath)
        else await rename(temporary, targetPath)
      } finally { await unlink(temporary).catch(() => {}) }
      const version = (await metadata(targetPath))!.version
      return request.op === 'fs.write' ? { operation: beforeInfo ? 'update' : 'create', version, before, after } satisfies FsWriteOutcome
        : { version, before: before!, after } satisfies FsEditOutcome
    }
  }
}

const chunks: Buffer[] = []; let bytes = 0
try {
  for await (const chunk of process.stdin) { const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > 2 * 1024 * 1024) fail('FS_TOO_LARGE', 'Filesystem request exceeds limit'); chunks.push(value) }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { root: string; request: RpcRequest }
  process.stdout.write(JSON.stringify({ result: await execute(input.root, input.request) }))
} catch (error) {
  const codes: Record<string, string> = { ENOENT: 'FS_NOT_FOUND', ENOTDIR: 'FS_NOT_DIRECTORY', EACCES: 'FS_PERMISSION_DENIED', EPERM: 'FS_SANDBOX_DENIED', EEXIST: 'FS_NOT_OBSERVED' }
  process.stdout.write(JSON.stringify({ error: { code: error instanceof FileFailure ? error.code : codes[(error as NodeJS.ErrnoException).code ?? ''] ?? 'FS_IO_ERROR',
    message: error instanceof Error ? error.message : 'Filesystem operation failed' } }))
}
