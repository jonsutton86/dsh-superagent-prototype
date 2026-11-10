/** Read-only validation of staged Git history; never fetches, dispatches, renews reviews or rebuilds a bundle. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { LibraryRecord } from '../workspace/library-model.ts'
import type { StoredCheckRun } from '../verification/contracts.ts'
import type { EvidenceReview } from '../verification/review-model.ts'
import { completedCheck, checkEvidence, recordedCheckBinding, matchesRecordedSeal } from '../verification/evidence.ts'
import { RepositoryExportRecord, REPOSITORY_EXPORT_LIMITS as L } from '../publication/repository-export-model.ts'
import type { RepositorySource } from '../environments/repository-model.ts'
import { fingerprint } from '../remote/journal.ts'
import type { StateReader } from './reader.ts'

export async function verifyRepositoryExports(r: StateReader): Promise<void> {
  const { db } = r
  if (!r.tables.has('repository_export') && !r.tables.has('repository_export_chunk')) return
  if (!r.tables.has('repository_export') || !r.tables.has('repository_export_chunk')) r.fail('reference', 'repository_export_tables')
  const orphan = db.prepare('SELECT 1 FROM repository_export_chunk c LEFT JOIN repository_export e ON e.id=c.id WHERE e.id IS NULL LIMIT 1').get()
  if (orphan) r.fail('reference', 'repository_export_orphan')
  let count = 0, active = 0, reserved = 0, total = 0
  for (const row of r.rows('repository_export')) {
    await r.step(); const value = r.json(row.value, RepositoryExportRecord, 'repository_export')
    r.same([row.id, value.id, value.commandId], [value.id, value.request.requestId, 'repository-export-' + value.id], 'repository_export_identity')
    r.same(value.fingerprint, fingerprint({ artifactId: value.artifactId, request: value.request }), 'repository_export_request')
    r.same(value.request.checks, [...value.request.checks].sort((a, b) => a.runId.localeCompare(b.runId)), 'repository_export_check_order')
    const world = r.core<{ id: string; root: string; repository?: RepositorySource }>('managed_world', value.world)
    r.same([world.id, world.repository, posix.dirname(value.directory)], [value.world, value.source, world.root], 'repository_export_source')
    if (value.source.commit.length !== 40 || value.source.commit === value.head) r.fail('authority', 'repository_export_base')
    const artifact = r.core<LibraryRecord>('workspace_library', value.artifactId)
    const revision = db.prepare('SELECT revision FROM workspace_library WHERE id=?').get(value.artifactId)!.revision
    if (artifact.kind !== 'artifact' || Number(revision) < value.request.revision) r.fail('history', 'repository_export_artifact')
    r.same([artifact.hash, artifact.execution?.directory, artifact.execution?.assignmentId, artifact.execution?.environment?.world],
      [value.request.hash, value.directory, value.assignmentId, value.world], 'repository_export_artifact')
    for (const selection of value.request.checks) {
      await r.step(); const run = r.core<StoredCheckRun>('verification_run', selection.runId)
      try { if (run.purpose !== 'check' || run.status !== 'passed' || !run.quiescent || !completedCheck(run, checkEvidence(run), true)) throw new Error() }
      catch { r.fail('authority', 'repository_export_check') }
      const binding = recordedCheckBinding(run)
      r.same([binding.selection, binding.artifact, binding.repository, run.artifact.ticketId, run.execution.directory, run.execution.assignmentId, run.backend.binding],
        [selection, { id: value.artifactId, revision: value.request.revision, hash: value.request.hash },
          { commit: value.head, tree: value.tree, contentTree: value.tree, statusHash: createHash('sha256').digest('hex') },
          value.ticketId, value.directory, value.assignmentId, value.world], 'repository_export_check_binding')
    }
    if (++count > L.history) r.fail('limit', 'repository_export_history')
    if (value.phase !== 'cancelled' && (++active > L.count || (reserved += value.bundle?.bytes ?? L.bytes) > L.totalBytes)) r.fail('limit', 'repository_export_capacity')
    if (value.bundle) r.same([value.bundle.base, value.bundle.head, value.bundle.tree], [value.source.commit, value.head, value.tree], 'repository_export_bundle')
    if (value.phase === 'ready') {
      if (!value.bundle || !value.evidence || value.received !== value.bundle.bytes) r.fail('reference', 'repository_export_complete')
      const review = r.core<EvidenceReview>('verification_review', value.id)
      r.same([review.id, review.purpose, review.target, review.checks], [value.id, 'publication', value.fingerprint, value.request.checks], 'repository_export_review')
      r.same(value.evidence!.map(seal => seal.selection), value.request.checks, 'repository_export_selections')
      if (!review.attempts.some(attempt => fingerprint(attempt.evidence ?? null) === fingerprint(value.evidence))) r.fail('reference', 'repository_export_review_attempt')
      for (const seal of value.evidence!) {
        await r.step()
        if (!matchesRecordedSeal(seal, r.core<StoredCheckRun>('verification_run', seal.selection.runId), r.core<StoredCheckRun>('verification_run', seal.capture.id)))
          r.fail('authority', 'repository_export_seal')
      }
    } else if (value.evidence) r.fail('authority', 'repository_export_evidence')
    let offset = 0; const hash = createHash('sha256')
    // Charge only bounded metadata to StateReader; bytes have an independent 2 GiB bound and stream through the digest.
    for (const chunk of db.prepare(`SELECT offset,substr(data,1,${L.chunk + 1}) AS data,hash FROM repository_export_chunk WHERE id=? ORDER BY offset`).iterate(value.id)) {
      await r.step()
      if (!(chunk.data instanceof Uint8Array)) r.fail('shape', 'repository_export_chunk')
      const bytes = chunk.data as Uint8Array
      if (value.phase === 'cancelled' || !value.bundle || chunk.offset !== offset || !bytes.length || bytes.length > L.chunk
        || offset + bytes.length > value.received || (total += bytes.length) > L.totalBytes) r.fail('conflict', 'repository_export_chunk')
      const digest = createHash('sha256').update(bytes).digest('hex')
      r.same(digest, chunk.hash, 'repository_export_chunk_hash')
      r.charge([value.id, offset, bytes.length, digest], 'repository_export_chunk'); hash.update(bytes); offset += bytes.length
    }
    r.same(offset, value.phase === 'cancelled' ? 0 : value.received, 'repository_export_received')
    if (value.received && !value.bundle || value.bundle && value.received > value.bundle.bytes) r.fail('conflict', 'repository_export_length')
    if (value.phase !== 'cancelled' && value.bundle && offset === value.bundle.bytes) r.same(hash.digest('hex'), value.bundle.sha256, 'repository_export_digest')
  }
}
