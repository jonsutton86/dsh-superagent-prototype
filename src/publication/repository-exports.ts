import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Store } from '../app/store.ts'
import type { ManagedWorld } from '../environments/pool.ts'
import type { Verification } from '../verification/service.ts'
import type { VerificationReviews } from '../verification/reviews.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { WorkspaceError } from '../workspace/model.ts'
import { RemoteError, type RemoteJob } from '../remote/protocol.ts'
import { PrepareRepositoryExport, RepositoryExportRecord, REPOSITORY_EXPORT_LIMITS as L, type RepositoryExportView } from './repository-export-model.ts'
import { exportDirectory, repositoryExportJob } from './repository-export-job.ts'
import { repositoryChunks } from './repository-chunks.ts'

interface Host { store: Store; verification: Verification; reviews: VerificationReviews; lifetime: AbortSignal;
  member(binding: string): ManagedWorld; authorize(): void; preparationProblem?(ticketId: string, assignmentId: string): string | undefined }
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const view = ({ request: _, fingerprint: __, directory: ___, commandId: ____, ...value }: RepositoryExportRecord): RepositoryExportView => value
const clean = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Streams exact reviewed Git bundles into checkpointed chunks; this service cannot push a branch or create a PR. */
export class RepositoryExports {
  private readonly pending = new Map<string, { controller: AbortController; work: Promise<RepositoryExportView> }>()
  private readonly cancelling = new Set<string>()
  private readonly stopped = new AbortController()
  constructor(private readonly host: Host) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS repository_export (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_export_chunk (id TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(id,offset));`)
    for (const row of host.store.db.prepare("SELECT value FROM repository_export WHERE json_extract(value,'$.phase')='preparing'").all()) {
      const record = RepositoryExportRecord.parse(JSON.parse(String(row.value)))
      record.phase = 'held'; record.problem = 'Preparation was interrupted. Retry observes the original export command and retains stored chunks.'; this.save(record)
    }
  }
  private authorize() { this.host.lifetime.throwIfAborted(); this.stopped.signal.throwIfAborted(); this.host.authorize() }
  private record(id: string): RepositoryExportRecord {
    const row = this.host.store.db.prepare('SELECT value FROM repository_export WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Repository export not found')
    return RepositoryExportRecord.parse(JSON.parse(String(row.value)))
  }
  private save(record: RepositoryExportRecord) {
    record.updatedAt = timestamp(); RepositoryExportRecord.parse(record)
    this.host.store.db.prepare('INSERT INTO repository_export VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record))
  }
  list(artifactId: string) {
    return { items: this.host.store.db.prepare("SELECT value FROM repository_export WHERE json_extract(value,'$.artifactId')=? ORDER BY json_extract(value,'$.phase')='cancelled',rowid DESC LIMIT 128").all(artifactId)
      .map(row => view(RepositoryExportRecord.parse(JSON.parse(String(row.value))))) }
  }
  get(id: string) { return view(this.record(id)) }
  /** Retained authority for a separate publication intent. Fresh dispatch also rechecks its original source. */
  publication(id: string, current = false) {
    const record = this.record(id)
    if (record.phase !== 'ready' || !record.bundle || !record.evidence) throw new WorkspaceError(409, 'Prepare the reviewed repository export first')
    if (current) {
      this.authorize()
      const { member: _, ...selected } = this.selected(record.artifactId, record.request)
      for (const key of ['source', 'world', 'head', 'tree', 'directory', 'ticketId', 'assignmentId'] as const)
        if (fingerprint(selected[key]) !== fingerprint(record[key])) throw new WorkspaceError(409, 'Original repository export binding changed')
    }
    this.verify(record)
    return { exportId: id, fingerprint: record.fingerprint, artifact: { id: record.artifactId, revision: record.request.revision, hash: record.request.hash },
      source: record.source.url, bundle: record.bundle, checks: record.request.checks }
  }
  private selected(artifactId: string, request: PrepareRepositoryExport) {
    const bindings = request.checks.map(check => this.host.verification.approval(check.runId, check))
    const original = this.host.verification.get(request.checks[0]!.runId), repository = bindings[0]!.repository
    if (!repository || !/^[a-f0-9]{40}$/.test(repository.commit) || repository.contentTree !== repository.tree || repository.statusHash !== clean
      || bindings.some(binding => binding.artifact.id !== artifactId || binding.artifact.revision !== request.revision || binding.artifact.hash !== request.hash
        || fingerprint(binding.repository) !== fingerprint(repository) || fingerprint(binding.execution) !== fingerprint(bindings[0]!.execution)))
      throw new WorkspaceError(409, 'Select checks of the same clean, fully captured SHA-1 repository commit and artifact')
    const location = original.execution, world = location.environment?.world
    if (!world || original.backend.binding !== world) throw new WorkspaceError(409, 'Repository export requires the original managed execution world')
    const member = this.host.member(world), source = member.workspace.repository
    if (!source || source.commit.length !== 40 || source.commit === repository.commit) throw new WorkspaceError(409, 'This task needs committed changes after its pinned repository source')
    const problem = this.host.preparationProblem?.(original.artifact.ticketId, location.assignmentId)
    if (problem) throw new WorkspaceError(409, problem)
    return { member, source, world, head: repository.commit, tree: repository.tree, directory: location.directory,
      ticketId: original.artifact.ticketId, assignmentId: location.assignmentId }
  }
  prepare(artifactId: string, input: unknown): Promise<RepositoryExportView> {
    this.authorize(); const request = PrepareRepositoryExport.parse(input)
    request.checks.sort((a, b) => a.runId.localeCompare(b.runId))
    const digest = fingerprint({ artifactId, request }), row = this.host.store.db.prepare('SELECT value FROM repository_export WHERE id=?').get(request.requestId)
    if (row) {
      const original = RepositoryExportRecord.parse(JSON.parse(String(row.value)))
      if (original.fingerprint !== digest) throw new WorkspaceError(409, 'Repository export ID already belongs to another review')
      return this.resume(original)
    }
    const { member: _, ...selected } = this.selected(artifactId, request), at = timestamp()
    const record: RepositoryExportRecord = { id: request.requestId, artifactId, request, fingerprint: digest, ...selected,
      commandId: 'repository-export-' + request.requestId, phase: 'preparing', received: 0, createdAt: at, updatedAt: at }
    this.host.store.atomic(() => {
      const capacity = this.host.store.db.prepare("SELECT count(*) AS history, coalesce(sum(json_extract(value,'$.phase')!='cancelled'),0) AS count, coalesce(sum(CASE WHEN json_extract(value,'$.phase')='cancelled' THEN 0 ELSE coalesce(json_extract(value,'$.bundle.bytes'),?) END),0) AS bytes FROM repository_export").get(L.bytes)!
      if (Number(capacity.history) >= L.history) throw new WorkspaceError(409, 'Repository export receipt history has reached its retention limit')
      if (Number(capacity.count) >= L.count || Number(capacity.bytes) + L.bytes > L.totalBytes) throw new WorkspaceError(409, 'Repository export capacity is full; cancel unused preparations')
      this.save(record)
    })
    return this.resume(record)
  }
  retry(id: string): Promise<RepositoryExportView> { this.authorize(); return this.resume(this.record(id)) }
  private resume(record: RepositoryExportRecord): Promise<RepositoryExportView> {
    if (this.cancelling.has(record.id)) throw new WorkspaceError(409, 'Repository export cancellation is being observed')
    const active = this.pending.get(record.id); if (active) return active.work
    if (record.phase === 'cancelled') return Promise.resolve(view(record))
    if (record.phase === 'ready') { this.verify(record); return Promise.resolve(view(record)) }
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.stopped.signal, this.host.lifetime, AbortSignal.timeout(300000)])
    const work = this.execute(record, signal).finally(() => this.pending.delete(record.id))
    this.pending.set(record.id, { controller, work }); return work
  }
  private async execute(record: RepositoryExportRecord, signal: AbortSignal): Promise<RepositoryExportView> {
    let member: ManagedWorld | undefined
    try {
      this.authorize(); const selected = this.selected(record.artifactId, record.request)
      member = selected.member
      const { member: _, ...binding } = selected
      for (const key of ['source', 'world', 'head', 'tree', 'directory', 'ticketId', 'assignmentId'] as const)
        if (fingerprint(binding[key]) !== fingerprint(record[key])) throw new WorkspaceError(409, 'Original repository export binding changed')
      record.phase = 'preparing'; delete record.problem; this.save(record)
      const bundle = await member.world.withOwner({ kind: 'host', purpose: 'repository-export:' + record.id }, () => this.authorize(),
        () => repositoryExportJob(member!, record, signal))
      if (record.bundle && fingerprint(record.bundle) !== fingerprint(bundle)) throw new Error('Original bundle metadata changed')
      record.bundle = bundle; this.save(record)
      const filesystem = member.filesystem, path = posix.join(exportDirectory(member, record.id), 'repository.bundle')
      const target = await filesystem.resolve(path, { signal })
      if (filesystem.processPath(target) !== path || (await filesystem.stat(target, signal))?.type !== 'file') throw new Error('Export path changed')
      while (record.received < bundle.bytes) {
        this.authorize(); signal.throwIfAborted()
        const size = Math.min(L.chunk, bundle.bytes - record.received), data = Buffer.from(await filesystem.readByteRange(target, { offset: record.received, length: size }, signal))
        if (data.length !== size) throw new Error('Export ended before its recorded length')
        this.host.store.atomic(() => {
          const saved = this.record(record.id); if (saved.phase !== 'preparing' || saved.received !== record.received) throw new Error('Export was cancelled or changed')
          this.host.store.db.prepare('INSERT INTO repository_export_chunk VALUES (?,?,?,?)').run(record.id, record.received, data, sha256(data))
          record.received += data.length; this.save(record)
        })
      }
      this.verify(record)
      // Fresh capture checks the original committed source again after transfer; the bytes are then immutable in Store.
      const evidence = await this.host.reviews.prepare({ id: record.id, purpose: 'publication', target: record.fingerprint, checks: record.request.checks })
      this.authorize(); signal.throwIfAborted(); this.selected(record.artifactId, record.request)
      this.host.reviews.assert(evidence, record.request.checks)
      if (this.record(record.id).phase !== 'preparing') throw new Error('Repository export was cancelled')
      record.evidence = evidence; record.phase = 'ready'; delete record.problem; this.save(record)
    } catch {
      if (signal.aborted && member) await member.world.executionClient().intent({ op: 'job.cancel', id: record.commandId,
        requestId: 'cancel-' + record.commandId }, AbortSignal.timeout(2000)).catch(() => {})
      record = this.record(record.id)
      if (record.phase !== 'cancelled') { record.phase = 'held'; record.problem = 'Repository export is held. Inspect the original command, source checks and execution authority before retrying.'; this.save(record) }
    }
    return view(record)
  }
  private *chunks(record: RepositoryExportRecord): Generator<Buffer> {
    const bundle = record.bundle; if (!bundle || record.received !== bundle.bytes) throw new WorkspaceError(409, 'Repository bundle is incomplete')
    yield* repositoryChunks(this.host.store.db, 'repository_export_chunk', record.id, bundle, kind => {
      throw new WorkspaceError(409, kind === 'digest' ? 'Repository export digest differs from its original receipt' : 'Repository export chunks differ from their original receipts')
    })
  }
  private verify(record: RepositoryExportRecord) { for (const _ of this.chunks(record)) { /* bounded ordered verification */ } }
  download(id: string) {
    const record = this.record(id)
    if (record.phase !== 'ready') throw new WorkspaceError(409, 'Repository export is not ready')
    this.verify(record); return { value: view(record), chunks: this.chunks(record) }
  }
  async cancel(id: string) {
    this.authorize()
    this.assertUnreferenced(id)
    if (this.cancelling.has(id)) throw new WorkspaceError(409, 'Repository export cancellation is being observed')
    this.cancelling.add(id)
    try { return await this.cancelOriginal(id) } finally { this.cancelling.delete(id) }
  }
  private assertUnreferenced(id: string) {
    if (this.host.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_repository_publication'").get()
      && this.host.store.db.prepare("SELECT 1 FROM workspace_repository_publication WHERE json_extract(value,'$.exportId')=? LIMIT 1").get(id))
      throw new WorkspaceError(409, 'This export is retained by a repository publication; inspect its original receipt')
  }
  private async cancelOriginal(id: string) {
    const active = this.pending.get(id)
    active?.controller.abort(new Error('Repository export cancelled')); await active?.work
    const record = this.record(id)
    // A held receipt can outlive the coordinator that dispatched its job. Cancellation must still target that original ID.
    if (record.phase !== 'ready' && record.phase !== 'cancelled') {
      const member = this.host.member(record.world)
      try {
        const job = await member.world.executionClient().intent<RemoteJob>({ op: 'job.cancel', id: record.commandId, requestId: 'cancel-' + record.commandId }, AbortSignal.timeout(5000))
        if (job.id !== record.commandId || !job.quiescent) throw new WorkspaceError(409, 'Original export command has not stopped; reconcile its receipt before cancellation')
      } catch (error) { if (!(error instanceof RemoteError) || error.code !== 'not_found') throw error }
    }
    this.authorize()
    this.host.store.atomic(() => {
      this.assertUnreferenced(id)
      record.phase = 'cancelled'; delete record.evidence; delete record.problem; this.save(record)
      this.host.store.db.prepare('DELETE FROM repository_export_chunk WHERE id=?').run(id)
    })
    return this.get(id)
  }
  async stop() { this.stopped.abort(); await Promise.allSettled([...this.pending.values()].map(item => item.work)) }
}
