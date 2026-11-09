/** Recorded artifact and verification authority in an exclusively held prepared Store. No execution or fresh approval. */
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { key, type Ticket, type Trigger } from '../core/index.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { fingerprint } from '../remote/journal.ts'
import { Rpc, EffectOwner } from '../remote/protocol.ts'
import { OwnershipStamp } from '../ownership/protocol.ts'
import { LibraryScope, LibraryRelation, PublishRecord, LIBRARY_MAX_BYTES, type LibraryRecord } from '../workspace/library-model.ts'
import { MissionCommand, type Mission } from '../workspace/model.ts'
import { ReflectionCandidate, ProposeReflection } from '../workspace/reflection-model.ts'
import { CheckDefinition, CheckCommandId, CreateCheck, SaveCheck, ConfigureCheck, CancelCheck, ReconcileCheck, type CheckVersion, type StoredCheckRun } from '../verification/contracts.ts'
import { CheckEvidenceSchema } from '../verification/model.ts'
import { validateSnapshot } from '../verification/snapshot.ts'
import { checkEvidence, completedCheck, recordedCheckBinding } from '../verification/evidence.ts'
import { EvidenceSeal, ReviewRequest, FRESHNESS_WINDOW_MS, type EvidenceReview } from '../verification/review-model.ts'

const id = z.string().min(1).max(4096), uuid = z.string().uuid(), at = z.iso.datetime({ offset: true })
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), positive = count.min(1)
const digest = z.string().regex(/^[a-f0-9]{64}$/), shortHash = z.string().regex(/^[a-f0-9]{32}$/)
const text = z.string().max(128000), object = z.record(z.string(), z.unknown())
const location = z.object({ directory: id, mode: z.enum(['local', 'repository']).optional(), environment: z.object({
  environmentId: id, revision: positive, epoch: positive, world: id.optional() }).strict().optional() }).strict()
const execution = location.extend({ capturedAt: at, assignmentId: id, sessionId: id }).strict()
const librarySchema = z.object({ id: uuid, kind: z.enum(['memory', 'artifact']), scope: LibraryScope,
  title: PublishRecord.shape.title, summary: PublishRecord.shape.summary, mime: PublishRecord.shape.mime, filename: PublishRecord.shape.filename,
  hash: digest, bytes: positive.max(LIBRARY_MAX_BYTES), createdAt: at, expiresAt: at.optional(), text: z.boolean(),
  provenance: z.object({ actor: z.enum(['operator', 'worker']), trust: z.enum(['operator_submission', 'agent_submission']), ticketId: id.optional(),
    sessionId: id.optional(), assignmentId: id.optional(), triggerId: id.optional(), triggerHash: shortHash.optional() }).strict(),
  execution: execution.optional(), reflectionReview: z.object({ runId: id, proposalId: uuid, ticketId: id, assignmentId: id }).strict().optional(),
  sources: z.array(z.object({ id: uuid, relation: LibraryRelation, hash: digest }).strict()).max(20) }).strict()
const checkVersion = z.object({ id: uuid, version: positive, definition: CheckDefinition, hash: digest, createdAt: at }).strict()
const checkRecord = checkVersion.extend({ revision: positive, enabled: z.boolean(), workers: z.boolean(), updatedAt: at }).strict()
const outcome = z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict()
const job = z.object({ id, grantId: id, epoch: positive, revision: positive, fingerprint: digest, phase: z.enum(['accepted', 'started', 'settled', 'unknown']),
  createdAt: at, updatedAt: at, request: Rpc, cancelRequested: z.boolean(), quiescent: z.boolean().nullable(), verification: CheckEvidenceSchema.optional(),
  ownership: OwnershipStamp.optional(), outcome: outcome.optional(), error: z.string().max(4000).optional(),
  reconciled: z.object({ at, note: z.string().max(2000) }).strict().optional() }).strict()
const control = z.object({ requestId: CheckCommandId, reason: z.string().max(2000), at }).strict()
const runSchema = z.object({ id: CheckCommandId, artifact: z.object({ id: uuid, revision: positive, hash: digest, scope: LibraryScope,
  ticketId: id, assignmentId: id, sessionId: id }).strict(), check: checkVersion, execution, owner: EffectOwner,
  purpose: z.enum(['check', 'freshness']), sourceCheckId: CheckCommandId.optional(), actor: z.enum(['operator', 'worker']), createdAt: at, updatedAt: at,
  status: z.enum(['pending', 'running', 'passed', 'captured', 'failed', 'unknown']), quiescent: z.boolean().nullable(), cancel: control.optional(),
  reconciliation: control.optional(), problem: z.string().max(4000).optional(), outcome: outcome.optional(), evidence: CheckEvidenceSchema.optional(),
  backend: z.object({ kind: z.enum(['local', 'remote']), binding: id, source: id, endpointId: id.optional(), grantId: id, epoch: positive, revision: positive,
    confinement: z.string().max(100) }).strict(), fingerprint: digest, request: Rpc, requestHash: digest, receipt: job.optional() }).strict()
