/** Reinspect an interrupted archive against its original source; never reconstruct or overwrite either tree. */
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyWorkspaceRecovery } from './workspace-verify.ts'
import { inventoryWorkspaceRecovery } from './workspace-tree.ts'
import type { WorkspaceCaptureRecord } from '../remote/workspace-capture.ts'

export async function reinspectWorkspaceCapture(record: WorkspaceCaptureRecord, expectedManifestHash: string, signal: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestHash)) throw new Error('Capture reconciliation requires the reviewed manifest digest')
  signal.throwIfAborted()
  let result: { path: string; inventoryHash: string; manifestHash: string } | undefined
  await verifyWorkspaceRecovery(record.request.destination, signal, async verified => {
    const bytes = await readFile(join(verified, 'manifest.json')), manifestHash = createHash('sha256').update(bytes).digest('hex')
    if (manifestHash !== expectedManifestHash) throw new Error('Capture archive differs from the reviewed manifest digest')
    const manifest = JSON.parse(bytes.toString('utf8'))
    const originalIdentity = record.binding.rootIdentity.split(':').slice(0, 2).join(':')
    if (manifest.source !== record.binding.root || manifest.sourceIdentity !== originalIdentity)
      throw new Error('Capture archive differs from the original source identity')
    const current = await inventoryWorkspaceRecovery(record.binding.root, { maxEntries: record.request.maxEntries, maxBytes: record.request.maxBytes }, signal)
    if (current.sourceIdentity !== originalIdentity || current.sha256 !== manifest.sha256)
      throw new Error('Capture archive differs from the freshly observed source')
    result = { path: await realpath(record.request.destination), inventoryHash: manifest.sha256, manifestHash }
  })
  signal.throwIfAborted()
  return result!
}
