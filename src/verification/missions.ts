/** Mission acceptance distinguishes explicit human review from checked artifact outcomes. */
import type { Store } from '../app/store.ts'
import type { Library } from '../workspace/library.ts'
import { latestAssignment } from '../core/model.ts'
import { WorkspaceError, type MissionAction, type ReviewRequirements, type WorkspaceReview } from '../workspace/model.ts'
import type { CheckSelection, EvidenceSeal } from './review-model.ts'
import type { Verification } from './service.ts'
import type { VerificationReviews } from './reviews.ts'

/** Bind all current artifact outputs of the completed assignment to operator-selected host checks. */
export class MissionReviews implements WorkspaceReview {
  constructor(private readonly store: Store, private readonly library: Library, private readonly checks: Verification, private readonly reviews: VerificationReviews) {}
  requirements(ticketId: string): ReviewRequirements {
    const ticket = this.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    if (!assignment) return { artifacts: [], problem: 'The original assignment is unavailable' }
    const rows = this.store.db.prepare(`SELECT id FROM workspace_library WHERE kind='artifact' AND archived=0
      AND json_extract(value,'$.provenance.ticketId')=? AND json_extract(value,'$.provenance.assignmentId')=? ORDER BY rowid LIMIT 513`).all(ticketId, assignment.id)
    if (rows.length > 512) return { artifacts: [], problem: 'Too many assignment artifacts to inspect completely; consolidate or archive obsolete outputs' }
    const artifacts = rows.map(row => this.library.read(String(row.id))).filter(record => !record.superseded)
      .map(({ id, title, revision, hash }) => ({ id, title, revision, hash }))
    return { artifacts: artifacts.slice(0, 32), ...(artifacts.length > 32 ? { problem: 'One result review supports at most 32 current artifacts; consolidate the output' } : {}) }
  }
  validate(ticketId: string | undefined, kind: 'operator' | 'checks' | undefined, selections: readonly CheckSelection[]): void {
    const required = ticketId ? this.requirements(ticketId) : { artifacts: [] }
    if (required.problem) throw new WorkspaceError(409, required.problem)
    if (required.artifacts.length) {
      if (kind !== 'checks' || !selections.length) throw new WorkspaceError(409, 'Select successful host checks for every current artifact before accepting this result')
      const actual = new Set<string>()
      for (const selection of selections) {
        const binding = this.checks.approval(selection.runId, selection), artifact = required.artifacts.find(item => item.id === binding.artifact.id)
        if (!artifact || artifact.revision !== binding.artifact.revision || artifact.hash !== binding.artifact.hash) throw new WorkspaceError(409, 'Selected check does not cover the current assignment artifacts')
        actual.add(artifact.id)
      }
      if (actual.size !== required.artifacts.length) throw new WorkspaceError(409, 'Every current artifact needs at least one successful host check')
    } else if (kind !== 'operator' || selections.length) throw new WorkspaceError(409, 'This result has no current file artifacts; explicitly acknowledge human review without claiming host verification')
  }
  prepare(id: string, target: string, checks: readonly CheckSelection[]) { return this.reviews.prepare({ id, purpose: 'acceptance', target, checks }) }
  assert(evidence: readonly EvidenceSeal[], checks: readonly CheckSelection[]) { this.reviews.assert(evidence, checks) }
  current(ticketId: string, accepted: NonNullable<MissionAction['accepted']>): boolean {
    try {
      const required = this.requirements(ticketId)
      if (required.problem) return false
      if (!required.artifacts.length) return accepted.basis !== 'checks' && !accepted.evidence?.length
      if (accepted.basis !== 'checks' || !accepted.evidence?.length || !this.reviews.current(accepted.evidence)) return false
      const ids = new Set(accepted.evidence.map(seal => seal.artifact.id))
      return ids.size === required.artifacts.length && required.artifacts.every(artifact => accepted.evidence!.some(seal =>
        seal.artifact.id === artifact.id && seal.artifact.revision === artifact.revision && seal.artifact.hash === artifact.hash))
    } catch { return false }
  }
}
