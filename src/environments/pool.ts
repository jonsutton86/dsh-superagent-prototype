import { Context, Service } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Store } from '../app/store.ts'
import { RemoteWorld } from '../remote/world.ts'
import { worldBinding } from '../remote/world-journal.ts'
import { RemoteFileSystem } from '../remote/filesystem.ts'
import { RemoteSubprocess } from '../remote/subprocess.ts'
import { RemotePresets } from '../remote/presets.ts'
import { fingerprint } from '../remote/journal.ts'
import type { Endpoints, EndpointWorld } from './endpoints.ts'
import { privateCredential } from './endpoint-files.ts'
import { RemoteWorkspace } from './remote-workspace.ts'
import { EnvironmentError } from './model.ts'
import { ActivateWorld, RevokeWorld, type WorldList, type WorldView } from './pool-model.ts'
import { EndpointPage } from './endpoint-model.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { OwnershipAccess } from '../ownership/protocol.ts'
import type { CoordinatorOwnershipConfig } from '../ownership/lease.ts'
import { assertOwnershipCredential } from '../ownership/runtime.ts'

interface WorldRecord extends Omit<WorldView, 'ready' | 'problem' | 'status'>, EndpointWorld {
  revoke?: { requestId: string; reason: string }
}
export interface ManagedWorld {
  world: RemoteWorld; filesystem: FileSystem; subprocess: SubprocessRuntime; workspace: RemoteWorkspace; presets: RemotePresets
}
interface Entry extends ManagedWorld { context: Context; prepared: boolean }
interface PoolHost { store: Store; endpoints: Pick<Endpoints, 'world'>; lifetime: AbortSignal; ownership?: OwnershipAccess;
  restoreWorld?(binding: string, config: EndpointWorld['config']): EndpointWorld['config'];
  ownershipConfig?: CoordinatorOwnershipConfig; controlFiles?: string[]; report(error: unknown): void; revoked?(id: string): void }
declare module '@deepseek-ai/cordis' { interface Context { superagentWorlds: WorldPool } }
const stamp = () => new Date().toISOString()

