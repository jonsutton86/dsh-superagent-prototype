/** Read-only inspection of a held candidate against an independently authenticated archive manifest. */
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { privateInput } from './crypto.ts'
import { inventoryWorkspaceRecovery, type WorkspaceRecoveryEntry } from './workspace-tree.ts'
import type { verifyWorkspaceRecovery } from './workspace-verify.ts'
import type { WorkspaceRecoveryOrigin } from './workspace-stage.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/), path = z.string().max(4096).startsWith('/').refine(value => !value.includes('\0'))
const holdSchema = z.object({ version: z.literal(1), id: z.string().uuid(), path, workspace: path, source: path,
  inventoryHash: digest, state: z.literal('held'), contentReconstructed: z.literal(true), metadataApplied: z.literal(false),
  executionOwnership: z.literal(false), restoreVerified: z.literal(false),
  origin: z.object({ checkpointId: z.string().uuid(), workspaceManifestSHA256: digest }).strict() }).strict()
async function readPrivate(path: string, max: number, signal: AbortSignal) {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of privateInput(path, signal)) {
    bytes += chunk.length
    if (bytes > max) throw new Error('Held workspace metadata exceeds its bound')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
export async function verifyHeldWorkspaceCandidate(destination: string,
  manifest: Awaited<ReturnType<typeof verifyWorkspaceRecovery>>['manifest'], origin: WorkspaceRecoveryOrigin, signal: AbortSignal) {
  signal.throwIfAborted()
  const info = await lstat(destination)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error('Held workspace candidate must remain private and owned')
  const root = await realpath(destination), holdBytes = await readPrivate(join(root, 'hold.json'), 32768, signal)
  const hold = holdSchema.parse(JSON.parse(holdBytes.toString('utf8')))
  if (hold.path !== root || hold.workspace !== join(root, 'workspace') || hold.source !== manifest.source || hold.inventoryHash !== manifest.sha256
    || hold.origin.checkpointId !== origin.checkpointId || hold.origin.workspaceManifestSHA256 !== origin.workspaceManifestSHA256)
    throw new Error('Held workspace origin differs from the authenticated checkpoint')
  const savedManifest = await readPrivate(join(root, 'source-manifest.json'), 80 * 1024 * 1024, signal)
  if (createHash('sha256').update(savedManifest).digest('hex') !== origin.workspaceManifestSHA256)
    throw new Error('Held workspace source manifest differs from the authenticated checkpoint')
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(['hold.json', 'source-manifest.json', 'workspace']))
    throw new Error('Held workspace candidate has unexpected members')
  const workspaceInfo = await lstat(hold.workspace)
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink() || workspaceInfo.uid !== process.getuid?.() || (workspaceInfo.mode & 0o7777) !== 0o700)
    throw new Error('Held workspace root was replaced or exposed')
  const current = await inventoryWorkspaceRecovery(hold.workspace, { maxEntries: manifest.entries.length, maxBytes: manifest.bytes }, signal)
  if (current.source !== hold.workspace) throw new Error('Held workspace root changed during verification')
  const project = (entries: WorkspaceRecoveryEntry[]) => entries.map(({ mode: _mode, uid: _uid, gid: _gid, ...entry }) => entry)
  if (JSON.stringify(project(current.entries)) !== JSON.stringify(project(manifest.entries))) throw new Error('Held workspace content differs from authenticated archive')
  if (current.entries.some(entry => entry.uid !== process.getuid?.()
    || entry.kind === 'file' && entry.mode !== 0o600 || entry.kind === 'directory' && entry.mode !== 0o700))
    throw new Error('Held workspace private ownership or modes changed')
  if (!holdBytes.equals(await readPrivate(join(root, 'hold.json'), 32768, signal))) throw new Error('Held workspace record changed during verification')
  signal.throwIfAborted()
  return { ...hold, contentVerified: true as const, executionOwnership: false as const, restoreVerified: false as const }
}
