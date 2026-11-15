import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkspaceCaptureRecordSchema } from '../src/remote/workspace-capture.ts'
import { fingerprint } from '../src/remote/journal.ts'
import { validateWorkspaceCaptureReferences } from '../src/recovery/workspace-members.ts'

function fixture() {
  const endpointId = randomUUID(), grantId = randomUUID(), requestId = randomUUID()
  const request = { requestId, grantId, epoch: 1, destination: '/private/archive', maxEntries: 100, maxBytes: 1024 }
  const record = WorkspaceCaptureRecordSchema.parse({ version: 1, request, requestHash: fingerprint(request), phase: 'complete',
    startedAt: '2026-11-15T00:00:00.000Z', completedAt: '2026-11-15T00:00:01.000Z',
    binding: { endpointId, grantId, epoch: 1, revision: 1, workspace: 'source', root: '/source', rootIdentity: '1:2:3' },
    result: { path: request.destination, manifestHash: 'a'.repeat(64), inventoryHash: 'b'.repeat(64), managedQuiescenceObserved: true, globalSnapshotVerified: false, restoreVerified: false } })
  const bindings = [{ source: '/source', manifestMember: 'workspace.bin', content: [], capture: { endpointId, requestId } }]
  const files = [{ member: 'workspace.bin', kind: 'workspace-manifest', bytes: 100, sha256: 'a'.repeat(64) }]
  return { record, bindings, files, inventories: [{ member: 'workspace.bin', hash: 'b'.repeat(64) }] }
}
it('links explicit original completed capture selection to authenticated manifest bytes without promoting other archives', () => {
  const f = fixture()
  expect(() => validateWorkspaceCaptureReferences(f.bindings, f.files, [f.record], f.inventories)).not.toThrow()
  expect(() => validateWorkspaceCaptureReferences(f.bindings.map(({ capture: _, ...binding }) => binding), f.files, [], f.inventories)).not.toThrow()
})
it('refuses absent, ambiguous, interrupted, wrong-source or substituted manifest capture evidence', () => {
  const f = fixture()
  for (const records of [[], [f.record, f.record], [{ ...f.record, phase: 'started' as const, result: undefined, completedAt: undefined }],
    [{ ...f.record, binding: { ...f.record.binding, root: '/replacement' } }],
    [{ ...f.record, result: { ...f.record.result!, manifestHash: 'c'.repeat(64) } }], [{ ...f.record, result: { ...f.record.result!, inventoryHash: 'c'.repeat(64) } }]]) {
    expect(() => validateWorkspaceCaptureReferences(f.bindings, f.files, records, f.inventories)).toThrow('original completed capture')
  }
  expect(() => validateWorkspaceCaptureReferences(f.bindings, [{ ...f.files[0]!, kind: 'session' }], [f.record], f.inventories)).toThrow()
  expect(() => validateWorkspaceCaptureReferences(f.bindings, [], [f.record], f.inventories)).toThrow()
})