const reviewSchema = ReviewRequest.extend({ createdAt: at, updatedAt: at, status: z.enum(['capturing', 'ready', 'held']), problem: z.string().max(4000).optional(),
  evidence: z.array(EvidenceSeal).max(32).optional(), attempts: z.array(z.object({ id: uuid, at,
    captures: z.array(z.object({ id: CheckCommandId, source: digest, checkId: CheckCommandId }).strict()).max(8),
    evidenceVersion: z.literal(1).optional(), evidence: z.array(EvidenceSeal).max(32).optional() }).strict()).max(20) }).strict()
const reflectionProposal = z.object({ id: uuid, runId: id, revision: positive, status: z.enum(['pending', 'approved', 'rejected']), createdAt: at,
  ticketId: id, assignmentId: id, rationale: text, evidence: ProposeReflection.shape.evidence, candidate: ReflectionCandidate,
  review: z.object({ at, note: text, result: z.object({ kind: z.enum(['memory', 'mission']), id: uuid, version: positive.optional() }).strict().optional() }).strict().optional() }).strict()

export interface ResultStateVerification {
  version: 1; records: number; blobs: number; blobBytes: number; artifacts: number; memories: number; edges: number;
  legacyBindings: number; checks: number; checkVersions: number; runs: number; successfulRuns: number; unsettledRuns: number;
  reviews: number; seals: number; legacyReviewSeals: number; completions: number; reflectionPromotions: number; partialOutputs: number; digest: string
}
/** Bounded relation diagnostics that never include artifact content, commands or credentials. */
export class ResultStateError extends Error {
  constructor(readonly code: string, readonly record: string) { super(`recovery_results_${code}: ${record.slice(0, 200)}`) }
}

