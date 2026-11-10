/** Original publication authority in a held Store. No dispatch, refresh, approval or renewal runs here. */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { OutboundMessage, Ticket, Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { OwnershipStamp } from '../ownership/protocol.ts'
import { fingerprint } from '../remote/journal.ts'
import { ApprovePublication } from '../publication/runtime.ts'
import { ConfigureDelivery } from '../publication/channels.ts'
import { DestinationView, Digest, Publication, PublicationId, PublicationReceipt } from '../publication/protocol.ts'
import { contentHash, publicationMarker } from '../publication/github.ts'
import { pullReviewBody } from '../publication/github-pull.ts'
import { PullObservation, matchesPullEvidence } from '../publication/pull-model.ts'
import { CheckSelections, EvidenceSeal, type EvidenceReview } from '../verification/review-model.ts'
import { completedCheck, checkEvidence, recordedCheckBinding, matchesRecordedSeal } from '../verification/evidence.ts'
import type { StoredCheckRun } from '../verification/contracts.ts'
import type { LibraryRecord } from '../workspace/library-model.ts'
import type { Mission } from '../workspace/model.ts'
import type { PlanVersion } from '../workspace/plan-model.ts'
import { StateReader, stateAt as at, stateId as id, statePositive as positive, stateObject as object } from './reader.ts'
import { verifyRepositoryExports } from './repository-exports.ts'

const grantSchema = z.object({ id: PublicationId, missionId: PublicationId, revision: positive, planVersion: positive,
  enabled: z.boolean(), createdAt: at, revokedAt: at.optional(), destination: DestinationView.optional() }).strict()
const approvalSchema = z.object({ id: PublicationId, serviceId: PublicationId, artifactId: PublicationId, revision: positive,
  hash: Digest, destination: id, destinationHash: Digest, createdAt: at, updatedAt: at,
  phase: z.enum(['pending', 'held', 'unknown', 'observed']), receipt: PublicationReceipt.optional(), problem: z.string().max(4000).optional(),
  verification: z.object({ checks: CheckSelections, reviewId: PublicationId, evidence: z.array(EvidenceSeal).min(1).max(32).optional() }).strict().optional(),
  pull: PullObservation.optional(), intent: Publication, fingerprint: Digest, attempts: z.array(OwnershipStamp).min(1).max(100),
  approval: ApprovePublication.optional(), destinationSnapshot: DestinationView.optional() }).strict()
const channel = z.object({ source: id, thread: id, address: z.record(z.string(), z.string()) }).strict()
const messageSchema = z.object({ id, channel, text: z.string().max(60000), kind: z.enum(['acknowledgement', 'reply', 'notice']), ticketId: id.optional() }).strict()
const outboxSchema = messageSchema.extend({ status: z.enum(['pending', 'sent', 'dropped']).optional(),
  dropped: z.object({ at, reason: z.enum(['channelGone', 'channelIgnored']) }).strict().optional() }).strict()
const deliverySchema = z.object({ id: PublicationId, messageId: id, ticketId: id, missionId: PublicationId, grantId: PublicationId,
  destination: id, createdAt: at, updatedAt: at.optional(), phase: z.enum(['pending', 'unknown', 'observed']), withdrawn: z.boolean().optional(),
  receipt: PublicationReceipt.optional(), problem: z.string().max(4000).optional(), publication: Publication, original: outboxSchema,
  attempts: z.array(OwnershipStamp).min(1).max(100) }).strict()
const reviewSchema = z.looseObject({ id: PublicationId, purpose: z.enum(['publication', 'acceptance', 'closure']), target: Digest, checks: CheckSelections,
  attempts: z.array(z.looseObject({ id: PublicationId, captures: z.array(z.looseObject({ id })).min(1).max(8),
    evidenceVersion: z.literal(1).optional(), evidence: z.array(EvidenceSeal).max(32).optional() })).max(20) })
const originalMessage = ({ id, channel, text, kind, ticketId }: OutboundMessage) => ({ id, channel, text, kind, ...(ticketId ? { ticketId } : {}) })
const terminal = (receipt: PublicationReceipt) => !['accepted', 'started', 'unknown'].includes(receipt.phase)
const orderedChecks = (checks: z.infer<typeof CheckSelections>) => [...checks].sort((a, b) => a.runId.localeCompare(b.runId))

export interface PublicationStateVerification {
  version: 1; records: number; artifacts: number; checkedArtifacts: number; seals: number; pullReviews: number; deliveryGrants: number;
  revokedGrants: number; deliveries: number; withdrawn: number; receipts: number; sent: number; unresolved: number; missingOutbox: number;
  legacyApprovals: number; legacyDestinations: number; legacyGrantRequests: number; legacyPlanBindings: number; legacyReviewSeals: number; digest: string
}

/** Check before applying receipts, then require settled local/independent outcomes in the final signed image. */
export async function verifyPublicationState(db: DatabaseSync, signal: AbortSignal, settled = false): Promise<PublicationStateVerification> {
  const r = new StateReader(db, signal, 'publications')
  await verifyRepositoryExports(r)
  let artifacts = 0, checkedArtifacts = 0, seals = 0, pullReviews = 0, revokedGrants = 0, deliveries = 0, withdrawn = 0,
    receipts = 0, sent = 0, unresolved = 0, missingOutbox = 0, legacyApprovals = 0, legacyDestinations = 0, legacyGrantRequests = 0,
    legacyPlanBindings = 0, legacyReviewSeals = 0
  const setting = (key: string) => {
    const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key)
    return row ? r.json(row.value, object, 'publication_binding') : undefined
  }
  const ownership = setting(KV.runtime.ownership), publisher = setting(KV.runtime.publication)
  const checkBinding = (run: StoredCheckRun) => {
    try {
      if (run.purpose !== 'check' || run.status !== 'passed' || !run.quiescent || !completedCheck(run, checkEvidence(run), true)) throw new Error('Invalid recorded check')
      return recordedCheckBinding(run)
    } catch { return r.fail('authority', 'publication_check') }
  }
  const attempts = (values: OwnershipStamp[]) => {
    if (!ownership || !publisher) r.fail('reference', 'publication_configuration')
    const seen = new Set<string>()
    for (const value of values) {
      if (value.coordinatorId !== ownership!.coordinatorId || seen.has(fingerprint(value))) r.fail('authority', 'publication_owner')
      seen.add(fingerprint(value))
    }
  }
  const destination = (value: z.infer<typeof DestinationView>, publication?: Publication) => {
    const { hash, ...metadata } = value; r.same(hash, fingerprint(metadata), 'publication_destination_hash')
    if (publication) {
      r.same([value.id, hash], [publication.destination, publication.destinationHash], 'publication_destination')
      if (Buffer.byteLength(publication.text) > value.maxBytes) r.fail('limit', 'publication_destination_bytes')
      if ((value.kind === 'github-pr-review') !== !!publication.pull) r.fail('authority', 'publication_pull_destination')
    }
  }
  const observed = (publication: Publication, values: OwnershipStamp[], receipt: PublicationReceipt | undefined, phase: string,
    target?: z.infer<typeof DestinationView>) => {
    attempts(values)
    r.same(contentHash(publication.text), publication.hash, 'publication_content_hash')
    if (settled && (phase !== 'observed' || !receipt || !terminal(receipt))) r.fail('unsettled', 'publication_receipt')
    if (!receipt) { if (phase === 'observed') r.fail('reference', 'publication_receipt'); unresolved++; return }
    receipts++; if (!terminal(receipt)) unresolved++
    r.same([receipt.id, receipt.destination, receipt.destinationHash, receipt.hash, receipt.bytes, receipt.artifact, receipt.message, receipt.pull],
      [publication.id, publication.destination, publication.destinationHash, publication.hash, Buffer.byteLength(publication.text), publication.artifact, publication.message, publication.pull], 'publication_receipt_binding')
    if (!values.some(value => fingerprint(value) === fingerprint(receipt.ownership))) r.fail('authority', 'publication_receipt_owner')
    if (receipt.phase === 'sent') { if (!receipt.external) r.fail('reference', 'publication_external_receipt'); sent++ }
    else if (receipt.external) r.fail('conflict', 'publication_external_receipt')
    if (receipt.phase === 'not_delivered' && !receipt.reconciliation) r.fail('reference', 'publication_reconciliation')
    if (receipt.external && target) {
      const external = receipt.external
      const body = target.kind === 'feishu-reply' ? `${publication.text}\n\n[${publicationMarker(publication)}]`
        : target.kind === 'github-pr-review' ? pullReviewBody(publication) : `${publication.text}\n\n<!-- ${publicationMarker(publication)} -->`
      const url = target.kind === 'feishu-reply' ? `https://applink.${target.brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${target.chatId}`
        : target.kind === 'github-comment' ? `https://github.com/${target.repository}/issues/${target.issue}#issuecomment-${external.id}`
        : `https://github.com/${target.repository}/pull/${target.issue}#${target.kind === 'github-pr-review' ? 'pullrequestreview-' : 'discussion_r'}${external.id}`
      r.same([external.bodyHash, external.url], [contentHash(body), url], 'publication_external_binding')
      if (target.kind === 'github-pr-review') {
        const state = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[target.event]
        if (external.review?.commit !== publication.pull?.head.sha || ![state, 'DISMISSED'].includes(external.review?.state ?? '')) r.fail('authority', 'publication_external_review')
      } else if (external.review) r.fail('conflict', 'publication_external_review')
    }
  }
  const grants = new Map<string, z.infer<typeof grantSchema>>(), latest = new Map<string, z.infer<typeof grantSchema>>()
  for (const row of r.rows('delivery_grant')) {
    await r.step(); const value = r.json(row.value, grantSchema, 'delivery_grant'), mission = r.core<Mission>('workspace_mission', value.missionId)
    r.same([row.id, row.mission], [value.id, value.missionId], 'delivery_grant_identity'); r.parse(Digest, row.fingerprint, 'delivery_grant_fingerprint')
    const prior = latest.get(value.missionId)
    r.same(value.revision, (prior?.revision ?? 0) + 1, 'delivery_grant_revision')
    if (prior) r.same(prior.revokedAt, value.createdAt, 'delivery_grant_revocation')
    if (value.revokedAt) revokedGrants++
    if (value.planVersion > mission.planVersion) r.fail('reference', 'delivery_grant_plan')
    const plan = db.prepare('SELECT value FROM workspace_plan_version WHERE mission=? AND version=?').get(value.missionId, value.planVersion)
    if (!plan) r.fail('reference', 'delivery_grant_plan')
    const original = r.json(plan!.value, object, 'delivery_grant_plan') as unknown as PlanVersion
    r.same(original.version, value.planVersion, 'delivery_grant_plan')
    if (value.enabled !== !!value.destination || value.destination?.kind === 'github-pr-review') r.fail('authority', 'delivery_grant_destination')
    if (value.destination) destination(value.destination)
    if (row.request === undefined || row.request === null) legacyGrantRequests++
    else {
      const request = r.json(row.request, ConfigureDelivery.safeExtend({ missionId: PublicationId }), 'delivery_grant_request')
      r.same(row.fingerprint, fingerprint(request), 'delivery_grant_request_hash')
      r.same([request.missionId, request.requestId, request.revision + 1, request.enabled], [value.missionId, value.id, value.revision, value.enabled], 'delivery_grant_request')
      if (request.enabled) {
        r.same([request.destination, request.destinationHash], [value.destination?.id, value.destination?.hash], 'delivery_grant_request_destination')
        if (request.missionRevision > mission.revision) r.fail('history', 'delivery_grant_mission_revision')
      }
    }
    latest.set(value.missionId, value); grants.set(value.id, value)
  }
  for (const value of latest.values()) { await r.step(); if (value.revokedAt) r.fail('history', 'delivery_grant_latest') }
  if (grants.size && (!ownership || !publisher)) r.fail('reference', 'publication_configuration')
  for (const row of r.rows('workspace_publication')) {
    await r.step(); const value = r.json(row.value, approvalSchema, 'artifact_publication'), publication = value.intent
    r.same([row.id, value.id, value.serviceId, value.destination, value.destinationHash, value.hash],
      [value.id, publication.id, publisher?.serviceId, publication.destination, publication.destinationHash, publication.hash], 'artifact_publication_identity')
    r.same([publication.artifact?.id, publication.artifact?.revision, publication.artifact?.hash, publication.message], [value.artifactId, value.revision, value.hash, undefined], 'artifact_publication_subject')
    const record = r.core<LibraryRecord>('workspace_library', value.artifactId)
    if (record.kind !== 'artifact' || !record.text || record.hash !== value.hash) r.fail('reference', 'publication_artifact')
    const originalRevision = db.prepare('SELECT revision FROM workspace_library WHERE id=?').get(record.id)!.revision
    if (Number(originalRevision) < value.revision) r.fail('history', 'publication_artifact_revision')
    const blob = db.prepare('SELECT data FROM workspace_blob WHERE hash=?').get(record.hash)
    if (!blob || !(blob.data instanceof Uint8Array)) r.fail('reference', 'publication_artifact_content')
    const data = Buffer.from(blob!.data as Uint8Array); r.charge(data.toString('base64'), 'publication_artifact_content')
    r.same(data.toString('utf8'), publication.text, 'publication_artifact_content')
    const expected = { requestId: value.id, revision: value.revision, hash: value.hash, destination: value.destination, destinationHash: value.destinationHash,
      ...(value.verification ? { checks: value.verification.checks } : {}), ...(value.pull ? { pullHash: value.pull.hash } : {}) }
    if (value.approval) {
      const { checks, ...base } = value.approval, { checks: selected, ...original } = { ...expected, checks: value.verification?.checks }
      r.same(base, original, 'publication_approval'); r.same(checks ?? [], selected ?? [], 'publication_approval_checks')
      r.same(value.fingerprint, fingerprint({ artifactId: value.artifactId, ...value.approval }), 'publication_approval_hash')
    } else {
      legacyApprovals++
      if (![expected, ...value.verification ? [] : [{ ...expected, checks: [] }]].some(request => fingerprint({ artifactId: value.artifactId, ...request }) === value.fingerprint))
        r.fail('history', 'publication_legacy_approval')
    }
    if (value.destinationSnapshot) destination(value.destinationSnapshot, publication); else legacyDestinations++
    if (value.pull) {
      r.same([value.pull.destination, value.pull.destinationHash, value.pull.hash, value.pull.binding],
        [value.destination, value.destinationHash, fingerprint(value.pull.binding), publication.pull], 'publication_pull'); pullReviews++
    } else if (publication.pull) r.fail('reference', 'publication_pull')
    if (value.verification) {
      const selection = value.verification
      if (!selection.checks.length || selection.reviewId !== value.id) r.fail('reference', 'publication_checks')
      for (const check of selection.checks) {
        await r.step(); const run = r.core<StoredCheckRun>('verification_run', check.runId)
        const binding = checkBinding(run)
        r.same([binding.selection, binding.artifact], [check, { id: value.artifactId, revision: value.revision, hash: value.hash }], 'publication_check_binding')
        if (value.pull && !matchesPullEvidence(binding, value.pull.binding)) r.fail('authority', 'publication_pull_check')
      }
      if (selection.evidence) {
        const review = r.parse(reviewSchema, r.core<EvidenceReview>('verification_review', selection.reviewId), 'publication_review')
        for (const _attempt of review.attempts) await r.step()
        r.same([review.id, review.purpose, review.target, review.checks], [value.id, 'publication', value.fingerprint, orderedChecks(selection.checks)], 'publication_review')
        r.same(selection.evidence.map(seal => seal.selection), orderedChecks(selection.checks), 'publication_selections')
        r.same(publication.artifact, { id: value.artifactId, revision: value.revision, hash: value.hash, basis: 'checks', evidence: selection.evidence }, 'publication_sealed_subject')
        if (!review.attempts.some(attempt => fingerprint(attempt.evidence ?? null) === fingerprint(selection.evidence))) {
          if (!review.attempts.some(attempt => attempt.evidenceVersion === undefined && !attempt.evidence
            && selection.evidence!.every(seal => attempt.captures.some(capture => capture.id === seal.capture.id)))) r.fail('reference', 'publication_review_attempt')
          legacyReviewSeals++
        }
        for (const seal of selection.evidence) {
          await r.step(); if (!matchesRecordedSeal(seal, r.core<StoredCheckRun>('verification_run', seal.selection.runId), r.core<StoredCheckRun>('verification_run', seal.capture.id)))
            r.fail('authority', 'publication_seal'); seals++
        }
      } else if (publication.artifact?.basis === 'checks' || publication.artifact?.evidence || value.receipt) r.fail('reference', 'publication_evidence')
      checkedArtifacts++
    } else if (record.provenance.actor === 'worker' || publication.artifact?.basis === 'checks' || publication.artifact?.evidence || value.pull)
      r.fail('authority', 'publication_unchecked_artifact')
    observed(publication, value.attempts, value.receipt, value.phase, value.destinationSnapshot); artifacts++
  }
  for (const row of r.rows('channel_publication')) {
    await r.step(); const value = r.json(row.value, deliverySchema, 'channel_publication'), publication = value.publication
    const grant = r.needed(grants, value.grantId, 'channel_grant'), ticket = r.core<Ticket>('ticket', value.ticketId), trigger = r.core<Trigger>('trigger', ticket.origin.triggerId)
    r.same([row.id, row.message, row.mission, value.id, value.destination, value.missionId],
      [value.id, value.messageId, value.missionId, publication.id, grant.destination?.id, grant.missionId], 'channel_publication_identity')
    if (!grant.enabled || !grant.destination) r.fail('authority', 'channel_grant')
    r.same(publication.message, { id: value.messageId, ticketId: value.ticketId, missionId: value.missionId, grantId: grant.id, planVersion: grant.planVersion }, 'channel_publication_subject')
    if (publication.artifact || publication.pull) r.fail('authority', 'channel_publication_subject')
    r.same([value.original.id, value.original.ticketId, value.original.text], [value.messageId, value.ticketId, publication.text], 'channel_original_message')
    r.same(value.original.channel, { source: 'publication', thread: `publication:${grant.missionId}:${grant.id}`, address: { grantId: grant.id, destination: grant.destination!.name } }, 'channel_original_destination')
    r.same([trigger.source, trigger.meta.mission, trigger.channel], ['workspace', grant.missionId, value.original.channel], 'channel_original_trigger')
    if (trigger.meta.planVersion !== undefined) r.same(trigger.meta.planVersion, grant.planVersion, 'channel_original_plan'); else legacyPlanBindings++
    destination(grant.destination!, publication); observed(publication, value.attempts, value.receipt, value.phase, grant.destination)
    const outbox = db.prepare('SELECT value FROM outbox WHERE id=?').get(value.messageId)
    if (!outbox) { if (!value.withdrawn || settled) r.fail('reference', 'channel_outbox'); missingOutbox++ }
    else {
      const message = r.json(outbox.value, outboxSchema, 'channel_outbox')
      r.same(originalMessage(message), originalMessage(value.original), 'channel_outbox_message')
      if (value.receipt && terminal(value.receipt)) {
        const status = value.receipt.phase === 'sent' ? 'sent' : 'dropped'
        if (message.status !== status && (settled || message.status !== 'pending')) r.fail('conflict', 'channel_outbox_status')
        if (message.status === 'dropped' && message.dropped?.reason !== 'channelGone') r.fail('conflict', 'channel_outbox_drop')
      }
    }
    if (value.withdrawn) withdrawn++; deliveries++
  }
  return { version: 1, records: r.records, artifacts, checkedArtifacts, seals, pullReviews, deliveryGrants: grants.size, revokedGrants, deliveries,
    withdrawn, receipts, sent, unresolved, missingOutbox, legacyApprovals, legacyDestinations, legacyGrantRequests, legacyPlanBindings, legacyReviewSeals, digest: r.digest() }
}
