/** Full workspace evidence. Caller must separately establish a frozen source; this is not a backup or quiescence proof. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const limits = z.object({ maxEntries: z.number().int().min(1).max(100000), maxBytes: z.number().int().min(0).max(2 ** 40) }).strict()
export interface WorkspaceRecoveryEntry { path: string; mode: number; uid: number; gid: number; kind: 'directory' | 'file' | 'symlink';
  bytes?: number; sha256?: string; target?: string; hardlinkTo?: string }
const identity = (info: Awaited<ReturnType<typeof lstat>>) =>
  [info.dev, info.ino, info.mode, info.nlink, info.uid, info.gid, info.size, info.mtimeMs, info.ctimeMs].join(':')
export interface WorkspaceContentSink {
  begin(path: string): Promise<void>
  write(chunk: Buffer): Promise<void>
  end(path: string, bytes: number, sha256: string): Promise<void>
}
export async function inventoryWorkspaceRecovery(source: string, input: z.input<typeof limits>, signal = new AbortController().signal, sink?: WorkspaceContentSink) {
  const budget = limits.parse(input); signal.throwIfAborted()
  const root = await realpath(source), initial = await lstat(root)
  if (!initial.isDirectory()) throw new Error('Recovery workspace must be a directory')
  const entries: WorkspaceRecoveryEntry[] = [], witnesses: { path: string; identity: string }[] = []
  const inodes = new Map<string, { path: string; links: number; seen: number; hash: string; bytes: number }>()
  let bytes = 0, metadataBytes = 0
  const add = (entry: WorkspaceRecoveryEntry) => {
    metadataBytes += Buffer.byteLength(JSON.stringify(entry))
    if (entries.length >= budget.maxEntries || metadataBytes > 32 * 1024 * 1024) throw new Error('Recovery workspace inventory exceeds its entry budget')
    entries.push(entry)
  }
  const walk = async (relative: string): Promise<void> => {
    signal.throwIfAborted()
    const path = relative ? join(root, relative) : root, before = await lstat(path)
    if (relative.length > 4096 || relative.includes('\0')) throw new Error('Recovery workspace path is not representable')
    const entry = { path: relative || '.', mode: before.mode & 0o7777, uid: before.uid, gid: before.gid }
    witnesses.push({ path, identity: identity(before) })
    if (before.isSymbolicLink()) {
      add({ ...entry, kind: 'symlink', target: await readlink(path) })
    } else if (before.isDirectory()) {
      if (await realpath(path) !== path) throw new Error('Recovery workspace directory identity changed')
      add({ ...entry, kind: 'directory' })
      const names = (await readdir(path)).sort()
      if (names.length > budget.maxEntries - entries.length) throw new Error('Recovery workspace inventory exceeds its entry budget')
      for (const name of names) await walk(relative ? `${relative}/${name}` : name)
    } else if (before.isFile()) {
      if (before.size > budget.maxBytes - bytes) throw new Error('Recovery workspace inventory exceeds its byte budget')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || identity(opened) !== identity(before) || await realpath(path) !== path)
          throw new Error('Recovery workspace file identity changed')
        await sink?.begin(relative)
        const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let size = 0
        while (true) {
          signal.throwIfAborted()
          const result = await handle.read(buffer, 0, buffer.length, size)
          if (!result.bytesRead) break
          size += result.bytesRead
          if (size > before.size || size > budget.maxBytes - bytes) throw new Error('Recovery workspace file grew during inventory')
          hash.update(buffer.subarray(0, result.bytesRead))
          await sink?.write(buffer.subarray(0, result.bytesRead))
        }
        if (size !== before.size || identity(await handle.stat()) !== identity(before)) throw new Error('Recovery workspace file changed during inventory')
        const digest = hash.digest('hex'), key = `${opened.dev}:${opened.ino}`, prior = inodes.get(key)
        if (prior && (prior.links !== opened.nlink || prior.hash !== digest || prior.bytes !== size)) throw new Error('Recovery workspace hard-link identity changed')
        if (prior) prior.seen++
        else inodes.set(key, { path: relative, links: opened.nlink, seen: 1, hash: digest, bytes: size })
        await sink?.end(relative, size, digest)
        bytes += size
        add({ ...entry, kind: 'file', bytes: size, sha256: digest, ...(prior ? { hardlinkTo: prior.path } : {}) })
      } finally { await handle.close() }
    } else throw new Error('Recovery workspace contains an unsupported special file')
    if (identity(await lstat(path)) !== identity(before)) throw new Error('Recovery workspace changed during inventory')
  }
  await walk('')
  for (const inode of inodes.values()) if (inode.links !== inode.seen) throw new Error('Recovery workspace has hard links outside the captured tree')
  // Recheck earlier paths too. This detects observed changes; it cannot replace an external execution fence.
  for (const witness of witnesses) {
    signal.throwIfAborted()
    if (identity(await lstat(witness.path)) !== witness.identity) throw new Error('Recovery workspace changed before inventory completion')
  }
  if (await realpath(source) !== root) throw new Error('Recovery workspace root changed')
  const body = { version: 1, entries, bytes }
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    source: root, sourceIdentity: `${initial.dev}:${initial.ino}`, executionQuiescenceVerified: false, contentArchived: false, restoreVerified: false }
}
