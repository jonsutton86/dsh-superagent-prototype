/** Capture bounded immutable inputs. The remote endpoint runs this module inside its filesystem confinement. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, stat, realpath, readdir, readlink, open, mkdir, writeFile, symlink, chmod } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SnapshotManifestSchema, type SnapshotSpec, type SnapshotManifest, type SnapshotEntry } from './model.ts'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
/** Schema parsing may reorder keys; the evidence digest must not depend on object insertion order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const inside = (root: string, path: string) => { const value = relative(root, path); return !isAbsolute(value) && value !== '..' && !value.startsWith('../') }
const safe = (path: string) => path.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
const identity = (info: Awaited<ReturnType<typeof stat>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
const execute = promisify(execFile)
async function repository(root: string, mode: SnapshotSpec['repository'], signal: AbortSignal): Promise<SnapshotManifest['repository']> {
  if (mode === 'none') return
  const exists = await lstat(join(root, '.git')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  if (!exists) { if (mode === 'required') throw new Error('Verification requires a Git repository rooted at the task directory'); return }
  const git = async (args: string[]) => {
    const result = await execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
      '-c', 'core.excludesFile=/dev/null', ...args], { cwd: root, signal, timeout: 5000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
    return result.stdout
  }
  if (await realpath((await git(['rev-parse', '--show-toplevel'])).trim()) !== root) throw new Error('Verification repository root differs from the captured task directory')
  const commit = (await git(['rev-parse', '--verify', 'HEAD'])).trim(), tree = (await git(['rev-parse', '--verify', 'HEAD^{tree}'])).trim()
  if (![commit, tree].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) throw new Error('Git returned an invalid revision')
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const statusHash = hash(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']))
  return { commit, tree, branch: branch === 'HEAD' ? null : branch, statusHash }
}
/** Hash every included path, preserving executable bits and in-tree links; copies become private read-only inputs. */
export async function captureSnapshot(source: string, spec: SnapshotSpec, signal: AbortSignal, destination?: string): Promise<SnapshotManifest> {
  const root = await realpath(source), rootBefore = await stat(root), exclude = [...new Set(['.git', ...spec.exclude])].sort()
  if (!rootBefore.isDirectory()) throw new Error('Snapshot source must be a directory')
  if (destination && (inside(root, resolve(destination)) || inside(resolve(destination), root))) throw new Error('Snapshot storage must be outside its source')
  const initialRepository = await repository(root, spec.repository, signal), entries: SnapshotEntry[] = []
  let files = 0, bytes = 0, manifestBytes = 0
  const omitted = (path: string) => path.split('/').includes('.git') || exclude.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
  const append = (entry: SnapshotEntry) => {
    if (++files > spec.maxFiles) throw new Error('Snapshot exceeds its path limit; no partial snapshot is accepted')
    manifestBytes += Buffer.byteLength(JSON.stringify(entry)) + 1
    if (manifestBytes > 2 * 1024 * 1024) throw new Error('Snapshot manifest exceeds 2 MiB')
    entries.push(entry)
  }
  if (destination) await mkdir(destination, { mode: 0o700 })
  const walk = async (directory: string) => {
    signal.throwIfAborted()
    const full = join(root, directory), before = await lstat(full)
    if (!before.isDirectory() || await realpath(full) !== full) throw new Error('Snapshot directory changed or was replaced by a link')
    const names = (await readdir(full)).sort()
    if (names.length > spec.maxFiles) throw new Error('Snapshot directory exceeds its path limit')
    for (const name of names) {
      signal.throwIfAborted()
      const path = directory ? `${directory}/${name}` : name
      if (!safe(path)) throw new Error('Snapshot path cannot be represented safely')
      if (omitted(path)) continue
      const original = join(root, path), info = await lstat(original)
      if (info.isSymbolicLink()) {
        const resolved = await realpath(original)
        if (!inside(root, resolved)) throw new Error(`Snapshot link leaves the source: ${path}`)
        const target = relative(root, resolved).split('\\').join('/') || '.'
        if (omitted(target)) throw new Error(`Snapshot link targets excluded input: ${path}`)
        // Reading twice rejects an observed link replacement. Execution uses only the copied canonical target.
        const text = await readlink(original)
        if (await realpath(original) !== resolved || await readlink(original) !== text) throw new Error(`Snapshot link changed: ${path}`)
        append({ path, kind: 'symlink', target })
        if (destination) await symlink(relative(dirname(join(destination, path)), join(destination, target)) || '.', join(destination, path))
      } else if (info.isDirectory()) {
        append({ path, kind: 'directory' }); if (destination) await mkdir(join(destination, path), { mode: 0o700 })
        await walk(path)
      } else if (info.isFile()) {
        if (await realpath(original) !== original) throw new Error(`Snapshot file ancestor changed before opening: ${path}`)
        const handle = await open(original, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || identity(opened) !== identity(info)) throw new Error(`Snapshot file changed before opening: ${path}`)
          if (opened.size > spec.maxBytes - bytes) throw new Error('Snapshot exceeds its byte limit; no partial snapshot is accepted')
          const chunks: Buffer[] = []; let count = 0
          while (count < opened.size + 1) {
            signal.throwIfAborted()
            const chunk = Buffer.alloc(Math.min(65536, opened.size + 1 - count)), read = await handle.read(chunk, 0, chunk.length, count)
            if (!read.bytesRead) break
            count += read.bytesRead; chunks.push(chunk.subarray(0, read.bytesRead))
          }
          if (count !== opened.size || identity(await handle.stat()) !== identity(opened) || identity(await lstat(original)) !== identity(opened) || await realpath(original) !== original)
            throw new Error(`Snapshot file changed while reading: ${path}`)
          const content = Buffer.concat(chunks), executable = !!(opened.mode & 0o111)
          bytes += content.length; append({ path, kind: 'file', bytes: content.length, hash: hash(content), executable })
          if (destination) await writeFile(join(destination, path), content, { flag: 'wx', mode: executable ? 0o555 : 0o444 })
        } finally { await handle.close() }
      } else throw new Error(`Snapshot refuses a device, socket or special file: ${path}`)
    }
    const after = await lstat(full)
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error(`Snapshot directory changed during capture: ${directory || '.'}`)
  }
  await walk('')
  const capturedPaths = new Set(['.', ...entries.map(entry => entry.path)])
  if (entries.some(entry => entry.kind === 'symlink' && !capturedPaths.has(entry.target!))) throw new Error('Snapshot link target is absent from the complete manifest')
  const finalRepository = await repository(root, spec.repository, signal), rootAfter = await stat(root)
  if (JSON.stringify(initialRepository) !== JSON.stringify(finalRepository) || rootBefore.dev !== rootAfter.dev || rootBefore.ino !== rootAfter.ino || await realpath(source) !== root)
    throw new Error('Source directory or Git revision changed during capture')
  if (destination) {
    for (const entry of [...entries].reverse()) if (entry.kind === 'directory') await chmod(join(destination, entry.path), 0o555)
    await chmod(destination, 0o555)
  }
  const value = { version: 1 as const, exclude, entries, ...(initialRepository ? { repository: initialRepository } : {}) }
  return { ...value, hash: hash(canonical(value)), capturedAt: new Date().toISOString(), source: root, files, bytes }
}
/** Content equality ignores capture location/time and repository metadata unavailable inside a source-only copy. */
export function sameSnapshotFiles(a: SnapshotManifest, b: SnapshotManifest): boolean {
  return canonical(a.entries) === canonical(b.entries) && canonical(a.exclude) === canonical(b.exclude)
}
/** Validate manifest integrity; authority still depends on the authenticated host receipt, never a model-supplied hash. */
export function validateSnapshot(input: unknown): SnapshotManifest {
  const value = SnapshotManifestSchema.parse(input)
  const body = { version: value.version, exclude: value.exclude, entries: value.entries, ...(value.repository ? { repository: value.repository } : {}) }
  if (value.hash !== hash(canonical(body)) || value.files !== value.entries.length
    || new Set(value.entries.map(entry => entry.path)).size !== value.files
    || value.bytes !== value.entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.bytes : 0), 0)) throw new Error('Snapshot manifest digest or totals do not match its inputs')
  return value
}