/** Authenticate recorded relationships; old, revoked, expired and unknown outcomes remain historical, never re-admitted. */
export async function verifyResultState(db: DatabaseSync, signal: AbortSignal): Promise<ResultStateVerification> {
  function fail(code: string, record: string): never { throw new ResultStateError(code, record) }
  const same = (a: unknown, b: unknown, label: string) => { if (!isDeepStrictEqual(a, b)) fail('conflict', label) }
  const parse = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
    const parsed = schema.safeParse(value)
    // Request defaults are useful at admission, but recovery must not invent omitted persisted fields or trim evidence.
    if (!parsed.success || !isDeepStrictEqual(parsed.data, value)) fail('shape', label); return value as T
  }
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
  const hash = createHash('sha256'); let records = 0, bytes = 0, links = 0, ticks = 0, artifacts = 0, memories = 0,
    legacyBindings = 0, successfulRuns = 0, unsettledRuns = 0, seals = 0, legacyReviewSeals = 0, completions = 0, reflectionPromotions = 0, partialOutputs = 0
  const checkpoint = async (weight = 1) => { signal.throwIfAborted(); if ((links += weight) > 2_000_000) fail('limit', 'relations'); if (++ticks % 64 === 0) await setImmediate(undefined, { signal }) }
  const charge = (size: number, label: string) => { if (++records > 250000 || size > 8 * 1024 * 1024 || (bytes += size) > 768 * 1024 * 1024) fail('limit', label) }
  function json<T>(raw: unknown, schema: z.ZodType<T>, label: string): T {
    charge(Buffer.byteLength(String(raw)), label)
    let value: unknown; try { value = JSON.parse(String(raw)) } catch { fail('shape', label) }
    return parse(schema, value, label)
  }
  function* rows<T>(table: string, schema: z.ZodType<T>) {
    if (!tables.has(table)) return
    for (const row of db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).iterate()) {
      const value = json(row.value, schema, table); hash.update(JSON.stringify([table, row]) + '\n'); yield { row, value }
    }
  }
  const needed = <T>(map: Map<string, T>, identity: string, label: string): T => map.get(identity) ?? fail('reference', `${label}:${identity}`)
  function core<T>(table: string, identity: string): T {
    const row = tables.has(table) && db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(identity)
    if (!row) fail('reference', `${table}:${identity}`)
    const value = json(row.value, object, table); hash.update(JSON.stringify([table, identity, row]) + '\n'); return value as T
  }
  const blobs = new Map<string, { bytes: number }>(); let blobBytes = 0
  if (tables.has('workspace_blob')) for (const row of db.prepare('SELECT * FROM workspace_blob ORDER BY rowid').iterate()) {
    await checkpoint(); parse(digest, row.hash, 'blob'); parse(positive.max(LIBRARY_MAX_BYTES), row.bytes, 'blob')
    if (!(row.data instanceof Uint8Array)) fail('shape', 'blob')
    const data = Buffer.from(row.data); charge(data.length, 'blob')
    if (data.length !== row.bytes || fingerprintBytes(data) !== row.hash) fail('content', 'blob')
    blobBytes += data.length; blobs.set(String(row.hash), { bytes: data.length }); hash.update(JSON.stringify(['workspace_blob', row.hash, row.bytes]) + '\n').update(data)
  }
  const library = new Map<string, LibraryRecord & { revision: number; rowid: number }>(), expectedEdges = new Set<string>()
  for (const { row, value } of rows('workspace_library', librarySchema)) {
    await checkpoint(1 + value.sources.length); same([row.id, row.scope, row.kind, row.expires_at], [value.id, value.scope, value.kind, value.expiresAt ?? null], 'library_index')
    parse(positive, row.revision, 'library_revision'); parse(z.union([z.literal(0), z.literal(1)]), row.archived, 'library_archived')
    same(needed(blobs, value.hash, 'library_blob').bytes, value.bytes, `library_size:${value.id}`)
    if (value.scope.startsWith('mission:')) core<Mission>('workspace_mission', value.scope.slice(8))
    else if (value.scope.startsWith('ticket:')) core<Ticket>('ticket', value.scope.slice(7))
    const data = Buffer.from(db.prepare('SELECT data FROM workspace_blob WHERE hash=?').get(value.hash)!.data as Uint8Array)
    charge(data.length, 'library_content')
    same(value.text, value.mime.startsWith('text/') || value.mime === 'application/json', `library_text:${value.id}`)
    if (value.text && !Buffer.from(data.toString('utf8')).equals(data)) fail('content', `library_utf8:${value.id}`)
    if (value.kind === 'memory' && (value.bytes > 65536 || !['text/plain', 'text/markdown'].includes(value.mime))) fail('content', `memory:${value.id}`)
    const p = value.provenance
    if (p.actor === 'operator') {
      same(p, { actor: 'operator', trust: 'operator_submission' }, `library_provenance:${value.id}`)
      if (value.execution || value.reflectionReview) fail('provenance', value.id)
    } else {
      if (p.trust !== 'agent_submission' || !p.ticketId || p.sessionId !== workerSessionId(p.ticketId)) fail('provenance', value.id)
      const ticket = core<Ticket>('ticket', p.ticketId), trigger = core<Trigger>('trigger', ticket.origin.triggerId)
      same([p.triggerId, p.triggerHash], [trigger.id, key(JSON.stringify(trigger))], `library_origin:${value.id}`)
      if (p.assignmentId && !ticket.assignments.some(item => item.id === p.assignmentId)) fail('assignment', value.id)
      if (!value.reflectionReview) same(value.scope, trigger.source === 'workspace' && typeof trigger.meta.mission === 'string'
        ? `mission:${trigger.meta.mission}` : `ticket:${ticket.id}`, `library_scope:${value.id}`)
      if (value.execution) {
        same([value.execution.assignmentId, value.execution.sessionId], [p.assignmentId, p.sessionId], `library_execution:${value.id}`)
        const assignment = ticket.assignments.find(item => item.id === p.assignmentId)!
        const original = assignment?.execution
        // Older assignments may lack a location snapshot. Preserve the record's captured location without substituting a newer ticket location.
        if (original) { const { capturedAt: _, assignmentId: __, sessionId: ___, ...actual } = value.execution; same(actual, original, `library_location:${value.id}`) }
        else legacyBindings++
      } else legacyBindings++
    }
    const indexed = tables.has('workspace_library_search') && db.prepare('SELECT title,summary,body FROM workspace_library_search WHERE rowid=?').get(row.rowid!)
    same(indexed && { ...indexed }, { title: value.title, summary: value.summary, body: value.text ? data.toString('utf8').slice(0, 65536) : '' }, `library_search:${value.id}`)
    for (const edge of value.sources) {
      const source = needed(library, edge.id, 'library_source')
      if (source.hash !== edge.hash || source.scope !== value.scope && (source.scope !== 'workspace' || edge.relation === 'supersedes')) fail('provenance', value.id)
      expectedEdges.add(JSON.stringify([value.id, edge.id, edge.relation]))
    }
    library.set(value.id, { ...value, revision: Number(row.revision), rowid: Number(row.rowid) }); if (value.kind === 'artifact') artifacts++; else memories++
  }
  if (tables.has('workspace_library_search')) same(Number(db.prepare('SELECT count(*) AS n FROM workspace_library_search').get()!.n), library.size, 'library_search_count')
  let edges = 0
  if (tables.has('workspace_library_edge')) for (const row of db.prepare('SELECT * FROM workspace_library_edge ORDER BY rowid').iterate()) {
    await checkpoint(); charge(Buffer.byteLength(JSON.stringify(row)), 'library_edge'); hash.update(JSON.stringify(['workspace_library_edge', row]) + '\n')
    if (!expectedEdges.delete(JSON.stringify([row.source, row.target, row.relation]))) fail('edge', 'library_edge'); edges++
  }
  if (expectedEdges.size) fail('edge', 'missing_library_edge')
  const libraryCommands = new Map<string, number>()
  if (tables.has('workspace_library_command')) for (const row of db.prepare('SELECT * FROM workspace_library_command ORDER BY rowid').iterate()) {
    await checkpoint(); charge(Buffer.byteLength(JSON.stringify(row)), 'library_command'); parse(CheckCommandId, row.id, 'library_command'); parse(shortHash, row.fingerprint, 'library_command')
    const record = needed(library, String(row.record), 'library_command')
    if (row.actor !== 'operator' && (record.provenance.actor !== 'worker' || row.actor !== `worker:${record.provenance.ticketId}`)) fail('command_actor', 'library_command')
    libraryCommands.set(record.id, (libraryCommands.get(record.id) ?? 0) + 1); hash.update(JSON.stringify(['workspace_library_command', row]) + '\n')
  }
  for (const record of library.values()) same(libraryCommands.get(record.id), record.revision, `library_commands:${record.id}`)
  const reflectionResults = new Map<string, z.infer<typeof reflectionProposal>>()
  for (const { row, value } of rows('workspace_reflection_proposal', reflectionProposal)) {
    await checkpoint(); same([row.id, row.run], [value.id, value.runId], 'reflection_proposal')
    if (value.status === 'pending' ? value.revision !== 1 || !!value.review : value.revision !== 2 || !value.review) fail('review', value.id)
    if (value.status !== 'approved' && value.review?.result || value.status === 'approved' && !value.review?.result) fail('review', value.id)
    const ticket = core<Ticket>('ticket', value.ticketId), trigger = core<Trigger>('trigger', ticket.origin.triggerId), run = core<any>('workspace_reflection', value.runId)
    if (trigger.meta.mission !== run.missionId || !ticket.assignments.some(item => item.id === value.assignmentId)) fail('reflection_author', value.id)
    if (run.id !== value.runId || key(JSON.stringify(run.snapshot)) !== run.snapshotHash || Buffer.byteLength(JSON.stringify(run.snapshot)) !== run.bytes) fail('reflection_snapshot', value.id)
    if (!value.evidence.missions.length && !value.evidence.records.length || value.evidence.missions.some(id => !run.snapshot.missions.some((item: any) => item.value.id === id))
      || value.evidence.records.some(id => !run.snapshot.records.some((item: any) => item.value.id === id))) fail('reflection_evidence', value.id)
    if (value.status === 'approved') {
      reflectionPromotions++; const result = value.review!.result!, candidate = value.candidate
      if (candidate.kind === 'memory') {
        const record = needed(library, result.id, 'reflection_memory')
        same(result, { kind: 'memory', id: record.id }, `reflection_result:${value.id}`)
        same(record.reflectionReview, { runId: value.runId, proposalId: value.id, ticketId: value.ticketId, assignmentId: value.assignmentId }, `reflection_review:${value.id}`)
        same([record.kind, record.title, record.summary, record.scope, record.hash], ['memory', candidate.title, candidate.summary,
          candidate.missionId ? `mission:${candidate.missionId}` : 'workspace', fingerprintBytes(Buffer.from(candidate.content))], `reflection_memory:${value.id}`)
        same(record.sources.map(item => ({ id: item.id, relation: item.relation })), value.evidence.records.map(id => ({ id, relation: 'derived_from' })), `reflection_sources:${value.id}`)
      } else {
        if (result.kind !== 'mission' || !result.version || candidate.kind === 'plan' && result.id !== candidate.missionId) fail('reflection_result', value.id)
        const version = db.prepare('SELECT value FROM workspace_plan_version WHERE mission=? AND version=?').get(result.id, result.version)
        if (!version || json(version.value, object, 'reflection_plan').proposalId !== value.id) fail('reflection_result', value.id)
      }
    }
    reflectionResults.set(value.id, value)
  }
  for (const record of library.values()) if (record.reflectionReview) {
    const proposal = needed(reflectionResults, record.reflectionReview.proposalId, 'reflection_review')
    if (proposal.status !== 'approved' || proposal.review?.result?.id !== record.id || proposal.candidate.kind !== 'memory'
      || record.provenance.ticketId !== proposal.ticketId || record.provenance.assignmentId !== proposal.assignmentId) fail('reflection_result', record.id)
  }
  const versions = new Map<string, CheckVersion>(), definitions = new Map<string, z.infer<typeof checkRecord>>()
  for (const { row, value } of rows('verification_check', checkRecord)) { await checkpoint(); same(row.id, value.id, 'check_identity'); definitions.set(value.id, value) }
  const versionKey = (id: string, version: number) => JSON.stringify([id, version]), versionCounts = new Map<string, number>()
  for (const { row, value } of rows('verification_check_version', checkVersion)) {
    await checkpoint(); same([row.id, row.version], [value.id, value.version], 'check_version')
    needed(definitions, value.id, 'check'); same(value.hash, fingerprint({ id: value.id, version: value.version, definition: value.definition }), `check_hash:${value.id}`)
    versions.set(versionKey(value.id, value.version), value); versionCounts.set(value.id, (versionCounts.get(value.id) ?? 0) + 1)
  }
  for (const value of definitions.values()) {
    same(versionCounts.get(value.id), value.version, `check_history:${value.id}`)
    for (let version = 1; version <= value.version; version++) { await checkpoint(); needed(versions, versionKey(value.id, version), 'check_history') }
    const { revision: _, enabled: __, workers: ___, updatedAt: ____, ...current } = value
    same(current, needed(versions, versionKey(value.id, value.version), 'current_check'), `current_check:${value.id}`)
  }
  const checkCommands = new Map<string, z.infer<typeof checkRecord>>()
  const commandSchema = z.union([CreateCheck.extend({ op: z.literal('create') }).strict(), SaveCheck.extend({ op: z.literal('update'), id: uuid }).strict(),
    ConfigureCheck.extend({ op: z.literal('configure'), id: uuid }).strict()])
  for (const { row, value } of rows('verification_check_command', checkRecord)) {
    await checkpoint(); const request = json(row.request, commandSchema, 'check_command')
    same([row.id, row.fingerprint], [request.requestId, fingerprint(request)], 'check_command')
    const prior = checkCommands.get(value.id), version = needed(versions, versionKey(value.id, value.version), 'check_command_version')
    if (request.op === 'create') {
      if (prior) fail('check_command', value.id)
      same(value, { ...version, revision: 1, enabled: request.enabled, workers: request.workers, updatedAt: version.createdAt }, `check_create:${value.id}`)
      same(version.definition, request.definition, `check_create_definition:${value.id}`)
    } else {
      if (!prior || request.id !== value.id || request.revision !== prior.revision || value.revision !== prior.revision + 1) fail('check_command', value.id)
      if (request.op === 'update') {
        same(value, { ...prior, ...version, revision: prior.revision + 1, updatedAt: value.updatedAt }, `check_update:${value.id}`)
        same([value.version, value.definition], [prior.version + 1, request.definition], `check_update_definition:${value.id}`)
      } else same(value, { ...prior, revision: prior.revision + 1, enabled: request.enabled, workers: request.workers, updatedAt: value.updatedAt }, `check_configure:${value.id}`)
    }
    checkCommands.set(value.id, value)
  }
  for (const value of definitions.values()) same(checkCommands.get(value.id), value, `check_commands:${value.id}`)
  const runs = new Map<string, StoredCheckRun>()
  for (const { row, value } of rows('verification_run', runSchema)) {
    await checkpoint(); const run = value as StoredCheckRun; same(row.id, run.id, 'run_identity')
    const artifact = needed(library, run.artifact.id, 'run_artifact')
    if (artifact.kind !== 'artifact' || run.artifact.revision > artifact.revision) fail('artifact', run.id)
    same([run.artifact.hash, run.artifact.scope, run.artifact.ticketId, run.artifact.assignmentId, run.artifact.sessionId],
      [artifact.hash, artifact.scope, artifact.provenance.ticketId, artifact.provenance.assignmentId, artifact.provenance.sessionId], `run_artifact:${run.id}`)
    same(run.execution, artifact.execution, `run_execution:${run.id}`)
    same(run.check, needed(versions, versionKey(run.check.id, run.check.version), 'run_check'), `run_check:${run.id}`)
    if (run.check.definition.scope !== 'workspace' && run.check.definition.scope !== artifact.scope) fail('check_scope', run.id)
    same(run.owner, { kind: 'assignment', ticketId: run.artifact.ticketId, assignmentId: run.artifact.assignmentId,
      sessionId: run.artifact.sessionId, callId: run.id, tool: 'artifact_verification' }, `run_owner:${run.id}`)
    const definition = run.check.definition, expected = run.request.verification
    if (!expected || (run.purpose === 'freshness') !== !!run.sourceCheckId) fail('request', run.id)
    const request = { requestId: run.id, check: { id: run.check.id, version: run.check.version }, artifactRevision: run.artifact.revision,
      artifactHash: run.artifact.hash, ...(expected.expectedSnapshot ? { expectedSnapshot: expected.expectedSnapshot } : {}),
      ...(expected.expectedRepository ? { expectedRepository: expected.expectedRepository } : {}) }
    same(run.fingerprint, fingerprint({ artifactId: run.artifact.id, request,
      actor: run.actor === 'worker' ? { role: 'worker', ticketId: run.artifact.ticketId } : { role: 'operator' }, sourceCheckId: run.sourceCheckId }), `run_fingerprint:${run.id}`)
    same(run.request, JSON.parse(JSON.stringify(Rpc.parse({ op: 'job.spawn', requestId: run.id, owner: run.owner, revision: run.backend.revision, cwd: run.backend.source,
      argv: definition.argv, env: definition.env, stdin: definition.stdin, graceMs: 1000, verification: { kind: run.purpose === 'freshness' ? 'capture' : 'check',
        snapshot: definition.snapshot, timeoutSeconds: definition.timeoutSeconds, artifact: { path: definition.artifactPath, hash: artifact.hash },
        expectedSnapshot: expected.expectedSnapshot, expectedRepository: expected.expectedRepository } }))), `run_request:${run.id}`)
    same(run.requestHash, fingerprint({ principal: { role: 'grant', id: run.backend.grantId, epoch: run.backend.epoch }, request: run.request }), `request_hash:${run.id}`)
    if (run.backend.kind === 'local') {
      same(run.backend.binding, fingerprint({ directory: run.execution.directory, mode: run.execution.mode, environment: run.execution.environment }), `local_binding:${run.id}`)
      same([run.backend.grantId, run.backend.epoch, run.backend.revision], [run.execution.environment?.environmentId ?? 'local', run.execution.environment?.epoch ?? 1,
        run.execution.environment?.revision ?? 1], `local_generation:${run.id}`)
      if (run.execution.environment?.world || run.backend.endpointId) fail('local_binding', run.id)
    }
    else if (!run.backend.endpointId || run.backend.binding !== run.execution.environment?.world) fail('remote_binding', run.id)
    if (run.receipt) {
      if (run.backend.kind !== 'remote' || run.evidence) fail('receipt', run.id)
      same([run.receipt.id, run.receipt.grantId, run.receipt.epoch, run.receipt.revision, run.receipt.fingerprint, run.receipt.request, run.receipt.quiescent, run.receipt.outcome],
        [run.id, run.backend.grantId, run.backend.epoch, run.backend.revision, run.requestHash, run.request, run.quiescent, run.outcome], `receipt:${run.id}`)
    }
    const evidence = checkEvidence(run)
    if (evidence?.snapshot) { try { validateSnapshot(evidence.snapshot) } catch { fail('snapshot', run.id) }; await checkpoint(evidence.snapshot.entries.length) }
    if (run.status === 'passed' || run.status === 'captured') {
      if (!run.quiescent || !completedCheck(run, evidence, true) || (run.status === 'captured') !== (run.purpose === 'freshness')) fail('outcome', run.id)
      successfulRuns++
    }
    if (!run.quiescent) unsettledRuns++
    runs.set(run.id, run)
  }
  const outputs = new Map<string, { bytes: number; total: number; hash: string }>()
  if (tables.has('verification_output')) for (const row of db.prepare('SELECT * FROM verification_output ORDER BY rowid').iterate()) {
    await checkpoint(); const run = needed(runs, String(row.id), 'output_run'); parse(z.enum(['stdout', 'stderr']), row.stream, 'output_stream'); parse(count, row.total, 'output_total')
    if (run.backend.kind !== 'local' || !(row.data instanceof Uint8Array)) fail('output', run.id)
    const data = Buffer.from(row.data); charge(data.length, 'output')
    if (data.length > 1024 * 1024 || data.length !== Math.min(Number(row.total), 1024 * 1024)) fail('output', run.id)
    outputs.set(JSON.stringify([run.id, row.stream]), { bytes: data.length, total: Number(row.total), hash: fingerprintBytes(data) })
    hash.update(JSON.stringify(['verification_output', row.id, row.stream, row.total]) + '\n').update(data)
  }
  for (const run of runs.values()) if (run.backend.kind === 'local' && checkEvidence(run)?.output) {
    for (const stream of ['stdout', 'stderr'] as const) {
      const expected = checkEvidence(run)!.output![stream], actual = outputs.get(JSON.stringify([run.id, stream])) ?? { bytes: 0, total: 0, hash: fingerprintBytes(Buffer.alloc(0)) }
      same(expected.bytes, actual.total, `output_bytes:${run.id}:${stream}`)
      if (actual.bytes === actual.total) same(expected.hash, actual.hash, `output_hash:${run.id}:${stream}`)
      else partialOutputs++
    }
  }
  if (tables.has('verification_control')) for (const row of db.prepare('SELECT * FROM verification_control ORDER BY rowid').iterate()) {
    await checkpoint(); const value = json(row.request, z.union([
      z.object({ operation: z.literal('cancel'), id: CheckCommandId, actor: z.union([z.object({ role: z.literal('operator') }).strict(),
        z.object({ role: z.literal('worker'), ticketId: id }).strict()]), request: CancelCheck }).strict(),
      z.object({ operation: z.literal('reconcile'), id: CheckCommandId, request: ReconcileCheck }).strict(),
    ]), 'verification_control')
    const run = needed(runs, value.id, 'controlled_run')
    same([row.id, row.fingerprint], [value.request.requestId, fingerprint(value)], 'verification_control')
    if (value.operation === 'cancel' && value.actor.role === 'worker' && value.actor.ticketId !== run.artifact.ticketId) fail('control_actor', run.id)
    if (value.operation === 'reconcile' && (run.backend.kind !== 'local' || run.reconciliation?.requestId !== value.request.requestId
      || run.reconciliation.reason !== value.request.reason || run.quiescent !== true)) fail('reconciliation', run.id)
    hash.update(JSON.stringify(['verification_control', row]) + '\n')
  }
  for (const run of runs.values()) if (run.sourceCheckId) {
    const original = needed(runs, run.sourceCheckId, 'freshness_check')
    if (original.purpose !== 'check' || !checkEvidence(original)?.snapshot) fail('freshness', run.id)
    same([run.artifact, run.check, run.execution, run.request.verification!.expectedSnapshot],
      [original.artifact, original.check, original.execution, checkEvidence(original)!.snapshot!.hash], `freshness:${run.id}`)
  }
  function selection(runId: string) {
    const run = needed(runs, runId, 'selected_check')
    if (run.purpose !== 'check' || run.status !== 'passed' || !run.quiescent || !completedCheck(run, checkEvidence(run), true)) fail('selected_check', runId)
    return recordedCheckBinding(run)
  }
  function seal(input: unknown) {
    const value = parse(EvidenceSeal, input, 'seal'), { capture, validUntil, ...binding } = value
    same(binding, selection(value.selection.runId), `seal_binding:${value.selection.runId}`)
    const original = needed(runs, value.selection.runId, 'selected_check'), captured = needed(runs, capture.id, 'capture'), evidence = checkEvidence(captured)
    if (captured.purpose !== 'freshness' || captured.status !== 'captured' || !captured.quiescent || !completedCheck(captured, evidence, true)
      || captured.backend.binding !== original.backend.binding || captured.backend.source !== original.backend.source || captured.backend.grantId !== original.backend.grantId
      || captured.backend.epoch !== original.backend.epoch || captured.backend.revision < original.backend.revision
      || evidence?.snapshot?.hash !== value.snapshotHash || evidence?.confinement !== value.confinement) fail('seal_capture', capture.id)
    same([capture.capturedAt, capture.finishedAt], [evidence!.snapshot!.capturedAt, evidence!.finishedAt], `capture_time:${capture.id}`)
    const from = Date.parse(capture.capturedAt), until = Date.parse(validUntil)
    if (until <= from || until > from + FRESHNESS_WINDOW_MS || Date.parse(capture.finishedAt) < from) fail('seal_window', capture.id)
    seals++; return value
  }
  const reviews = new Map<string, EvidenceReview>()
  for (const { row, value } of rows('verification_review', reviewSchema)) {
    await checkpoint(); same(row.id, value.id, 'review_identity')
    same(row.fingerprint, fingerprint({ id: value.id, purpose: value.purpose, target: value.target, checks: value.checks }), `review_fingerprint:${value.id}`)
    const groups = new Map<string, string>()
    for (const check of value.checks) {
      same(check, selection(check.runId).selection, `review_selection:${value.id}`)
      const run = needed(runs, check.runId, 'review_check'), source = fingerprint({ backend: run.backend, snapshot: checkEvidence(run)!.snapshot!.hash })
      if (!groups.has(source)) groups.set(source, run.id)
    }
    const seen = new Set<string>()
    for (const attempt of value.attempts) {
      await checkpoint(attempt.captures.length)
      if (seen.has(attempt.id)) fail('review_attempt', value.id); seen.add(attempt.id)
      same(attempt.captures.map(item => [item.source, item.checkId]), [...groups], `review_sources:${value.id}`)
      for (const capture of attempt.captures) {
        if (seen.has(capture.id)) fail('review_attempt', value.id); seen.add(capture.id)
        const run = runs.get(capture.id)
        if (run && (run.purpose !== 'freshness' || run.sourceCheckId !== capture.checkId)) fail('review_capture', value.id)
      }
      if (attempt.evidence) {
        same(attempt.evidence.map(item => item.selection), value.checks, `attempt_evidence:${value.id}`)
        for (const evidence of attempt.evidence) {
          seal(evidence); if (!attempt.captures.some(item => item.id === evidence.capture.id)) fail('attempt_capture', value.id)
        }
      }
    }
    if (value.status === 'ready' && !value.evidence) fail('review_evidence', value.id)
    if (value.evidence) {
      if (value.attempts.at(-1)?.evidence) same(value.evidence, value.attempts.at(-1)!.evidence, `latest_evidence:${value.id}`)
      else if (value.attempts.at(-1)?.evidenceVersion === 1) fail('latest_evidence', value.id)
      else legacyReviewSeals++
      same(value.evidence.map(item => item.selection), value.checks, `review_evidence:${value.id}`)
      for (const evidence of value.evidence) {
        seal(evidence)
        if (!value.attempts.at(-1)?.captures.some(item => item.id === evidence.capture.id)) fail('review_capture', value.id)
      }
    }
    reviews.set(value.id, value)
  }
  // Historical acceptance may be stale now; validate its recorded evidence without renewing its freshness window.
  for (const { value } of rows('workspace_mission', object)) {
    await checkpoint(); const mission = value as unknown as Mission
    for (const action of mission.actions) if (action.accepted?.evidence) {
      if (action.accepted.basis !== 'checks') fail('acceptance', mission.id)
      for (const input of action.accepted.evidence) {
        const value = seal(input), run = needed(runs, value.selection.runId, 'accepted_check')
        if (!action.runs.includes(run.artifact.ticketId)) fail('accepted_ticket', mission.id)
      }
    }
    if (mission.completion) {
      const completion = mission.completion, attempt = core<any>('mission_completion', completion.requestId)
      parse(z.object({ requestId: CheckCommandId, target: digest, at, actions: z.array(z.looseObject({ id, reviewId: CheckCommandId.optional(),
        evidenceHash: digest.optional(), checks: count.max(32) })).max(200) }).strict(), completion, 'mission_completion')
      if (attempt.status !== 'completed' || attempt.missionId !== mission.id || attempt.target !== completion.target) fail('completion', mission.id)
      same(completion.actions.map(item => item.id), mission.actions.map(item => item.id), `completion_actions:${mission.id}`)
      for (const action of completion.actions) if (action.reviewId) {
        const review = needed(reviews, action.reviewId, 'completion_review')
        if (review.purpose !== 'closure' || review.target !== completion.target || action.checks !== review.checks.length) fail('completion_evidence', mission.id)
        const historical = [review.evidence, ...review.attempts.map(item => item.evidence)].find(item => item && fingerprint(item) === action.evidenceHash)
        if (!historical) {
          if (!review.attempts.some(item => item.evidenceVersion === undefined)) fail('completion_evidence', mission.id)
          legacyReviewSeals++
        }
      } else if (action.checks || action.evidenceHash) fail('completion_evidence', mission.id)
    }
  }
  const completionSchema = z.object({ id: CheckCommandId, missionId: id, command: MissionCommand, target: digest, createdAt: at, updatedAt: at,
    status: z.enum(['preparing', 'held', 'completed']), problem: z.string().max(4000).optional(),
    reviews: z.array(z.object({ actionId: id, id: CheckCommandId }).strict()).max(200) }).strict()
  for (const { row, value } of rows('mission_completion', completionSchema)) {
    await checkpoint(); same([row.id, row.mission, value.command.requestId, value.command.status], [value.id, value.missionId, value.id, 'completed'], 'completion_identity')
    core<Mission>('workspace_mission', value.missionId); same(row.fingerprint, fingerprint({ missionId: value.missionId, command: value.command, target: value.target }), `completion_request:${value.id}`)
    if (new Set(value.reviews.map(item => item.actionId)).size !== value.reviews.length) fail('completion_reviews', value.id)
    for (const review of value.reviews) {
      same(review.id, `closure-${fingerprint({ request: value.id, mission: value.missionId, action: review.actionId })}`, `completion_review:${value.id}`)
      const present = reviews.get(review.id)
      if (present && (present.purpose !== 'closure' || present.target !== value.target)) fail('completion_review', value.id)
      if (value.status === 'completed' && !present) fail('completion_review', value.id)
    }
    completions++
  }
  signal.throwIfAborted()
  return { version: 1, records, blobs: blobs.size, blobBytes, artifacts, memories, edges, legacyBindings, checks: definitions.size, checkVersions: versions.size,
    runs: runs.size, successfulRuns, unsettledRuns, reviews: reviews.size, seals, legacyReviewSeals, completions, reflectionPromotions, partialOutputs, digest: hash.digest('hex') }
}
const fingerprintBytes = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
