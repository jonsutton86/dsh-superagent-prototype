import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { canStop, key, type Engine, type Execution, type Mandate, type Policy, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { verifyLocalWorkspace } from '../infra/environment.ts'
import type { RemoteWorkspace } from './remote-workspace.ts'
import type { WorldPool } from './pool.ts'
import type { OwnershipAccess } from '../ownership/protocol.ts'
import { ownershipReady } from '../ownership/runtime.ts'
import { EnrollEnvironment, EnvironmentCommand, EnvironmentError, type EnvironmentList, type EnvironmentRecord,
  type EnvironmentView, type ExecutionGrant, type DefaultEnvironmentSelection, type EnvironmentDescription } from './model.ts'

export interface EnvironmentHost {
  store: Store; filesystem: FileSystem; subprocess: SubprocessRuntime; lifetime: AbortSignal
  root(): string; mode(): 'local' | 'repository'; engine(): Pick<Engine, 'stopTicket'>
  remote?: RemoteWorkspace
  ownership?: OwnershipAccess
  worlds?(): WorldPool
  authorizeRoot?(root: string): void
}
const stamp = () => new Date().toISOString()
const marker = (record: Pick<EnvironmentRecord, 'root' | 'id'>) => join(record.root, `.dsh-environment-${record.id}`)

/** Persistent local execution grants, paired-provider proof and fail-closed ticket bindings. */
export class Environments {
  private readonly checked = new Map<string, { verifiedAt?: string; problem?: string }>()
  private enrolling: Promise<unknown> = Promise.resolve()
  constructor(private readonly host: EnvironmentHost) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS execution_environment (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_environment_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, environment TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_environment_event (id INTEGER PRIMARY KEY, environment TEXT NOT NULL, value TEXT NOT NULL);`)
  }
  private records(): EnvironmentRecord[] {
    return this.host.store.db.prepare('SELECT value FROM execution_environment ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as EnvironmentRecord)
  }
  private require(id: string): EnvironmentRecord {
    const row = this.host.store.db.prepare('SELECT value FROM execution_environment WHERE id=?').get(id)
    if (!row) throw new EnvironmentError(404, 'Execution environment not found')
    return JSON.parse(String(row.value)) as EnvironmentRecord
  }
  private current(record: EnvironmentRecord): boolean {
    return !record.retired && record.configuredRoot === resolve(this.host.root()) && record.mode === this.host.mode() && this.matchesWorld(record)
  }
  private matchesWorld(record: EnvironmentRecord): boolean {
    return record.kind === 'remote' ? !!record.remote && record.remote.binding === this.host.remote?.world.status().binding : !this.host.remote
  }
  private save(record: EnvironmentRecord, reason: string): void {
    const { store } = this.host
    store.db.prepare('INSERT INTO execution_environment VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record))
    store.db.prepare('INSERT INTO execution_environment_event(environment,value) VALUES (?,?)')
      .run(record.id, JSON.stringify({ at: record.updatedAt, enabled: record.enabled, revision: record.revision, epoch: record.epoch, reason }))
  }
  private stop(record: EnvironmentRecord, reason: string): void {
    for (const ticket of this.host.store.tickets.list()) {
      if (this.belongs(record, ticket) && canStop(ticket)) this.host.engine().stopTicket(ticket.id, reason)
    }
  }
  private belongs(record: EnvironmentRecord, ticket: Ticket): boolean {
    const execution = ticket.execution
    return execution?.environment ? execution.environment.environmentId === record.id
      : record.kind === 'local' && !!execution && resolve(dirname(execution.directory)) === record.configuredRoot && (execution.mode ?? 'repository') === record.mode
  }
  private view(record: EnvironmentRecord): EnvironmentView {
    const { identity, ...value } = record
    const status = record.kind === 'remote' && this.matchesWorld(record) ? this.host.remote!.world.status() : undefined
    return { ...value, current: this.current(record), ...this.checked.get(record.id),
      ...(status ? { remoteStatus: { ready: status.ready, phase: status.phase, problem: status.problem,
        acknowledged: status.revocation?.acknowledged, quiescent: status.revocation?.quiescent } } : {}),
      openTickets: this.host.store.tickets.list().filter(ticket => this.belongs(record, ticket) && canStop(ticket)).length,
      capabilities: { filesystem: true, subprocess: true, osIsolation: record.kind === 'remote', remote: record.kind === 'remote' } }
  }
  list(): EnvironmentList {
    const items = this.records().map(record => this.view(record))
    return { items, currentRoot: resolve(this.host.root()), currentMode: this.host.mode(), currentKind: this.host.remote ? 'remote' : 'local', needsEnrollment: !items.some(record => record.current) }
  }
  ready(): boolean {
    if (this.host.lifetime.aborted || !ownershipReady(this.host.ownership)) return false
    if (this.host.worlds?.().ready()) return true
    if (this.host.ownership && !this.host.remote) return false
    if (this.host.remote && !this.host.remote.world.status().ready) return false
    return this.records().some(record => this.current(record) && record.enabled && this.checked.get(record.id)?.verifiedAt && !this.checked.get(record.id)?.problem)
  }
  private defaultRecord(): EnvironmentRecord {
    if (this.host.lifetime.aborted || !ownershipReady(this.host.ownership)) throw new EnvironmentError(409, 'Coordinator ownership is unavailable')
    if (this.host.ownership && !this.host.remote) throw new EnvironmentError(409, 'Select an enrolled endpoint world for ownership-controlled execution')
    const record = this.records().find(record => this.current(record))
    if (!record?.enabled || !this.checked.get(record.id)?.verifiedAt || this.checked.get(record.id)?.problem
      || this.host.remote && !this.host.remote.world.status().ready)
      throw new EnvironmentError(409, 'Enroll and enable the configured execution environment before starting work.')
    this.host.authorizeRoot?.(record.root)
    return record
  }
  /** A read-only selection; dispatch compares this grant again in the inbox transaction. */
  defaultSelection(): DefaultEnvironmentSelection {
    try {
      const record = this.defaultRecord()
      return { available: true, name: record.name, root: record.root, mode: record.mode, kind: record.kind,
        grant: { environmentId: record.id, revision: record.revision, epoch: record.epoch, ...(record.remote ? { world: record.remote.binding } : {}) } }
    } catch (error) { return { available: false, problem: error instanceof EnvironmentError ? error.message : 'Default execution environment is unavailable' } }
  }
  /** Catalog labels are descriptive only; the ticket retains its original grant and directory. */
  describe(grant: ExecutionGrant): EnvironmentDescription | undefined {
    if (grant.world && grant.environmentId === grant.world) {
      try { const world = this.host.worlds?.().get(grant.world); return world && { name: world.name, root: world.root, mode: 'local', kind: 'remote' } }
      catch { return undefined }
    }
    const record = this.records().find(record => record.id === grant.environmentId)
    return record && { name: record.name, root: record.root, mode: record.mode, kind: record.kind }
  }
  private receipt(id: string, fingerprint: string): EnvironmentView | undefined {
    const row = this.host.store.db.prepare('SELECT fingerprint,environment FROM execution_environment_command WHERE id=?').get(id)
    if (!row) return
    if (row.fingerprint !== fingerprint) throw new EnvironmentError(409, 'This request ID was already used for another operation')
    return this.view(this.require(String(row.environment)))
  }
  private remember(id: string, fingerprint: string, environment: string): void {
    this.host.store.db.prepare('INSERT INTO execution_environment_command VALUES (?,?,?)').run(id, fingerprint, environment)
  }
  /** The configured local profile already authorizes its first environment; subsequent new roots require explicit enrollment. */
  async initialize(): Promise<void> {
    if (this.host.ownership && !this.host.remote) return
    if (!this.records().length) { await this.enroll({ requestId: 'initial-profile-enrollment', name: this.host.remote ? 'Remote execution' : 'Local execution', root: this.host.root(), mode: this.host.mode() }); return }
    const record = this.records().find(record => this.current(record))
    if (record?.kind === 'remote' && !record.enabled) { await this.stopRemote(record); return }
    if (record) await this.probe(record).catch(() => { /* The operator view retains the failed proof; admission stays closed. */ })
  }
  enroll(input: unknown): Promise<EnvironmentView> {
    if (this.host.ownership && !this.host.remote) return Promise.reject(new EnvironmentError(409, 'Ownership-controlled execution requires an enrolled endpoint world'))
    const request = EnrollEnvironment.parse(input), configuredRoot = resolve(this.host.root()), mode = this.host.mode()
    if (resolve(request.root) !== configuredRoot || request.mode !== mode)
      return Promise.reject(new EnvironmentError(409, 'The execution profile changed. Refresh before enrolling.'))
    const fingerprint = key(JSON.stringify({ operation: 'enroll', configuredRoot, ...request }))
    const run = async () => {
      const replay = this.receipt(request.requestId, fingerprint)
      if (replay) return replay
      if (configuredRoot !== resolve(this.host.root()) || mode !== this.host.mode()) throw new EnvironmentError(409, 'The execution profile changed. Refresh before enrolling.')
      const existing = this.records().find(record => !record.retired && record.configuredRoot === configuredRoot && record.mode === mode && this.matchesWorld(record))
      if (request.replaceId && (existing?.id !== request.replaceId || existing.revision !== request.revision))
        throw new EnvironmentError(409, 'The enrollment changed. Refresh before replacing it.')
      if (existing && !request.replaceId) {
        await this.probe(existing)
        this.host.store.atomic(() => {
          if (configuredRoot !== resolve(this.host.root()) || mode !== this.host.mode())
            throw new EnvironmentError(409, 'The execution profile changed during verification. Refresh before enrolling.')
          this.remember(request.requestId, fingerprint, existing.id)
        })
        return this.view(this.require(existing.id))
      }
      const remote = this.host.remote
      if (remote && configuredRoot !== remote.world.grant.root) throw new EnvironmentError(409, 'The execution root must equal the configured remote grant root')
      if (!remote) await mkdir(configuredRoot, { recursive: true, mode: 0o700 })
      const root = remote ? await remote.canonical(configuredRoot) : await realpath(configuredRoot)
      this.host.authorizeRoot?.(root)
      if (remote) await remote.verify(root)
      else await verifyLocalWorkspace(root, this.host.subprocess, this.host.lifetime, this.host.filesystem)
      const status = remote?.world.status()
      const at = stamp(), record: EnvironmentRecord = { id: randomUUID(), name: request.name, kind: remote ? 'remote' : 'local', root, configuredRoot,
        mode, identity: randomUUID(), revision: 1, epoch: 1, enabled: true, createdAt: at, updatedAt: at }
      if (status) { record.identity = status.binding; record.remote = { binding: status.binding, endpointId: status.endpointId, grantId: status.grantId, epoch: status.epoch,
        ...(remote!.world.grant.credentials?.length ? { credentials: remote!.world.grant.credentials } : {}) } }
      else await writeFile(marker(record), record.identity, { flag: 'wx', mode: 0o600 })
      try {
        await this.probe(record)
        this.host.store.atomic(() => {
          if (configuredRoot !== resolve(this.host.root()) || mode !== this.host.mode())
            throw new EnvironmentError(409, 'The execution profile changed during verification. Refresh before enrolling.')
          if (existing) {
            const previous = this.require(existing.id)
            if (previous.revision !== request.revision || previous.retired) throw new EnvironmentError(409, 'The enrollment changed during verification.')
            previous.enabled = false; previous.retired = true; previous.revision++; previous.epoch++; previous.updatedAt = stamp()
            this.save(previous, 'Replaced execution environment enrollment'); this.stop(previous, 'Execution environment enrollment replaced by operator')
          }
          this.save(record, 'Enrolled configured execution environment'); this.remember(request.requestId, fingerprint, record.id)
        })
      } catch (error) { this.checked.delete(record.id); if (!remote) await unlink(marker(record)).catch(() => {}); throw error }
      this.checked.set(record.id, { verifiedAt: stamp() })
      return this.view(record)
    }
    const operation = this.enrolling.then(run, run)
    this.enrolling = operation.catch(() => {})
    return operation
  }
  private async probe(record: EnvironmentRecord): Promise<void> {
    try {
      this.host.authorizeRoot?.(record.root)
      if (!this.matchesWorld(record)) throw new Error('This enrollment belongs to another execution world')
      if (record.kind === 'remote') {
        if (record.identity !== this.host.remote!.world.status().binding || record.root !== this.host.remote!.world.grant.root)
          throw new Error('The enrolled remote authority changed')
        await this.host.remote!.verify(record.root)
        this.checked.set(record.id, { verifiedAt: stamp() }); return
      }
      if (await realpath(record.configuredRoot) !== record.root) throw new Error('The enrolled directory now resolves to another location')
      if (await readFile(marker(record), 'utf8') !== record.identity) throw new Error('Execution environment identity no longer matches its enrollment')
      await verifyLocalWorkspace(record.root, this.host.subprocess, this.host.lifetime, this.host.filesystem)
      this.checked.set(record.id, { verifiedAt: stamp() })
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error)
      this.checked.set(record.id, { problem })
      throw new EnvironmentError(409, problem)
    }
  }
  allows(grant: ExecutionGrant | undefined): boolean {
    if (this.host.lifetime.aborted || !ownershipReady(this.host.ownership)) return false
    try { this.host.authorizeRoot?.(this.host.root()) } catch { return false }
    if (grant?.world && grant.environmentId === grant.world) {
      try { const record = this.host.worlds?.().get(grant.world)
        return !!record?.ready && record.revision === grant.revision && record.epoch === grant.epoch && this.host.mode() === 'local'
      } catch { return false }
    }
    if (this.host.ownership && !this.host.remote) return false
    if (!grant) return !this.host.remote // Legacy local work must never be adopted by a remote profile.
    const record = this.records().find(record => record.id === grant.environmentId)
    try { if (record) this.host.authorizeRoot?.(record.root) } catch { return false }
    return !!record?.enabled && !record.retired && record.revision === grant.revision && record.epoch === grant.epoch && record.mode === this.host.mode()
      && !this.checked.get(record.id)?.problem
      && this.matchesWorld(record) && (record.kind !== 'remote' || grant.world === record.remote?.binding && !!this.host.remote?.world.status().ready)
  }
  policy(base: Policy): Policy {
    return { ...base, revalidate: (mandate: Mandate) => this.allows(mandate.environment) && base.revalidate(mandate) }
  }
  select(binding: string): RemoteWorkspace {
    if (this.host.mode() !== 'local') throw new EnvironmentError(409, 'Managed worlds require the personal/local execution profile')
    const world = this.host.worlds?.().require(binding)
    if (!world) throw new EnvironmentError(409, 'Managed execution world is unavailable')
    return world.workspace
  }
  remoteFor(ticket: Ticket): RemoteWorkspace | undefined {
    const grant = ticket.execution?.environment
    if (grant?.world && grant.environmentId === grant.world) {
      const member = this.host.worlds?.().lookup(grant.world)
      if (!member) throw new EnvironmentError(409, 'The assigned execution world is unavailable; it cannot fall back to local execution')
      return member.workspace
    }
    return this.host.remote
  }
  bind(execution: Execution, binding?: string): ExecutionGrant {
    if (this.host.lifetime.aborted || !ownershipReady(this.host.ownership)) throw new EnvironmentError(409, 'Coordinator ownership is unavailable')
    if (binding) {
      const remote = this.select(binding), record = this.host.worlds!().get(binding)
      if (resolve(dirname(execution.directory)) !== remote.world.grant.root) throw new EnvironmentError(409, 'Task directory is outside the selected execution world')
      return { environmentId: binding, revision: record.revision, epoch: record.epoch, world: binding }
    }
    const record = this.defaultRecord()
    if (resolve(dirname(execution.directory)) !== record.configuredRoot)
      throw new EnvironmentError(409, 'The task directory is outside the enrolled execution root.')
    return { environmentId: record.id, revision: record.revision, epoch: record.epoch, ...(record.remote ? { world: record.remote.binding } : {}) }
  }
  /** Legacy grants are recorded on execution without rewriting their immutable historical mandate. */
  pin(ticket: Ticket): Ticket {
    if (!ticket.execution || ticket.execution.environment) return ticket
    if (this.host.remote) throw new EnvironmentError(409, 'Legacy work has no remote authority binding; authorize a new task')
    return this.host.store.atomic(() => {
      const current = this.host.store.tickets.get(ticket.id)!
      if (!current.execution!.environment) { current.execution!.environment = this.bind(current.execution!); this.host.store.tickets.save(current) }
      return current
    })
  }
  async validate(ticket: Ticket): Promise<void> {
    const execution = ticket.execution!, grant = execution.environment
    if (!grant || !this.allows(grant)) throw new EnvironmentError(409, 'The execution grant is unavailable or revoked. Authorize a new run under the current environment.')
    if (grant.environmentId === grant.world) {
      const remote = this.select(grant.world), root = remote.world.grant.root
      await remote.verify(root)
      if (await remote.canonical(dirname(execution.directory)) !== root || basename(execution.directory) !== execution.name)
        throw new EnvironmentError(409, 'The task directory no longer matches its selected execution world')
      if (await remote.exists(execution.directory) && await remote.canonical(execution.directory) !== join(root, execution.name))
        throw new EnvironmentError(409, 'The task directory resolves outside its assigned location')
      if (!this.allows(grant)) throw new EnvironmentError(409, 'The managed execution world was revoked during verification')
      return
    }
    const record = this.require(grant.environmentId)
    await this.probe(record)
    const canonical = (path: string) => record.kind === 'remote' ? this.host.remote!.canonical(path) : realpath(path)
    if (await canonical(dirname(execution.directory)) !== record.root || basename(execution.directory) !== execution.name)
      throw new EnvironmentError(409, 'The task directory no longer matches its enrolled root.')
    const target = await canonical(execution.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (target && target !== join(record.root, execution.name)) throw new EnvironmentError(409, 'The task directory resolves outside its assigned location.')
    // Recheck after I/O: revocation can commit while the proof is in flight.
    if (!this.allows(grant)) throw new EnvironmentError(409, 'The execution grant was revoked during validation.')
  }
  async update(id: string, input: unknown): Promise<EnvironmentView> {
    const request = EnvironmentCommand.parse(input), fingerprint = key(JSON.stringify({ operation: 'grant', id, ...request }))
    const replay = this.receipt(request.requestId, fingerprint)
    if (replay) { if (!replay.enabled) await this.stopRemote(this.require(id)); return this.view(this.require(id)) }
    if (request.enabled) await this.probe(this.require(id))
    this.host.store.atomic(() => {
      const replay = this.receipt(request.requestId, fingerprint)
      if (replay) return replay
      const record = this.require(id)
      if (record.retired) throw new EnvironmentError(409, 'This enrollment was replaced and cannot be re-enabled.')
      if (record.revision !== request.revision) throw new EnvironmentError(409, 'The environment grant changed. Refresh before trying again.')
      if (record.enabled !== request.enabled) { record.revision++; record.epoch++; record.enabled = request.enabled }
      // Commit monotonic denial before the local transaction: even a crash or rollback cannot renew revoked remote authority.
      if (!record.enabled && record.kind === 'remote' && this.matchesWorld(record)) {
        const stop = this.remoteStop(record); this.host.remote!.world.requestRevocation(stop.requestId, stop.reason)
      }
      record.updatedAt = stamp(); this.save(record, request.reason)
      if (!record.enabled) this.stop(record, `Execution environment revoked: ${request.reason}`)
      this.remember(request.requestId, fingerprint, id)
      return this.view(record)
    })
    const record = this.require(id)
    if (!record.enabled) await this.stopRemote(record)
    return this.view(record)
  }
  private remoteStop(record: EnvironmentRecord): { requestId: string; reason: string } {
    return { requestId: key(`environment-revocation:${record.id}:${record.epoch}`), reason: `Execution environment ${record.id} revoked at generation ${record.epoch}` }
  }
  private async stopRemote(record: EnvironmentRecord): Promise<void> {
    if (record.kind !== 'remote' || !this.matchesWorld(record)) return
    const stop = this.remoteStop(record)
    await this.host.remote!.world.revoke(stop.requestId, stop.reason).catch(() => { /* Local denial is durable; remoteStatus exposes pending acknowledgement and uncertainty. */ })
  }
}
