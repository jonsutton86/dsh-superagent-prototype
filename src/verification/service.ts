/** Artifact verification uses host-selected definitions and original Harness execution worlds. */
import { z } from 'zod'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { SubprocessRuntime, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { Store } from '../app/store.ts'
import type { ExecutionLocation } from '../core/model.ts'
import { latestAssignment, liveTicket } from '../core/model.ts'
import type { Library } from '../workspace/library.ts'
import type { LibraryActor, LibraryRead } from '../workspace/library-model.ts'
import { WorkspaceError } from '../workspace/model.ts'
import type { RemoteWorld } from '../remote/world.ts'
import { Rpc, Operations, type EndpointIdentity, type OutputWindow, type RemoteJob } from '../remote/protocol.ts'
import { worldBinding } from '../remote/world-journal.ts'
import { fingerprint, inside, timestamp } from '../remote/journal.ts'
import { OwnershipStamp } from '../ownership/protocol.ts'
import { BubblewrapIsolation, type ExecutionIsolation } from '../remote/isolation.ts'
import { CheckDefinitions } from './definitions.ts'
import { CheckCommandId, RequestCheck, CancelCheck, ReconcileCheck, type CheckRun, type CheckRunSummary, type CheckVersion, type StoredCheckRun } from './contracts.ts'
import { CheckEvidenceSchema, snapshotReservation, type CheckEvidence } from './model.ts'
import { validateSnapshot } from './snapshot.ts'
import { HostProcessIsolation, snapshotHelperPath } from './local.ts'
import { discardSnapshot, runCapturedCheck } from './runner.ts'
import { EvidenceBinding, CheckSelection, EvidenceSeal, FRESHNESS_WINDOW_MS } from './review-model.ts'

interface Host {
  store: Store; library: Library; stateDir: string; subprocess: SubprocessRuntime; lifetime: AbortSignal
  authorize(): void; allowed(location: ExecutionLocation): boolean; localAllowed(): boolean
  paused?(): boolean
  remote(location: ExecutionLocation): RemoteWorld | undefined
  workerProblem?(ticketId: string): string | undefined
}
type Actor = Exclude<LibraryActor, { role: 'router' }>
type Driver = { world?: RemoteWorld; isolation?: ExecutionIsolation; binding: CheckRun['backend'] }
const operator: Actor = { role: 'operator' }, evidenceOf = (run: StoredCheckRun) => run.receipt?.verification ?? run.evidence
const grantStatus = z.object({ authorized: z.boolean(), grant: z.object({ id: z.string(), owner: z.string(), workspace: z.string(), root: z.string(),
  rootIdentity: z.string(), operations: z.array(Operations), epoch: z.number().int().positive(), revision: z.number().int().positive(), enabled: z.boolean(),
  leaseUntil: z.number().finite(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  credentials: z.array(z.object({ id: z.string(), version: z.string(), variable: z.string(), mode: z.enum(['env', 'file']) }).strict()).optional() }).strict() }).strict()
const outcome = z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict()
const receiptSchema = z.object({ id: z.string(), grantId: z.string(), epoch: z.number().int().positive(), revision: z.number().int().positive(), fingerprint: z.string(),
  phase: z.enum(['accepted', 'started', 'settled', 'unknown']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  request: Rpc, cancelRequested: z.boolean(), quiescent: z.boolean().nullable(), credentials: z.never().optional(), verification: CheckEvidenceSchema.optional(),
  ownership: OwnershipStamp.optional(), outcome: outcome.optional(), error: z.string().max(4000).optional(),
  reconciled: z.object({ at: z.string().datetime(), note: z.string().max(2000) }).strict().optional() }).strict()
export const CheckOutputQuery = z.object({ stream: z.enum(['stdout', 'stderr']), offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(65536).default(16000) }).strict()
const view = ({ fingerprint: _, request: __, requestHash: ___, receipt, ...run }: StoredCheckRun): CheckRun => ({ ...run, evidence: receipt?.verification ?? run.evidence })
const summary = (record: StoredCheckRun): CheckRunSummary => {
  const { execution: _, check, evidence, ...run } = view(record), snapshot = evidence?.snapshot
  return { ...run, check: { id: check.id, version: check.version, hash: check.hash, name: check.definition.name },
    evidence: evidence ? { ...evidence, snapshot: snapshot && (({ entries: _, ...value }) => value)(snapshot) } : undefined }
}

/** Coordinates original-world checks, durable evidence and observation-only recovery without trusting model claims. */
export class Verification {
  readonly definitions: CheckDefinitions
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly localCancellation = new Map<string, AbortController>()
  private readonly localHandles = new Map<string, SubprocessHandle>()
  private readonly stopped = new AbortController()
  private timer?: ReturnType<typeof setInterval>
  private ticking?: Promise<void>
  private closed = false
  private closing?: Promise<void>
  private maintenanceOffset = 0
  constructor(private readonly host: Host) {
    this.definitions = new CheckDefinitions(host.store)
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS verification_run (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS verification_artifact ON verification_run(json_extract(value,'$.artifact.id'));
      CREATE INDEX IF NOT EXISTS verification_check_run ON verification_run(json_extract(value,'$.check.id'));
      CREATE INDEX IF NOT EXISTS verification_source ON verification_run(json_extract(value,'$.backend.binding'),json_extract(value,'$.backend.source'));
      CREATE TABLE IF NOT EXISTS verification_output (id TEXT, stream TEXT, data BLOB NOT NULL, total INTEGER NOT NULL, PRIMARY KEY(id,stream));
      CREATE TABLE IF NOT EXISTS verification_control (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request TEXT NOT NULL);`)
    for (const row of host.store.db.prepare("SELECT value FROM verification_run WHERE json_extract(value,'$.quiescent') IS NOT 1").all()) {
      const run = JSON.parse(String(row.value)) as StoredCheckRun
      run.status = 'unknown'; run.problem = 'Coordinator restarted; observe the original remote job or reconcile local execution. No check is replayed.'; this.save(run)
    }
  }
  private save(run: StoredCheckRun): void {
    if (this.closed) throw new Error('Verification service is closed')
    run.updatedAt = timestamp()
    this.host.store.db.prepare('INSERT INTO verification_run VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(run.id, JSON.stringify(run))
  }
  private require(id: string, actor: Actor = operator): StoredCheckRun {
    CheckCommandId.parse(id)
    const row = this.host.store.db.prepare('SELECT value FROM verification_run WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Verification run not found')
    const run = JSON.parse(String(row.value)) as StoredCheckRun
    this.host.library.read(run.artifact.id, {}, actor)
    if (actor.role === 'worker' && run.artifact.ticketId !== actor.ticketId) throw new WorkspaceError(404, 'Verification run not found')
    return run
  }
  get(id: string, actor: Actor = operator): CheckRun { return view(this.require(id, actor)) }
  /** Bind a host result, not a model-authored success claim. Observation skips dispatch/pause checks. */
  approval(id: string, expected?: CheckSelection, admit = true): EvidenceBinding {
    const run = this.require(id), evidence = evidenceOf(run)
    if (run.status !== 'passed' || run.purpose !== 'check' || run.quiescent !== true || !this.completed(run, evidence))
      throw new WorkspaceError(409, 'Select a complete successful host check')
    if (admit) this.authorize({ ...run, actor: 'operator' })
    else {
      const artifact = this.artifact(run.artifact.id, operator)
      if (artifact.revision !== run.artifact.revision || artifact.hash !== run.artifact.hash || fingerprint(artifact.execution) !== fingerprint(run.execution)
        || !this.definitions.get(run.check.id).enabled || this.definitions.version(run.check.id, run.check.version).hash !== run.check.hash || !this.host.allowed(run.execution))
        throw new WorkspaceError(409, 'Approved check authority, artifact or execution binding changed')
    }
    const evidenceHash = fingerprint({ artifact: run.artifact, check: run.check, execution: run.execution, backend: run.backend,
      snapshot: evidence!.snapshot, outcome: run.outcome, output: evidence!.output, checkedAt: evidence!.checkedAt, finishedAt: evidence!.finishedAt })
    if (expected && (expected.runId !== id || expected.evidenceHash !== evidenceHash)) throw new WorkspaceError(409, 'Selected check evidence changed')
    const repository = evidence!.snapshot!.repository
    return EvidenceBinding.parse({ selection: { runId: id, evidenceHash }, artifact: { id: run.artifact.id, revision: run.artifact.revision, hash: run.artifact.hash },
      check: { id: run.check.id, version: run.check.version, hash: run.check.hash }, snapshotHash: evidence!.snapshot!.hash,
      execution: { binding: run.backend.binding, assignmentId: run.artifact.assignmentId, sessionId: run.artifact.sessionId },
      ...(repository ? { repository: { commit: repository.commit, tree: repository.tree,
        ...(repository.contentTree ? { contentTree: repository.contentTree, statusHash: repository.statusHash } : {}) } } : {}), confinement: evidence!.confinement, checkedAt: evidence!.checkedAt })
  }
  reviewChoices(artifactId: string, offset = 0) {
    const page = this.list(artifactId, offset)
    return { ...page, items: page.items.flatMap(run => {
      try { return [{ run, binding: this.approval(run.id, undefined, false) }] } catch { return [] }
    }) }
  }
  /** Reuse a complete captured source for checks on that same snapshot; captures never become check outcomes. */
  seal(selection: CheckSelection, captureId: string, now = Date.now()): EvidenceSeal {
    const binding = this.approval(selection.runId, selection), selected = this.require(selection.runId), capture = this.require(captureId), evidence = evidenceOf(capture)
    if (capture.status !== 'captured' || capture.quiescent !== true || capture.purpose !== 'freshness' || !this.completed(capture, evidence)
      || !evidence?.snapshot || !evidence.finishedAt || capture.backend.binding !== selected.backend.binding
      || capture.backend.source !== selected.backend.source || capture.backend.grantId !== selected.backend.grantId
      || capture.backend.epoch !== selected.backend.epoch || capture.backend.revision < selected.backend.revision
      || evidence.snapshot.hash !== binding.snapshotHash || evidence.confinement !== binding.confinement)
      throw new WorkspaceError(409, 'The original source has no matching complete freshness capture')
    const at = Date.parse(evidence.snapshot.capturedAt)
    if (at > now + 5000 || now >= at + FRESHNESS_WINDOW_MS) throw new WorkspaceError(409, 'Source freshness capture expired or its host clock differs; capture again')
    return EvidenceSeal.parse({ ...binding, capture: { id: captureId, capturedAt: evidence.snapshot.capturedAt, finishedAt: evidence.finishedAt },
      validUntil: new Date(Math.min(now + FRESHNESS_WINDOW_MS, at + FRESHNESS_WINDOW_MS)).toISOString() })
  }
  /** A newer host observation of a different source invalidates claims that the reviewed source remains current. */
  sourceCurrent(seal: EvidenceSeal): boolean {
    const selected = this.require(seal.selection.runId)
    const newer = this.host.store.db.prepare(`SELECT json_extract(coalesce(json_extract(value,'$.receipt.verification'),json_extract(value,'$.evidence')),'$.snapshot.hash') AS hash
      FROM verification_run WHERE json_extract(value,'$.backend.binding')=? AND json_extract(value,'$.backend.source')=?
      AND json_extract(coalesce(json_extract(value,'$.receipt.verification'),json_extract(value,'$.evidence')),'$.finishedAt') IS NOT NULL
      AND json_extract(coalesce(json_extract(value,'$.receipt.verification'),json_extract(value,'$.evidence')),'$.snapshot.capturedAt')>=?
      AND json_extract(coalesce(json_extract(value,'$.receipt.verification'),json_extract(value,'$.evidence')),'$.snapshot.exclude')=?
      ORDER BY json_extract(coalesce(json_extract(value,'$.receipt.verification'),json_extract(value,'$.evidence')),'$.snapshot.capturedAt') DESC,rowid DESC LIMIT 1`)
      .get(selected.backend.binding, selected.backend.source, seal.capture.capturedAt, JSON.stringify(evidenceOf(selected)!.snapshot!.exclude))
    return !newer || newer.hash === seal.snapshotHash
  }
  list(artifactId: string, offset = 0, actor: Actor = operator) {
    this.host.library.read(artifactId, {}, actor)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new WorkspaceError(400, 'Invalid verification page')
    const rows = this.host.store.db.prepare("SELECT value FROM verification_run WHERE json_extract(value,'$.artifact.id')=? ORDER BY rowid DESC LIMIT 31 OFFSET ?").all(artifactId, offset)
    return { items: rows.slice(0, 30).map(row => summary(this.require((JSON.parse(String(row.value)) as StoredCheckRun).id, actor))), nextOffset: rows.length > 30 ? offset + 30 : null }
  }
  choices(artifactId: string, offset = 0, actor: Actor = operator) {
    const artifact = this.artifact(artifactId, actor), page = this.definitions.list(offset)
    return { ...page, items: page.items.filter(check => (actor.role !== 'worker' || check.workers && check.enabled)
      && (check.definition.scope === 'workspace' || check.definition.scope === artifact.scope)) }
  }
  private artifact(id: string, actor: Actor): LibraryRead & { execution: NonNullable<LibraryRead['execution']> } {
    const record = this.host.library.read(id, {}, actor)
    if (record.kind !== 'artifact' || record.archived || record.expired || record.superseded || record.conflicted || record.freshness?.status !== 'current')
      throw new WorkspaceError(409, 'Choose a current artifact with complete source provenance')
    if (!record.execution || !record.provenance.ticketId || record.execution.assignmentId !== record.provenance.assignmentId
      || record.execution.sessionId !== record.provenance.sessionId)
      throw new WorkspaceError(409, 'This artifact has no host-recorded original execution binding; historical location is not inferred')
    if (actor.role === 'worker' && record.provenance.ticketId !== actor.ticketId) throw new WorkspaceError(404, 'Artifact does not belong to this worker')
    return record as LibraryRead & { execution: NonNullable<LibraryRead['execution']> }
  }
  private authorize(run: Pick<StoredCheckRun, 'artifact' | 'execution' | 'actor' | 'check'>): void {
    this.host.authorize(); this.stopped.signal.throwIfAborted(); this.host.lifetime.throwIfAborted()
    if (this.host.paused?.()) throw new WorkspaceError(409, 'Verification dispatch is paused')
    const check = this.definitions.get(run.check.id)
    if (!check.enabled || run.actor === 'worker' && !check.workers) throw new WorkspaceError(409, 'Verification check authority is disabled')
    if (this.definitions.version(run.check.id, run.check.version).hash !== run.check.hash) throw new WorkspaceError(409, 'Check version integrity changed')
    const record = this.artifact(run.artifact.id, run.actor === 'worker' ? { role: 'worker', ticketId: run.artifact.ticketId } : operator)
    if (record.revision !== run.artifact.revision || record.hash !== run.artifact.hash || fingerprint(record.execution) !== fingerprint(run.execution))
      throw new WorkspaceError(409, 'Artifact or original execution binding changed')
    if (run.check.definition.scope !== 'workspace' && run.check.definition.scope !== record.scope) throw new WorkspaceError(409, 'Check scope does not authorize this artifact')
    if (!this.host.allowed(run.execution)) throw new WorkspaceError(409, 'Original execution environment is unavailable or revoked')
    if (run.actor === 'worker') {
      const ticket = this.host.store.tickets.get(run.artifact.ticketId), assignment = ticket && latestAssignment(ticket)
      if (!ticket || !liveTicket(ticket) || assignment?.id !== run.artifact.assignmentId || assignment.state === 'ended')
        throw new WorkspaceError(409, 'This worker assignment no longer authorizes new checks')
      const problem = this.host.workerProblem?.(ticket.id); if (problem) throw new WorkspaceError(409, problem)
    }
  }
  private async driver(location: CheckRun['execution'], check: CheckVersion): Promise<Driver> {
    const world = this.host.remote(location)
    if (world) {
      const status = world.status(), identity = await world.executionClient().call<EndpointIdentity>({ op: 'identity' }, this.stopped.signal)
      if (!identity.capabilities.snapshotVerification || check.definition.confinement === 'linux-bubblewrap' && identity.confinement !== 'linux-bubblewrap')
        throw new WorkspaceError(409, 'The assigned endpoint does not provide the required snapshot verification capability')
      if (location.environment?.world !== status.binding || !inside(world.grant.root, location.directory)) throw new WorkspaceError(409, 'Original execution world differs from the artifact binding')
      const target = z.object({ displayPath: z.string().min(1) }).parse(await world.executionClient().call({ op: 'fs.resolve', path: location.directory }, this.stopped.signal))
      if (!inside(world.grant.root, target.displayPath)) throw new WorkspaceError(409, 'Original source resolves outside its execution grant')
      // A renewable lease advances revision without replacing the original authority generation or source binding.
      const current = grantStatus.parse(await world.executionClient().call({ op: 'grant.status' }, this.stopped.signal))
      if (!current.authorized || !current.grant.enabled || current.grant.leaseUntil <= Date.now() || worldBinding(status.endpointId, current.grant) !== status.binding)
        throw new WorkspaceError(409, 'Original execution grant is unavailable or changed')
      return { world, binding: { kind: 'remote', binding: status.binding, source: target.displayPath, endpointId: status.endpointId, grantId: status.grantId, epoch: status.epoch,
        revision: current.grant.revision, confinement: check.definition.confinement } }
    }
    if (location.environment?.world || !this.host.localAllowed()) throw new WorkspaceError(409, 'Original remote execution cannot fall back to the coordinator host')
    const isolation = check.definition.confinement === 'linux-bubblewrap' ? new BubblewrapIsolation(this.host.subprocess) : new HostProcessIsolation()
    const binding = fingerprint({ directory: location.directory, mode: location.mode, environment: location.environment })
    return { isolation, binding: { kind: 'local', binding, source: await realpath(location.directory), grantId: location.environment?.environmentId ?? 'local', epoch: location.environment?.epoch ?? 1,
      revision: location.environment?.revision ?? 1, confinement: isolation.name } }
  }
  async request(artifactId: string, input: unknown, actor: Actor = operator, sourceCheckId?: string): Promise<CheckRun> {
    const request = RequestCheck.parse(input), hash = fingerprint({ artifactId, request, actor, sourceCheckId })
    const replay = this.host.store.db.prepare('SELECT value FROM verification_run WHERE id=?').get(request.requestId)
    if (replay) {
      const run = this.require(request.requestId, actor)
      if (run.fingerprint !== hash) throw new WorkspaceError(409, 'Verification request ID already belongs to a different check')
      return view(run)
    }
    const artifact = this.artifact(artifactId, actor), check = this.definitions.version(request.check.id, request.check.version), execution = artifact.execution
    if (artifact.revision !== request.artifactRevision || artifact.hash !== request.artifactHash) throw new WorkspaceError(409, 'Artifact revision changed; review its exact content again')
    const base = { id: request.requestId, artifact: { id: artifact.id, revision: artifact.revision, hash: artifact.hash, scope: artifact.scope,
      ticketId: artifact.provenance.ticketId!, assignmentId: execution.assignmentId, sessionId: execution.sessionId }, check, execution, actor: actor.role }
    this.authorize(base)
    const driver = await this.driver(execution, check)
    const run = this.host.store.atomic(() => {
      const raced = this.host.store.db.prepare('SELECT value FROM verification_run WHERE id=?').get(request.requestId)
      if (raced) {
        const original = this.require(request.requestId, actor)
        if (original.fingerprint !== hash) throw new WorkspaceError(409, 'Concurrent verification request differs')
        return undefined
      }
      this.authorize(base); const at = timestamp()
      const current = this.definitions.get(check.id), rows = this.host.store.db.prepare("SELECT value FROM verification_run WHERE json_extract(value,'$.check.id')=?").all(check.id)
        .map(row => JSON.parse(String(row.value)) as StoredCheckRun)
      if (rows.filter(item => item.quiescent !== true).length >= current.definition.maxConcurrent
        || rows.filter(item => item.createdAt.slice(0, 10) === at.slice(0, 10)).length >= current.definition.maxRunsPerDay)
        throw new WorkspaceError(409, 'This check has exhausted its concurrency or UTC-day allowance')
      const occupied = this.host.store.db.prepare("SELECT count(*) AS n,coalesce(sum(length(value)),0) AS bytes FROM verification_run").get()!
      const active = Number(this.host.store.db.prepare("SELECT count(*) AS n FROM verification_run WHERE json_extract(value,'$.quiescent') IS NOT 1").get()!.n)
      const logs = Number(this.host.store.db.prepare('SELECT coalesce(sum(length(data)),0) AS bytes FROM verification_output').get()!.bytes)
      if (Number(occupied.n) >= 10000 || active >= 8 || Number(occupied.bytes) + logs + (active + 1) * 6 * 1024 * 1024 > 512 * 1024 * 1024)
        throw new WorkspaceError(409, 'Verification journal or active-run capacity reached')
      if (driver.binding.kind === 'local') {
        const local = this.host.store.db.prepare("SELECT value FROM verification_run WHERE json_extract(value,'$.backend.kind')='local'").all()
          .map(row => JSON.parse(String(row.value)) as StoredCheckRun)
        const reserved = local.filter(item => !item.quiescent || evidenceOf(item) && !evidenceOf(item)?.storageReleased)
          .reduce((sum, item) => sum + snapshotReservation(item.check.definition.snapshot), 0)
        if (reserved + snapshotReservation(check.definition.snapshot) > 2 * 1024 * 1024 * 1024) throw new WorkspaceError(409, 'Local snapshot reservations exceed 2 GiB')
      }
      const owner = { kind: 'assignment' as const, ticketId: base.artifact.ticketId, assignmentId: execution.assignmentId, sessionId: execution.sessionId,
        callId: request.requestId, tool: 'artifact_verification' }
      const rpc = Rpc.parse({ op: 'job.spawn', requestId: request.requestId, owner, revision: driver.binding.revision, cwd: driver.binding.source,
        argv: check.definition.argv, env: check.definition.env, stdin: check.definition.stdin, graceMs: 1000,
        verification: { kind: sourceCheckId ? 'capture' : 'check', snapshot: check.definition.snapshot, timeoutSeconds: check.definition.timeoutSeconds,
          artifact: { path: check.definition.artifactPath, hash: artifact.hash }, expectedSnapshot: request.expectedSnapshot, expectedRepository: request.expectedRepository } }) as RemoteJob['request']
      const value: StoredCheckRun = { ...base, owner, createdAt: at, updatedAt: at, status: 'pending', quiescent: false, purpose: sourceCheckId ? 'freshness' : 'check', sourceCheckId,
        backend: driver.binding, fingerprint: hash, request: rpc, requestHash: fingerprint({ principal: { role: 'grant', id: driver.binding.grantId, epoch: driver.binding.epoch }, request: rpc }) }
      this.save(value); return value
    })
    if (run) this.dispatch(run, driver)
    return this.get(request.requestId, actor)
  }
  private dispatch(run: StoredCheckRun, driver: Driver): void {
    if (this.pending.has(run.id)) return
    const operation = (async () => {
      try {
        this.authorize(run)
        if (driver.world) {
          const value = await driver.world.withOwner(run.owner, () => this.authorize(this.require(run.id)),
            () => driver.world!.executionClient().intent(run.request, this.stopped.signal))
          this.observe(run.id, value)
        } else await this.executeLocal(run, driver.isolation!)
      } catch (error) {
        const current = this.require(run.id), effect = driver.world?.executionReceipt(run.id)
        // A concurrent original-job observation may already have proved completion while an older spawn reply failed.
        if (current.receipt?.quiescent === true) return
        const notDispatched = driver.world ? !effect || effect.phase === 'refused' : current.status === 'pending'
        current.status = notDispatched ? 'failed' : 'unknown'; current.quiescent = notDispatched || effect?.quiescent === true ? true : null
        current.problem = error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000); this.save(current)
      }
    })().finally(() => this.pending.delete(run.id))
    this.pending.set(run.id, operation); void operation.catch(() => {})
  }
  private completed(run: StoredCheckRun, evidence: CheckEvidence | undefined): boolean {
    if (!evidence?.snapshot || evidence.stage !== 'finished' || !evidence.snapshotUnchanged || !evidence.finishedAt || evidence.problem || run.problem || run.cancel) return false
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
  private observe(id: string, input: unknown): CheckRun {
    const run = this.require(id), job = receiptSchema.parse(input) as RemoteJob
    if (job.id !== run.id || job.grantId !== run.backend.grantId || job.epoch !== run.backend.epoch || job.revision !== run.backend.revision
      || job.fingerprint !== run.requestHash || fingerprint(job.request) !== fingerprint(run.request)) throw new Error('Verification receipt differs from its original request and execution world')
    if (run.receipt?.ownership && fingerprint(job.ownership) !== fingerprint(run.receipt.ownership)) throw new Error('Verification receipt owner changed')
    if (run.quiescent === true && job.quiescent !== true) return view(run)
    run.receipt = job; delete run.evidence; run.quiescent = job.quiescent; run.outcome = job.outcome; run.problem = job.error ?? job.verification?.problem
    run.status = job.phase === 'unknown' ? 'unknown' : job.quiescent !== true ? job.phase === 'accepted' ? 'pending' : 'running'
      : this.completed(run, job.verification) ? run.purpose === 'check' ? 'passed' : 'captured' : 'failed'
    this.save(run); return view(run)
  }
  private append(id: string, stream: 'stdout' | 'stderr', bytes: Buffer): void {
    const row = this.host.store.db.prepare('SELECT data,total FROM verification_output WHERE id=? AND stream=?').get(id, stream)
    const before = row ? Buffer.from(row.data as Uint8Array) : Buffer.alloc(0), data = Buffer.concat([before, bytes.subarray(0, Math.max(0, 1024 * 1024 - before.length))])
    this.host.store.db.prepare('INSERT INTO verification_output VALUES (?,?,?,?) ON CONFLICT(id,stream) DO UPDATE SET data=excluded.data,total=excluded.total')
      .run(id, stream, data, Number(row?.total ?? 0) + bytes.length)
  }
  private async executeLocal(run: StoredCheckRun, isolation: ExecutionIsolation): Promise<void> {
    const cancellation = new AbortController(); this.localCancellation.set(run.id, cancellation)
    try {
      const result = await runCapturedCheck({ id: run.id, source: run.backend.source, root: run.backend.source, argv: run.request.argv,
        env: run.request.env, stdin: run.request.stdin, spec: run.request.verification! }, {
        subprocess: this.host.subprocess, isolation, helper: snapshotHelperPath(), storageRoot: join(this.host.stateDir, 'verification-snapshots'), lifetime: this.host.lifetime,
        signal: AbortSignal.any([cancellation.signal, this.stopped.signal]), authorize: async () => {
          const current = this.require(run.id); this.authorize(current); if (current.cancel) throw new Error('Verification cancelled')
          if (await realpath(current.execution.directory) !== current.backend.source) throw new Error('Original local source path changed after admission')
        }, checkpoint: evidence => { const current = this.require(run.id); current.status = 'running'; current.evidence = evidence; this.save(current) },
        live: handle => { if (handle) this.localHandles.set(run.id, handle); else this.localHandles.delete(run.id) }, output: (stream, bytes) => this.append(run.id, stream, bytes),
      })
      const current = this.require(run.id); current.evidence = result.evidence; current.outcome = result.outcome; current.quiescent = result.quiescent; current.problem = result.problem
      current.status = !result.quiescent ? 'unknown' : this.completed(current, result.evidence) ? current.purpose === 'check' ? 'passed' : 'captured' : 'failed'; this.save(current)
    } finally { this.localCancellation.delete(run.id) }
  }
  async refresh(id: string, actor: Actor = operator): Promise<CheckRun> {
    const run = this.require(id, actor)
    if (run.backend.kind === 'local') return view(run)
    // A definitive pre-dispatch refusal has no endpoint command to observe; preserve its actual admission error.
    if (run.status === 'failed' && run.quiescent === true && !run.receipt) return view(run)
    try {
      const world = this.host.remote(run.execution)
      if (!world || world.status().binding !== run.backend.binding) throw new Error('Original execution world is unavailable; no replacement is selected')
      return this.observe(id, await world.executionClient().call({ op: 'job.get', id }, this.stopped.signal))
    } catch (error) {
      const current = this.require(id, actor); current.problem = error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000)
      if (!current.quiescent) current.status = 'unknown'; this.save(current); return view(current)
    }
  }
  async cancel(id: string, input: unknown, actor: Actor = operator): Promise<CheckRun> {
    const request = CancelCheck.parse(input), run = this.host.store.atomic(() => {
      this.host.authorize(); const run = this.require(id, actor)
      this.rememberControl(request.requestId, { operation: 'cancel', id, actor, request })
      if (run.cancel && fingerprint({ requestId: run.cancel.requestId, reason: run.cancel.reason }) !== fingerprint(request)) throw new WorkspaceError(409, 'Retry the original cancellation request')
      if (!run.quiescent) { run.cancel ??= { ...request, at: timestamp() }; this.save(run) }
      return run
    })
    if (run.quiescent) return view(run)
    if (run.backend.kind === 'local') {
      this.localCancellation.get(id)?.abort(new Error(request.reason)); this.localHandles.get(id)?.terminate()
      if (!this.pending.has(id)) await this.settleLocalRange(id)
      return this.get(id, actor)
    }
    try {
      const world = this.host.remote(run.execution)
      if (!world || world.status().binding !== run.backend.binding) throw new Error('Original execution world is unavailable')
      this.observe(id, await world.executionClient().intent({ op: 'job.cancel', id, requestId: request.requestId }, this.stopped.signal))
    } catch (error) { const current = this.require(id, actor); current.problem = String(error).slice(0, 4000); this.save(current) }
    return this.get(id, actor)
  }
  async reconcile(id: string, input: unknown): Promise<CheckRun> {
    this.host.authorize(); const request = ReconcileCheck.parse(input); let run = this.require(id)
    if (run.backend.kind !== 'local') throw new WorkspaceError(409, 'Reconcile remote execution at its original endpoint, then refresh this receipt')
    if (run.reconciliation) {
      if (run.reconciliation.requestId !== request.requestId || run.reconciliation.reason !== request.reason) throw new WorkspaceError(409, 'Reconciliation request differs')
      return view(run)
    }
    if (run.status !== 'unknown' || this.pending.has(id)) throw new WorkspaceError(409, 'Only an unknown stopped local run can be reconciled')
    const handle = this.localHandles.get(id)
    if (handle && !await handle.waitForExit(AbortSignal.timeout(1000)).catch(() => false)) throw new WorkspaceError(409, 'The original local process range is still active')
    this.localHandles.delete(id)
    run = this.host.store.atomic(() => {
      this.host.authorize(); const current = this.require(id)
      if (current.status !== 'unknown' || this.pending.has(id)) throw new WorkspaceError(409, 'Local execution changed during reconciliation')
      if (current.reconciliation && (current.reconciliation.requestId !== request.requestId || current.reconciliation.reason !== request.reason))
        throw new WorkspaceError(409, 'Reconciliation request differs')
      this.rememberControl(request.requestId, { operation: 'reconcile', id, request })
      current.reconciliation ??= { requestId: request.requestId, reason: request.reason, at: timestamp() }; current.quiescent = true
      this.save(current); return current
    })
    await this.cleanLocal(run); return this.get(id)
  }
  private async cleanLocal(run: StoredCheckRun): Promise<void> {
    if (run.backend.kind !== 'local' || !run.quiescent || !run.evidence || run.evidence.storageReleased || this.pending.has(run.id)) return
    try {
      await discardSnapshot(join(this.host.stateDir, 'verification-snapshots', run.id))
      const current = this.require(run.id); current.evidence!.storageReleased = true; this.save(current)
    } catch { /* A failed cleanup retains its reservation. */ }
  }
  async output(id: string, input: unknown, actor: Actor = operator): Promise<OutputWindow> {
    const run = this.require(id, actor), query = CheckOutputQuery.parse(input)
    if (run.backend.kind === 'remote') {
      const world = this.host.remote(run.execution)
      if (!world || world.status().binding !== run.backend.binding) throw new WorkspaceError(409, 'Original execution world is unavailable')
      const window = z.object({ offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative(), data: z.string().max(87384),
        gap: z.boolean(), totalBytes: z.number().int().nonnegative(), retainedBytes: z.number().int().nonnegative() }).strict()
        .parse(await world.executionClient().call({ op: 'job.output', id, ...query }, this.stopped.signal))
      const bytes = Buffer.from(window.data, 'base64')
      if (bytes.toString('base64') !== window.data || bytes.length > query.limit || window.offset !== query.offset || window.nextOffset < window.offset
        || window.nextOffset > window.totalBytes || window.retainedBytes > window.totalBytes
        || (!window.gap && window.nextOffset !== window.offset + bytes.length) || window.gap && bytes.length !== 0)
        throw new WorkspaceError(409, 'Invalid output window from the original verification endpoint')
      return window
    }
    const row = this.host.store.db.prepare('SELECT data,total FROM verification_output WHERE id=? AND stream=?').get(id, query.stream)
    const bytes = row ? Buffer.from(row.data as Uint8Array) : Buffer.alloc(0), totalBytes = Number(row?.total ?? 0)
    if (query.offset > totalBytes) throw new WorkspaceError(409, 'Output cursor is ahead of the recorded stream')
    const data = bytes.subarray(query.offset, query.offset + query.limit), gap = query.offset >= bytes.length && totalBytes > query.offset
    return { offset: query.offset, nextOffset: gap ? totalBytes : query.offset + data.length, gap, data: data.toString('base64'), totalBytes, retainedBytes: bytes.length }
  }
  async freshness(id: string, requestId: string, actor: Actor = operator): Promise<CheckRun> {
    const run = this.require(id, actor), evidence = evidenceOf(run)
    if (run.status !== 'passed' || run.purpose !== 'check' || !evidence?.snapshot || !this.completed(run, evidence)) throw new WorkspaceError(409, 'Select a passed host check before revalidating its source')
    return this.request(run.artifact.id, { requestId, check: { id: run.check.id, version: run.check.version }, artifactRevision: run.artifact.revision,
      artifactHash: run.artifact.hash, expectedSnapshot: evidence.snapshot.hash }, actor, run.id)
  }
  start(): void {
    if (this.timer || this.stopped.signal.aborted) return
    this.timer = setInterval(() => { void this.tick() }, 1000); this.timer.unref(); void this.tick()
  }
  private tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = (async () => {
      const runs = this.host.store.db.prepare(`SELECT value FROM verification_run WHERE json_extract(value,'$.quiescent') IS NOT 1
        OR (json_extract(value,'$.backend.kind')='local' AND json_type(value,'$.evidence')='object' AND json_extract(value,'$.evidence.storageReleased') IS NOT 1)
        ORDER BY rowid LIMIT 16 OFFSET ?`).all(this.maintenanceOffset).map(row => JSON.parse(String(row.value)) as StoredCheckRun)
      this.maintenanceOffset = runs.length === 16 ? this.maintenanceOffset + 16 : 0
      for (const run of runs) {
        if (this.stopped.signal.aborted) break
        if (run.backend.kind === 'remote') await this.refresh(run.id)
        if (!run.quiescent && !run.cancel) {
          try { this.authorize(run) }
          catch (error) { try { await this.cancel(run.id, { requestId: `cancel-${fingerprint(run.id).slice(0, 32)}`, reason: String(error).slice(0, 2000) }) } catch {} }
        }
        await this.cleanLocal(run)
      }
    })().catch(() => {}).finally(() => { this.ticking = undefined })
    return this.ticking
  }
  stop(): Promise<void> { return this.closing ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.stopped.abort(); for (const abort of this.localCancellation.values()) abort.abort()
    for (const handle of this.localHandles.values()) { try { handle.terminate() } catch { /* Retain the handle until independent exit confirmation. */ } }
    const remote = this.host.store.db.prepare("SELECT value FROM verification_run WHERE json_extract(value,'$.backend.kind')='remote' AND json_extract(value,'$.quiescent') IS NOT 1")
      .all().map(row => JSON.parse(String(row.value)) as StoredCheckRun)
    const cancellations = remote.map(async run => {
      const world = this.host.remote(run.execution)
      if (!world || world.status().binding !== run.backend.binding) return
      run.cancel ??= { requestId: `shutdown-${fingerprint(run.id).slice(0, 32)}`, reason: 'Coordinator shutdown requested cancellation', at: timestamp() }
      this.save(run)
      try { this.observe(run.id, await world.executionClient().intent({ op: 'job.cancel', id: run.id, requestId: run.cancel.requestId }, AbortSignal.timeout(3000))) }
      catch { /* The original cancellation intent and unknown execution remain available after restart. */ }
    })
    await this.ticking; await Promise.allSettled([...this.pending.values()])
    await Promise.allSettled(cancellations)
    await Promise.allSettled([...this.localHandles.keys()].map(id => this.settleLocalRange(id))); this.closed = true
  }
  private rememberControl(id: string, input: unknown): void {
    const hash = fingerprint(input), row = this.host.store.db.prepare('SELECT fingerprint FROM verification_control WHERE id=?').get(id)
    if (row && row.fingerprint !== hash) throw new WorkspaceError(409, 'Verification control request ID belongs to another operation')
    if (!row) {
      const size = this.host.store.db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(request AS BLOB))),0) AS bytes FROM verification_control').get()!
      if (Number(size.n) >= 20000 || Number(size.bytes) + Buffer.byteLength(JSON.stringify(input)) > 64 * 1024 * 1024)
        throw new WorkspaceError(409, 'Verification control receipt capacity reached')
      this.host.store.db.prepare('INSERT INTO verification_control VALUES (?,?,?)').run(id, hash, JSON.stringify(input))
    }
  }
  private async settleLocalRange(id: string): Promise<void> {
    const handle = this.localHandles.get(id)
    if (!handle || !await handle.waitForExit(AbortSignal.timeout(5000)).catch(() => false)) return
    this.localHandles.delete(id)
    const run = this.require(id); run.quiescent = true; run.status = 'unknown'; run.problem = 'Original local process range stopped; check outcome remains unknown'
    this.save(run); await this.cleanLocal(run)
  }
}
