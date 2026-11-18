/** Pure checks of recorded host evidence; current authority and source availability are checked separately. */
import { fingerprint } from '../remote/journal.ts'
import type { StoredCheckRun } from './contracts.ts'
import type { CheckEvidence } from './model.ts'
import { validateSnapshot } from './snapshot.ts'
import { EvidenceBinding, FRESHNESS_WINDOW_MS, type EvidenceSeal } from './review-model.ts'

export const checkEvidence = (run: StoredCheckRun) => run.receipt?.verification ?? run.evidence

/** A result remains historical evidence when a later observation reports an unavailable provider. */
export function completedCheck(run: StoredCheckRun, evidence: CheckEvidence | undefined, historical = false): boolean {
  if (!evidence?.snapshot || evidence.stage !== 'finished' || !evidence.snapshotUnchanged || !evidence.finishedAt || evidence.problem
    || !historical && run.problem || run.cancel) return false
  const manifest = validateSnapshot(evidence.snapshot)
  if (manifest.source !== run.backend.source || evidence.artifactHash !== run.artifact.hash
    || !manifest.entries.some(item => item.kind === 'file' && item.path === run.check.definition.artifactPath && item.hash === run.artifact.hash)) return false
  const expected = run.request.verification!
  if (expected.expectedSnapshot && manifest.hash !== expected.expectedSnapshot || expected.expectedRepository && (manifest.repository?.commit !== expected.expectedRepository.commit
    || expected.expectedRepository.tree && manifest.repository?.tree !== expected.expectedRepository.tree)) return false
  if (run.check.definition.confinement === 'linux-bubblewrap' ? evidence.confinement !== 'linux-bubblewrap'
    : !['linux-bubblewrap', 'host-process'].includes(evidence.confinement)) return false
  return run.purpose === 'freshness' ? evidence.kind === 'capture' && run.outcome === undefined
    : evidence.kind === 'check' && !!evidence.checkedAt && !!evidence.output && run.outcome?.exitCode === 0 && run.outcome.signal === null
}

/** Caller must establish a completed check before using this binding, and current authority before new acceptance. */
export function recordedCheckBinding(run: StoredCheckRun): EvidenceBinding {
  const evidence = checkEvidence(run)!, repository = evidence.snapshot!.repository
  const evidenceHash = fingerprint({ artifact: run.artifact, check: run.check, execution: run.execution, backend: run.backend,
    snapshot: evidence.snapshot, outcome: run.outcome, output: evidence.output, checkedAt: evidence.checkedAt, finishedAt: evidence.finishedAt })
  return EvidenceBinding.parse({ selection: { runId: run.id, evidenceHash }, artifact: { id: run.artifact.id, revision: run.artifact.revision, hash: run.artifact.hash },
    check: { id: run.check.id, version: run.check.version, hash: run.check.hash }, snapshotHash: evidence.snapshot!.hash,
    execution: { binding: run.backend.binding, assignmentId: run.artifact.assignmentId, sessionId: run.artifact.sessionId },
    ...(repository ? { repository: { commit: repository.commit, tree: repository.tree,
      ...(repository.contentTree ? { contentTree: repository.contentTree, statusHash: repository.statusHash } : {}) } } : {}), confinement: evidence.confinement, checkedAt: evidence.checkedAt })
}

/** Verify an original seal against its check and capture without renewing historical freshness. */
export function matchesRecordedSeal(value: EvidenceSeal, original: StoredCheckRun, captured: StoredCheckRun): boolean {
  try {
    if (original.purpose !== 'check' || original.status !== 'passed' || !original.quiescent || !completedCheck(original, checkEvidence(original), true)) return false
    const { capture, validUntil, ...binding } = value, evidence = checkEvidence(captured)
    if (fingerprint(binding) !== fingerprint(recordedCheckBinding(original)) || capture.id !== captured.id
      || captured.purpose !== 'freshness' || captured.status !== 'captured' || !captured.quiescent || !completedCheck(captured, evidence, true)
      || captured.backend.binding !== original.backend.binding || captured.backend.source !== original.backend.source || captured.backend.grantId !== original.backend.grantId
      || captured.backend.epoch !== original.backend.epoch || captured.backend.revision < original.backend.revision
      || evidence?.snapshot?.hash !== value.snapshotHash || evidence?.confinement !== value.confinement
      || capture.capturedAt !== evidence?.snapshot?.capturedAt || capture.finishedAt !== evidence?.finishedAt) return false
    const from = Date.parse(capture.capturedAt), until = Date.parse(validUntil)
    return until > from && until <= from + FRESHNESS_WINDOW_MS && Date.parse(capture.finishedAt) >= from
  } catch { return false }
}
