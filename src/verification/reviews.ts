/** Durable approval preparation; every scan uses the original check world and never reruns its command. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Store } from '../app/store.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { WorkspaceError } from '../workspace/model.ts'
import type { Verification } from './service.ts'
import { CheckCommandId } from './contracts.ts'
import { EvidenceSeal, ReviewRequest, FRESHNESS_WINDOW_MS, type EvidenceReview, type CheckSelection } from './review-model.ts'

interface Host { store: Store; verification: Verification; lifetime: AbortSignal; authorize(): void; now?(): number }
/** Persist selected evidence and every capture attempt before scanning, and retain ambiguous attempts through restart. */
export class VerificationReviews {
  private readonly pending = new Map<string, Promise<EvidenceSeal[]>>()
  private readonly stopped = new AbortController()
  constructor(private readonly host: Host) {
    host.store.db.exec('CREATE TABLE IF NOT EXISTS verification_review (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL)')
  }
  private now() { return this.host.now?.() ?? Date.now() }
  private authorize() { this.host.authorize(); this.host.lifetime.throwIfAborted(); this.stopped.signal.throwIfAborted() }
  get(id: string): EvidenceReview {
    CheckCommandId.parse(id)
    const row = this.host.store.db.prepare('SELECT value FROM verification_review WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Evidence review not found')
    return JSON.parse(String(row.value))
  }
  private save(value: EvidenceReview, hash: string): void {
    value.updatedAt = timestamp()
    this.host.store.atomic(() => {
      this.host.store.db.prepare('INSERT INTO verification_review VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, hash, JSON.stringify(value))
      const size = this.host.store.db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM verification_review').get()!
      if (Number(size.n) > 10000 || Number(size.bytes) > 256 * 1024 * 1024) throw new WorkspaceError(409, 'Evidence review journal capacity reached')
    })
  }
  /** A historical seal can remain accepted; only new acceptance/dispatch requires its short freshness window. */
  current(seals: readonly EvidenceSeal[], fresh = false): boolean {
    try {
      for (const input of seals) {
        const seal = EvidenceSeal.parse(input), binding = this.host.verification.approval(seal.selection.runId, seal.selection, fresh)
        const { capture: _, validUntil: __, ...expected } = seal
        if (fingerprint(binding) !== fingerprint(expected) || !this.host.verification.sourceCurrent(seal)) return false
        if (fresh && !freshSeal(seal, this.now())) return false
      }
      return true
    } catch { return false }
  }
  assert(seals: readonly EvidenceSeal[], selections: readonly CheckSelection[], fresh = true): void {
    if (fingerprint(seals.map(seal => seal.selection).sort((a, b) => a.runId.localeCompare(b.runId)))
      !== fingerprint([...selections].sort((a, b) => a.runId.localeCompare(b.runId))) || !this.current(seals, fresh))
      throw new WorkspaceError(409, 'Reviewed check evidence or source freshness changed; prepare approval again')
  }
  prepare(input: unknown): Promise<EvidenceSeal[]> {
    const request = ReviewRequest.parse(input); request.checks.sort((a, b) => a.runId.localeCompare(b.runId))
    const hash = fingerprint(request), prior = this.host.store.db.prepare('SELECT fingerprint FROM verification_review WHERE id=?').get(request.id)
    if (prior && prior.fingerprint !== hash) return Promise.reject(new WorkspaceError(409, 'Evidence review ID belongs to another approval'))
    const active = this.pending.get(request.id); if (active) return active
    const operation = this.execute(request, hash).finally(() => this.pending.delete(request.id))
    this.pending.set(request.id, operation); return operation
  }
  private async execute(request: ReviewRequest, hash: string): Promise<EvidenceSeal[]> {
    this.authorize()
    const bindings = request.checks.map(selection => this.host.verification.approval(selection.runId, selection))
    const groups = new Map<string, { checkId: string; selections: CheckSelection[] }>()
    for (const binding of bindings) {
      const run = this.host.verification.get(binding.selection.runId), source = fingerprint({ backend: run.backend, snapshot: binding.snapshotHash })
      const group = groups.get(source) ?? { checkId: run.id, selections: [] }; group.selections.push(binding.selection); groups.set(source, group)
    }
    if (groups.size > 8) throw new WorkspaceError(409, 'One approval supports at most eight distinct source snapshots; consolidate the result')
    let review: EvidenceReview
    try { review = this.get(request.id) } catch (error) {
      if (!(error instanceof WorkspaceError) || error.status !== 404) throw error
      review = { ...request, createdAt: timestamp(), updatedAt: timestamp(), status: 'capturing', attempts: [] }; this.save(review, hash)
    }
    let attempt = review.attempts.at(-1)
    // A timed-out observer is not evidence of process termination. Resume only the original capture IDs.
    const unsettled = attempt?.captures.some(capture => {
      try { return this.host.verification.get(capture.id).quiescent !== true } catch { return true }
    })
    if (!attempt || !unsettled) {
      if (review.attempts.length >= 20) throw new WorkspaceError(409, 'Evidence review attempt limit reached; inspect its original receipts')
      attempt = { id: randomUUID(), at: timestamp(), evidenceVersion: 1, captures: [...groups].map(([source, group]) => ({ source, checkId: group.checkId, id: randomUUID() })) }
      review.attempts.push(attempt)
    }
    if (attempt.captures.length !== groups.size || attempt.captures.some(capture => groups.get(capture.source)?.checkId !== capture.checkId))
      throw new WorkspaceError(409, 'Original evidence review source bindings changed')
    review.status = 'capturing'; delete review.evidence; delete review.problem; this.save(review, hash)
    try {
      const evidence: EvidenceSeal[] = []
      for (const capture of attempt.captures) {
        this.authorize()
        const original = this.host.verification.get(capture.checkId)
        const signal = AbortSignal.any([this.stopped.signal, this.host.lifetime, AbortSignal.timeout((original.check.definition.snapshot.timeoutSeconds + 20) * 1000)])
        let run = await this.host.verification.freshness(capture.checkId, capture.id)
        while (!run.quiescent) {
          signal.throwIfAborted(); this.authorize()
          if (run.status === 'unknown') throw new WorkspaceError(409, `Observe or reconcile original freshness capture ${run.id}; no replacement is dispatched`)
          await delay(100, undefined, { signal }); run = await this.host.verification.refresh(run.id)
        }
        if (run.status !== 'captured') throw new WorkspaceError(409, run.problem ?? 'The reviewed source no longer matches its successful check')
        for (const selection of groups.get(capture.source)!.selections) evidence.push(this.host.verification.seal(selection, capture.id, this.now()))
      }
      evidence.sort((a, b) => a.selection.runId.localeCompare(b.selection.runId)); this.authorize(); this.assert(evidence, request.checks)
      attempt.evidenceVersion = 1; attempt.evidence = structuredClone(evidence)
      review.status = 'ready'; review.evidence = evidence; this.save(review, hash); return evidence
    } catch (error) {
      review.status = 'held'; review.problem = String(error).slice(0, 4000); this.save(review, hash); throw error
    }
  }
  async stop(): Promise<void> { this.stopped.abort(); await Promise.allSettled([...this.pending.values()]) }
}

/** The independent publisher also enforces this window immediately before any new provider send. */
export function freshSeal(seal: EvidenceSeal, now = Date.now()): boolean {
  const captured = Date.parse(seal.capture.capturedAt), finished = Date.parse(seal.capture.finishedAt), until = Date.parse(seal.validUntil)
  return captured <= now + 5000 && finished >= captured && finished <= now + 5000 && now < until
    && until <= captured + FRESHNESS_WINDOW_MS && until > captured
}
