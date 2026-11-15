/** Read-only handoff verification. Caller holds the endpoint writer lock; no service is initialized. */
import { z } from 'zod'
import { fingerprint } from '../remote/journal.ts'
import type { readEndpointStorageSnapshot } from './storage.ts'
import { reinspectWorkspaceCapture } from './workspace-reconcile.ts'

export const CaptureHandoffSelection = z.array(z.object({ requestId: z.string().uuid(),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(256)
  .refine(items => new Set(items.map(item => item.requestId)).size === items.length, 'Capture selections must be unique')

export async function verifyCaptureHandoff(snapshot: Awaited<ReturnType<typeof readEndpointStorageSnapshot>>['snapshot'],
  input: unknown, signal: AbortSignal) {
  const selections = CaptureHandoffSelection.parse(input), verified = []
  for (const selection of selections) {
    signal.throwIfAborted()
    const records = (snapshot.captures ?? []).filter(item => item.request.requestId === selection.requestId)
    const record = records[0]
    if (records.length !== 1 || !record || record.phase !== 'complete' || !record.result
      || record.result.manifestHash !== selection.manifestHash || record.requestHash !== fingerprint(record.request)
      || record.binding.endpointId !== snapshot.endpointId) throw new Error('Handoff requires the original completed capture and reviewed digest')
    const grant = snapshot.grants.find(item => item.id === record.binding.grantId)
    const allocation = snapshot.reservations.find(item => item.workspace === record.binding.workspace)
    if (!grant || grant.epoch !== record.binding.epoch || grant.revision !== record.binding.revision
      || grant.root !== record.binding.root || grant.rootIdentity !== record.binding.rootIdentity || grant.workspace !== record.binding.workspace
      || !allocation || allocation.phase !== 'provisioned' || !record.binding.storage
      || allocation.requestId !== record.binding.storage.requestId || allocation.projectId !== record.binding.storage.projectId
      || fingerprint(snapshot.policy) !== record.binding.storage.policyHash)
      throw new Error('Capture handoff grant or storage binding changed')
    const current = await reinspectWorkspaceCapture(record, selection.manifestHash, signal)
    if (current.inventoryHash !== record.result.inventoryHash || current.path !== record.result.path)
      throw new Error('Capture handoff archive differs from retained result')
    verified.push({ requestId: selection.requestId, manifestHash: current.manifestHash, inventoryHash: current.inventoryHash })
  }
  signal.throwIfAborted()
  return { captures: verified, sourceContentsRechecked: true as const, executionQuiescenceVerified: false as const,
    globalSnapshotVerified: false as const, restoreVerified: false as const }
}