/** Owns independently leased, persisted execution worlds; one failed or revoked member cannot redirect another member's services. */
export class WorldPool extends Service {
  private readonly opened = new Map<string, Entry>()
  private readonly problems = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  constructor(ctx: Context, private readonly host: PoolHost) {
    super(ctx, 'superagentWorlds')
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS managed_world (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_world_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, world TEXT NOT NULL);`)
  }
  private record(id: string): WorldRecord {
    const row = this.host.store.db.prepare('SELECT value FROM managed_world WHERE id=?').get(id)
    if (!row) throw new EnvironmentError(404, 'Managed execution world not found')
    return JSON.parse(String(row.value)) as WorldRecord
  }
  private records(): WorldRecord[] {
    return this.host.store.db.prepare('SELECT value FROM managed_world ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as WorldRecord)
  }
  private view(record: WorldRecord): WorldView {
    const { config: _, grant: __, credentialPin: ___, revoke: ____, ...value } = record
    const entry = this.opened.get(record.id), status = entry?.world.status(), problem = this.problems.get(record.id) ?? status?.problem
    return { ...value, ready: !this.stopped && record.enabled && !!entry?.prepared && !!status?.ready && !problem, ...(status ? { status } : {}), ...(problem ? { problem } : {}) }
  }
  get(id: string): WorldView { return this.view(this.record(id)) }
  lookup(id: string): ManagedWorld | undefined { return this.opened.get(id) }
  ready(): boolean { return this.records().some(record => this.view(record).ready) }
  /** Verify Harness's actual isolated preset services, not just its persisted preset label. */
  assertMounted(agent: Agent, id: string): void {
    const registry = this.ctx.get('agentPresets') as { serviceFor?: (agent: Agent, name: string) => { executionBinding?: string } | undefined } | undefined
    if (registry?.serviceFor?.(agent, 'fs')?.executionBinding !== id || registry?.serviceFor?.(agent, 'subprocess')?.executionBinding !== id)
      throw new Error('The Session does not mount the filesystem and process services of its assigned execution world')
    this.require(id)
  }
  list(input: unknown = {}): WorldList {
    const { offset } = EndpointPage.parse(input)
    const records = this.host.store.db.prepare('SELECT value FROM managed_world ORDER BY rowid LIMIT 101 OFFSET ?').all(offset)
      .map(row => JSON.parse(String(row.value)) as WorldRecord)
    return { items: records.slice(0, 100).map(record => this.view(record)), nextOffset: records.length > 100 ? offset + 100 : null }
  }
  /** Host/preset lookup is exact. It never falls back to local services or another generation when unavailable. */
  require(id: string): ManagedWorld {
    const entry = this.opened.get(id)
    if (!entry || !this.get(id).ready) throw new EnvironmentError(409, 'This managed execution world is unavailable or revoked')
    entry.workspace.assertPair(); return entry
  }
  /** Preset construction can borrow the pair while its own registration is being prepared. */
  borrow(id: string): ManagedWorld {
    const entry = this.opened.get(id)
    if (this.stopped || !this.record(id).enabled || !entry?.world.status().ready) throw new Error('Execution world provider is unavailable')
    return entry
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { if (this.stopped) throw new Error('Execution world pool is stopping'); this.host.lifetime.throwIfAborted(); return run() })
    this.queue = next.catch(() => {}); return next
  }
  private save(record: WorldRecord): void {
    this.host.store.db.prepare('INSERT INTO managed_world VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record))
  }
  private replay(requestId: string, digest: string): WorldView | undefined {
    const row = this.host.store.db.prepare('SELECT fingerprint,world FROM managed_world_command WHERE id=?').get(requestId)
    if (!row) return
    if (row.fingerprint !== digest) throw new EnvironmentError(409, 'This pool request ID already has another payload')
    return this.get(String(row.world))
  }
  private receipt(requestId: string, digest: string, id: string): void {
    this.host.store.db.prepare('INSERT INTO managed_world_command VALUES (?,?,?)').run(requestId, digest, id)
  }
  /** Recover each durable activation before managed Sessions resume; unavailable members remain visible and denied. */
  initialize(): Promise<void> {
    return this.serial(async () => { for (const record of this.records()) await this.open(record) })
  }
  activate(input: unknown): Promise<WorldView> {
    const request = ActivateWorld.parse(input), digest = fingerprint({ op: 'activate', ...request })
    return this.serial(async () => {
      const replay = this.replay(request.requestId, digest); if (replay) return replay
      const connection = await this.host.endpoints.world(request.endpointId, request.commandId)
      const id = worldBinding(request.endpointId, connection.grant), at = stamp()
      const existing = this.records().find(record => record.id === id)
      if (existing) {
        if (!existing.enabled) throw new EnvironmentError(409, 'This generation was revoked; explicitly authorize and activate a new generation')
        this.receipt(request.requestId, digest, id); return this.view(existing)
      }
      const record: WorldRecord = { ...connection, id, name: request.name, endpointId: request.endpointId, grantId: connection.grant.id,
        epoch: connection.grant.epoch, root: connection.grant.root, revision: 1, enabled: true, createdAt: at, updatedAt: at }
      this.host.store.atomic(() => { this.save(record); this.receipt(request.requestId, digest, id) })
      await this.open(record)
      return this.get(id)
    })
  }
  /** Explicit retry retains the same private configuration, credential digest and immutable grant; it never reenrolls. */
  refresh(id: string): Promise<WorldView> {
    return this.serial(async () => {
      const record = this.record(id), entry = this.opened.get(id)
      if (!entry) await this.open(record)
      else try {
        await entry.world.refresh(); this.problems.delete(id)
        if (record.enabled && entry.world.status().ready && !entry.prepared) await this.prepare(record, entry)
      } catch (error) { this.problem(id, error) }
      return this.get(id)
    })
  }
  revoke(id: string, input: unknown): Promise<WorldView> {
    const request = RevokeWorld.parse(input), digest = fingerprint({ op: 'revoke', id, ...request })
    return this.serial(async () => {
      const replay = this.replay(request.requestId, digest)
      if (!replay) this.host.store.atomic(() => {
        const record = this.record(id)
        if (record.revision !== request.revision) throw new EnvironmentError(409, 'The execution world changed; refresh before revoking')
        if (record.enabled) { record.enabled = false; record.revision++; record.updatedAt = stamp(); record.revoke = { requestId: request.requestId, reason: request.reason }; this.save(record) }
        this.receipt(request.requestId, digest, id)
      })
      const record = this.record(id)
      this.host.revoked?.(id)
      if (!this.opened.has(id)) await this.open(record)
      else await this.flushRevocation(record)
      return this.get(id)
    })
  }
  private problem(id: string, error: unknown): void {
    this.problems.set(id, error instanceof Error ? error.message : String(error)); this.host.report(error)
  }
  private async flushRevocation(record: WorldRecord): Promise<void> {
    if (!record.revoke) return
    try { await this.opened.get(record.id)!.world.revoke(record.revoke.requestId, record.revoke.reason); this.problems.delete(record.id) }
    catch (error) { this.problem(record.id, error) }
  }
  private async prepare(record: WorldRecord, entry: Entry): Promise<void> {
    const { world, workspace, presets } = entry
    await world.withOwner({ kind: 'host', purpose: 'pool-enrollment' }, () => workspace.assertPair(), () => workspace.verify(record.root))
    await presets.prepare(); entry.prepared = true
  }
  private async open(record: WorldRecord): Promise<void> {
    if (this.opened.has(record.id)) return
    let world: RemoteWorld | undefined, context: Context | undefined, presets: RemotePresets | undefined
    try {
      assertOwnershipCredential(this.host.ownershipConfig, [record.grant.root])
      if (this.host.ownershipConfig) for (const credentialFile of this.host.controlFiles ?? [])
        assertOwnershipCredential({ ...this.host.ownershipConfig, credentialFile }, [record.grant.root])
      const config = this.host.restoreWorld?.(record.id, record.config) ?? record.config
      world = new RemoteWorld({ ...config, lifetime: this.host.lifetime, ownership: this.host.ownership }, { grant: record.grant,
        credentialReader: () => privateCredential(config.credentialFile, record.credentialPin) })
      await world.start()
      context = new Context()
      const client = world.executionClient(), filesystem = new RemoteFileSystem(context, client, world.grant), subprocess = new RemoteSubprocess(context, client, world.grant, world.commands)
      const workspace = new RemoteWorkspace(world, filesystem, subprocess, this.host.lifetime)
      presets = new RemotePresets(this.ctx, world, true)
      const entry: Entry = { world, filesystem, subprocess, workspace, presets, context, prepared: false }
      this.opened.set(record.id, entry); this.problems.delete(record.id)
      if (record.revoke) await this.flushRevocation(record)
      else if (world.status().ready) {
        await this.prepare(record, entry)
      }
      world.maintain(error => this.host.report(error))
    } catch (error) {
      this.opened.delete(record.id); await presets?.dispose(); await context?.fiber.dispose(); await world?.close(); this.problem(record.id, error)
    }
  }
  /** Drain activation/revocation before disposing providers and closing each world's independent journal. */
  async stop(): Promise<void> {
    this.stopped = true; await this.queue
    await Promise.all([...this.opened.values()].map(async entry => {
      try { await entry.presets.dispose() } finally { try { await entry.context.fiber.dispose() } finally { await entry.world.close() } }
    }))
    this.opened.clear()
  }
}
