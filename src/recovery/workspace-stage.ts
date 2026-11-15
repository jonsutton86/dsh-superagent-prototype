/** Reconstruct verified bytes/links into a new private held candidate. Never activate or overwrite a workspace. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, link, mkdir, open, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { privateDirectory } from '../environments/endpoint-files.ts'
import { inside } from '../remote/journal.ts'
import { inventoryWorkspaceRecovery } from './workspace-tree.ts'
import { verifyWorkspaceRecovery } from './workspace-verify.ts'

const sync = async (path: string) => { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
export interface WorkspaceRecoveryOrigin { checkpointId: string; workspaceManifestSHA256: string }
export async function stageWorkspaceRecovery(archive: string, destination: string, signal = new AbortController().signal, origin?: WorkspaceRecoveryOrigin) {
  signal.throwIfAborted()
  if (!isAbsolute(destination) || resolve(destination) !== destination) throw new Error('Workspace staging destination must be absolute and normalized')
  const originalArchive = await realpath(archive), parent = privateDirectory(await realpath(dirname(destination)))
  const target = join(parent, basename(resolve(destination)))
  if (inside(originalArchive, target) || inside(target, originalArchive)) throw new Error('Workspace staging must be separate from its archive')
  const id = randomUUID()
  let receipt: { id: string; path: string; workspace: string; source: string; inventoryHash: string; state: 'held'; origin?: WorkspaceRecoveryOrigin;
    contentReconstructed: true; metadataApplied: false; executionOwnership: false; restoreVerified: false } | undefined
  await verifyWorkspaceRecovery(originalArchive, signal, async verified => {
    const manifest: Awaited<ReturnType<typeof verifyWorkspaceRecovery>>['manifest'] = JSON.parse(await readFile(join(verified, 'manifest.json'), 'utf8'))
    if (inside(resolve(manifest.source), target) || inside(target, resolve(manifest.source))) throw new Error('Workspace staging must be separate from its original source')
    await mkdir(target, { mode: 0o700 })
    const workspace = join(target, 'workspace'), hold = { version: 1, id, source: manifest.source, inventoryHash: manifest.sha256,
      state: 'preparing', ...(origin ? { origin } : {}), executionOwnership: false, metadataApplied: false, restoreVerified: false }
    await writeFile(join(target, 'hold.json'), JSON.stringify(hold), { flag: 'wx', mode: 0o600 })
    await sync(join(target, 'hold.json')); await sync(target); await sync(parent)
    await mkdir(workspace, { mode: 0o700 })
    const content = new Map(manifest.content.map(item => [item.path, item.member]))
    for (const item of manifest.entries) {
      signal.throwIfAborted()
      if (item.path === '.' || item.kind === 'symlink') continue
      const path = join(workspace, item.path)
      if (item.kind === 'directory') await mkdir(path, { mode: 0o700 })
      else if (item.hardlinkTo) await link(join(workspace, item.hardlinkTo), path)
      else {
        await copyFile(join(verified, content.get(item.path)!), path, constants.COPYFILE_EXCL)
        await chmod(path, 0o600); await sync(path)
      }
    }
    // Create links last: none can become an ancestor used for a subsequent write.
    for (const item of manifest.entries) if (item.kind === 'symlink') {
      signal.throwIfAborted(); await symlink(item.target, join(workspace, item.path))
    }
    const reconstructed = await inventoryWorkspaceRecovery(workspace, { maxEntries: manifest.entries.length, maxBytes: manifest.bytes }, signal)
    const project = (entries: typeof reconstructed.entries) => entries.map(({ mode: _mode, uid: _uid, gid: _gid, ...item }) => item)
    if (JSON.stringify(project(reconstructed.entries)) !== JSON.stringify(project(manifest.entries))) throw new Error('Reconstructed workspace content differs')
    // Original permission/ownership metadata is retained, not applied before target policy/ownership qualification.
    await copyFile(join(verified, 'manifest.json'), join(target, 'source-manifest.json'), constants.COPYFILE_EXCL)
    await sync(join(target, 'source-manifest.json'))
    for (const item of [...manifest.entries].reverse()) if (item.kind === 'directory') await sync(item.path === '.' ? workspace : join(workspace, item.path))
    signal.throwIfAborted()
    receipt = { id, path: target, workspace, source: manifest.source, inventoryHash: manifest.sha256, state: 'held', ...(origin ? { origin } : {}),
      contentReconstructed: true, metadataApplied: false, executionOwnership: false, restoreVerified: false }
    const pending = join(target, 'hold-complete.json')
    await writeFile(pending, JSON.stringify({ version: 1, ...receipt }), { flag: 'wx', mode: 0o600 }); await sync(pending)
    await rename(pending, join(target, 'hold.json')); await sync(target); await sync(parent)
  })
  return receipt!
}
