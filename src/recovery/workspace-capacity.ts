/** Observed staging capacity, not a reservation, quota grant or activation authority. */
import { lstat, realpath, statfs } from 'node:fs/promises'
import type { WorkspaceRecoveryEntry } from './workspace-tree.ts'

export function workspaceStagingDemand(entries: WorkspaceRecoveryEntry[], manifestBytes: number, blockSize: bigint) {
  if (blockSize <= 0n || !Number.isSafeInteger(manifestBytes) || manifestBytes < 0) throw new Error('Invalid workspace capacity inputs')
  const round = (bytes: bigint) => ((bytes + blockSize - 1n) / blockSize) * blockSize
  // Candidate container + original and replacement hold records + source manifest.
  // Each directory/link receives one block allowance; physical metadata can cost more.
  let bytes = blockSize + 2n * round(32768n) + round(BigInt(manifestBytes)), inodes = 4n
  for (const entry of entries) {
    if (entry.kind === 'file' && entry.hardlinkTo) continue
    inodes++
    if (entry.kind === 'file') {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes! < 0) throw new Error('Invalid workspace file capacity')
      bytes += round(BigInt(entry.bytes!))
    } else bytes += blockSize
  }
  return { bytes, inodes }
}

export async function checkWorkspaceStagingCapacity(parent: string, entries: WorkspaceRecoveryEntry[], manifestBytes: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const root = await realpath(parent), before = await lstat(root, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Workspace capacity target must be a directory')
  const space = await statfs(root, { bigint: true }), demand = workspaceStagingDemand(entries, manifestBytes, space.bsize)
  if (space.bavail < 0n || space.ffree < 0n || space.files < 0n) throw new Error('Workspace capacity observation is invalid')
  if (space.bavail * space.bsize < demand.bytes) throw new Error('Insufficient available bytes for workspace staging')
  // Some filesystems report no finite inode pool (files=0); do not invent an inode guarantee there.
  if (space.files > 0n && space.ffree < demand.inodes) throw new Error('Insufficient available inodes for workspace staging')
  const after = await lstat(root, { bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || await realpath(parent) !== root)
    throw new Error('Workspace capacity target identity changed')
  signal.throwIfAborted()
  return { device: before.dev.toString(), inode: before.ino.toString(), requiredBytes: demand.bytes.toString(), requiredInodes: demand.inodes.toString(),
    availableBytes: (space.bavail * space.bsize).toString(), availableInodes: space.files > 0n ? space.ffree.toString() : null,
    reserved: false as const, quotaVerified: false as const }
}
