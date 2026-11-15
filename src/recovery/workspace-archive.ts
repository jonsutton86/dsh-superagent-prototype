/** Private full-content capture. No extraction, execution, or claim of a globally frozen source. */
import { mkdir, open, realpath, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { privateDirectory } from '../environments/endpoint-files.ts'
import { inside } from '../remote/journal.ts'
import { inventoryWorkspaceRecovery } from './workspace-tree.ts'

const sync = async (path: string) => { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
export async function captureWorkspaceRecovery(source: string, destination: string,
  limits: Parameters<typeof inventoryWorkspaceRecovery>[1], signal = new AbortController().signal) {
  signal.throwIfAborted()
  if (!isAbsolute(destination)) throw new Error('Workspace archive destination must be absolute')
  const root = await realpath(source), parent = privateDirectory(await realpath(dirname(destination)))
  const target = join(parent, basename(resolve(destination)))
  if (inside(root, target) || inside(target, root)) throw new Error('Workspace archive must be separate from its source')
  await mkdir(target, { mode: 0o700 }) // Never overwrite an existing or interrupted capture.
  const content: { path: string; member: string; bytes: number; sha256: string }[] = []
  let active: FileHandle | undefined, member = ''
  try {
    const inventory = await inventoryWorkspaceRecovery(root, limits, signal, {
      async begin() {
        member = `content-${content.length}.bin`
        active = await open(join(target, member), 'wx', 0o600)
      },
      async write(chunk) {
        let offset = 0
        while (offset < chunk.length) {
          signal.throwIfAborted()
          const result = await active!.write(chunk, offset, chunk.length - offset)
          if (!result.bytesWritten) throw new Error('Workspace archive write made no progress')
          offset += result.bytesWritten
        }
      },
      async end(path, bytes, sha256) {
        await active!.sync(); await active!.close(); active = undefined
        content.push({ path, member, bytes, sha256 })
      },
    })
    signal.throwIfAborted()
    const manifest = { ...inventory, content, contentArchived: true, executionQuiescenceVerified: false, restoreVerified: false }
    await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    await sync(join(target, 'manifest.json')); await sync(target); await sync(parent)
    signal.throwIfAborted()
    return { path: target, manifest }
  } finally { await active?.close() } // Retain failed output without a completed manifest; do not replay capture.
}
