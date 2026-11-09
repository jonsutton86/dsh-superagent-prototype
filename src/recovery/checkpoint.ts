/** Offline coordinator checkpoints: acquire every writer before capturing databases and logical Harness Session prefixes. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { backup, DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import type { SessionPersistence, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { Ticket } from '../core/index.ts'
import type { EnvironmentRecord } from '../environments/model.ts'
import { SCHEMA_VERSION } from '../app/store.ts'
import { KV } from '../kv.ts'
import { inside } from '../remote/journal.ts'
import { worldBinding, type WorldRecord } from '../remote/world-journal.ts'
import { privateDirectory } from '../environments/endpoint-files.ts'
import { privateInput, recoveryKey, seal, unseal } from './crypto.ts'
import { exportSession, importSession, inspectSession, ownSessions, type SessionArchive } from './sessions.ts'
import { recoveryStateDigest } from './state.ts'

const member = z.string().regex(/^[a-z0-9-]+\.bin$/), digest = z.string().regex(/^[a-f0-9]{64}$/)
const sealed = z.object({ member, iv: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/),
  sha256: digest, bytes: z.number().int().nonnegative().max(2 ** 40) }).strict()
const envelope = z.object({ version: z.literal(1), id: z.string().uuid(), manifest: sealed }).strict()
const manifestSchema = z.object({ version: z.literal(1), id: z.string().uuid(), createdAt: z.string().datetime(), sourceRoot: z.string(),
  schema: z.literal(SCHEMA_VERSION), masterId: z.string(), files: z.array(sealed.extend({ kind: z.enum(['store', 'world', 'session']),
    binding: digest.optional(), source: z.string().optional() }).strict()).min(1).max(20000),
  sessions: z.array(z.object({ id: z.string(), header: z.record(z.string(), z.unknown()), inheritedEventCount: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(), sha256: digest, bytes: z.number().int().nonnegative(), member }).strict()).max(10000),
  requiredFiles: z.array(z.string()).max(20000), executionWorkspaces: z.array(z.string()).max(20000),
  recovery: z.literal('fenced-until-ownership-reconciled') }).strict()
export type CheckpointManifest = z.infer<typeof manifestSchema>
export const RESTORE_HOLD = KV.recovery.hold
interface CheckpointOptions {
  stateDir: string; outputDir: string; keyFile: string; persistence: SessionPersistence
  /** Dedicated profiles keep their world journals outside the coordinator Store; supply those directories explicitly. */
  worldDirectories?: string[]; signal?: AbortSignal
}
const table = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const values = <T>(db: DatabaseSync, name: 'ticket' | 'managed_world' | 'operator_endpoint' | 'execution_environment'): T[] => table(db, name)
  ? db.prepare(`SELECT value FROM ${name}`).all().map(row => JSON.parse(String(row.value)) as T) : []
function integrity(db: DatabaseSync): void {
  const result = db.prepare('PRAGMA integrity_check').all()
  if (result.length !== 1 || Object.values(result[0]!)[0] !== 'ok') throw new Error('Checkpoint database failed its SQLite integrity check')
}
async function syncDirectory(directory: string): Promise<void> { const file = await open(directory, 'r'); try { await file.sync() } finally { await file.close() } }
async function regular(file: string, max = 2 ** 40): Promise<void> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > max)
    throw new Error('Checkpoint members must be private owned regular files with no extra hard links')
}
async function database(file: string): Promise<DatabaseSync> { await regular(file); const db = new DatabaseSync(file, { readOnly: true }); try { integrity(db); return db } catch (error) { db.close(); throw error } }
const kv = (db: DatabaseSync, key: string): unknown => JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value ?? 'null'))
function identity(db: DatabaseSync): string {
  if (kv(db, KV.store.schema) !== SCHEMA_VERSION) throw new Error('Checkpoint requires the current coordinator schema')
  const master = kv(db, KV.runtime.masterId)
  if (typeof master !== 'string' || !master) throw new Error('Coordinator has no persisted main Session identity')
  return master
}
function receiptSessions(db: DatabaseSync): string[] {
  if (!table(db, 'execution_effect')) return []
  return [...new Set(db.prepare('SELECT value FROM execution_effect').all().flatMap(row => {
    const record = JSON.parse(String(row.value)) as { owner: { kind: string; sessionId?: string } }
    return record.owner.kind === 'assignment' && record.owner.sessionId ? [record.owner.sessionId] : []
  }))]
}
/** Persisted delivery or prompt metadata proves history existed; an assignment rejected before Session creation does not. */
function references(db: DatabaseSync, sessions: Set<string>, worlds: Set<string>): void {
  if (!sessions.has(identity(db))) throw new Error('The main Harness Session is missing from the checkpoint')
  for (const ticket of values<Ticket>(db, 'ticket')) {
    if (ticket.execution?.environment?.world && !worlds.has(ticket.execution.environment.world))
      throw new Error('A task execution world is missing; include its dedicated world directory before checkpointing')
    if (ticket.assignments.some(assignment => assignment.deliveredAt || assignment.report || assignment.idleAt)
      && !sessions.has('worker-' + ticket.id)) throw new Error('An executed task has no exportable Harness Session')
  }
  for (const row of db.prepare('SELECT key,value FROM kv').all()) {
    const key = String(row.key)
    if (key.startsWith(KV.sessions.prompts.prefix) && !sessions.has(key.slice(KV.sessions.prompts.prefix.length)))
      throw new Error('A recorded Harness Session is missing from the checkpoint')
    if (key.startsWith(KV.sessions.world.prefix)) {
      const binding = JSON.parse(String(row.value))
      if (binding !== 'local' && !worlds.has(binding)) throw new Error('A Session execution world is missing from the checkpoint')
    }
  }
}

/** A completed encrypted directory is published atomically; failed or interrupted captures never look like usable backups. */
export async function createCheckpoint(options: CheckpointOptions): Promise<{ path: string; manifest: CheckpointManifest }> {
  const root = await realpath(options.stateDir), output = privateDirectory(options.outputDir), key = recoveryKey(options.keyFile)
  const abort = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal
  const releases: (() => void)[] = [], handles: SessionHandle[] = [], databases: DatabaseSync[] = []
  let staging: string | undefined, scratch: string | undefined
  try {
    if (inside(root, output) || inside(output, root)) throw new Error('Checkpoint output must be separate from coordinator state')
    releases.push(lockSync(root, { stale: 30_000, onCompromised: error => abort.abort(error) }))
    const store = await database(join(root, 'orchestrator.sqlite')); databases.push(store)
    const masterId = identity(store)
    if (kv(store, RESTORE_HOLD)) throw new Error('A staged restore cannot become the source of a new checkpoint')
    const tickets = values<Ticket>(store, 'ticket')
    const managed = values<{ id: string; config: { stateDir: string; credentialFile: string } }>(store, 'managed_world')
    const workspaces = [...new Set([...tickets.flatMap(ticket => ticket.execution?.directory ? [ticket.execution.directory] : []),
      ...values<EnvironmentRecord>(store, 'execution_environment').flatMap(item => [item.root, item.configuredRoot])])]
    if (workspaces.some(path => inside(path, output) || inside(path, resolve(options.keyFile)))) throw new Error('Checkpoint output and its key must stay outside execution workspaces')
    if (inside(output, resolve(options.keyFile)) || inside(root, resolve(options.keyFile))) throw new Error('Recovery key must be separate from checkpoint output and coordinator state')
    const worlds = new Map<string, { db: DatabaseSync; source: string }>()
    const directories = new Set<string>()
    for (const directory of [...new Set([...managed.map(item => item.config.stateDir), ...options.worldDirectories ?? []])].sort()) {
      try { await lstat(join(directory, 'world.sqlite')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const source = await realpath(directory)
      if (directories.has(source)) continue
      directories.add(source)
      releases.push(lockSync(source, { stale: 30_000, onCompromised: error => abort.abort(error) }))
      const db = await database(join(source, 'world.sqlite')); databases.push(db)
      const row = db.prepare('SELECT value FROM execution_world WHERE id=1').get()
      if (!row) throw new Error('Execution world has no persisted authority record')
      const record = JSON.parse(String(row.value)) as WorldRecord, binding = worldBinding(record.endpointId, record.grant)
      if (worlds.has(binding)) throw new Error('Two journals claim the same execution world')
      worlds.set(binding, { db, source })
    }
    const receiptIds = [...worlds.values()].flatMap(world => receiptSessions(world.db))
    handles.push(...await ownSessions(options.persistence, [masterId, ...tickets.map(ticket => `worker-${ticket.id}`), ...receiptIds], signal))
    references(store, new Set(handles.map(handle => handle.id)), new Set(worlds.keys()))
    for (const id of receiptIds) if (!handles.some(handle => handle.id === id)) throw new Error('A remote execution receipt references missing Session history')
    const id = randomUUID(); staging = await mkdtemp(join(output, '.checkpoint-'))
    // Plaintext never enters the backup destination, including an interrupted capture.
    const plain = scratch = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-source-'))
    const files: CheckpointManifest['files'] = [], sessions: SessionArchive[] = []
    const capture = async (source: string, kind: 'store' | 'world' | 'session', details: { binding?: string; source?: string } = {}) => {
      const name = `member-${files.length}.bin`, item = await seal(source, join(staging!, name), key, id, name, signal)
      files.push({ ...item, kind, ...details }); return item
    }
    const state = join(plain, 'store.sqlite'); await backup(store, state); await chmod(state, 0o600); await capture(state, 'store')
    for (const [binding, world] of worlds) {
      signal.throwIfAborted(); const file = join(plain, `${binding}.sqlite`)
      await backup(world.db, file); await chmod(file, 0o600); await capture(file, 'world', { binding, source: world.source })
    }
    for (const handle of handles) {
      const file = join(plain, `session-${sessions.length}.jsonl`), name = `member-${files.length}.bin`
      const session = await exportSession(handle, file, name, signal), encrypted = await capture(file, 'session')
      if (session.sha256 !== encrypted.sha256 || session.bytes !== encrypted.bytes) throw new Error('Session export changed during capture')
      sessions.push(session)
    }
    const controlFiles = [KV.runtime.ownership, KV.runtime.publication].flatMap(key => {
      const binding = kv(store, key) as { credentialFile?: string } | null
      return binding?.credentialFile ? [binding.credentialFile] : []
    })
    const requiredFiles = [...new Set([...controlFiles, ...managed.map(item => item.config.credentialFile),
      ...values<{ credentialFile: string }>(store, 'operator_endpoint').map(item => item.credentialFile)])]
    const manifest = manifestSchema.parse({ version: 1, id, createdAt: new Date().toISOString(), sourceRoot: root, schema: SCHEMA_VERSION,
      masterId, files, sessions, requiredFiles, executionWorkspaces: workspaces, recovery: 'fenced-until-ownership-reconciled' })
    const manifestFile = join(plain, 'manifest.json'); await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 })
    const sealedManifest = await seal(manifestFile, join(staging, 'manifest.bin'), key, id, 'manifest.bin', signal)
    await writeFile(join(staging, 'checkpoint.json'), JSON.stringify({ version: 1, id, manifest: sealedManifest }), { mode: 0o600 })
    await syncDirectory(join(staging, 'checkpoint.json'))
    await rm(plain, { recursive: true }); scratch = undefined; signal.throwIfAborted(); await syncDirectory(staging)
    const path = join(output, id); await rename(staging, path); staging = undefined; await syncDirectory(output)
    return { path, manifest }
  } finally {
    try {
      // Keep outer ownership until every Session writer and database has closed, even when one close fails.
      const closed = await Promise.allSettled(handles.map(handle => handle.close()))
      closed.push(...await Promise.allSettled(databases.reverse().map(async db => { db.close() })))
      closed.push(...await Promise.allSettled(releases.reverse().map(async release => { release() })))
      const failed = closed.filter(result => result.status === 'rejected')
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Checkpoint ownership cleanup failed')
    } finally {
      try { if (staging) await rm(staging, { recursive: true, force: true }) }
      finally { try { if (scratch) await rm(scratch, { recursive: true, force: true }) } finally { key.fill(0) } }
    }
  }
}

/** Fully authenticate before exposing database or Session metadata; returned staging data remains private and caller-owned. */
async function unpack(path: string, keyFile: string, signal: AbortSignal): Promise<{ directory: string; manifest: CheckpointManifest }> {
  const key = recoveryKey(keyFile), directory = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-'))
  try {
    await regular(join(path, 'checkpoint.json'), 4096)
    const header = envelope.parse(JSON.parse(await readFile(join(path, 'checkpoint.json'), 'utf8')))
    if (header.manifest.member !== 'manifest.bin' || header.manifest.bytes > 8 * 1024 * 1024) throw new Error('Invalid checkpoint manifest member')
    await regular(join(path, 'manifest.bin'), header.manifest.bytes)
    await unseal(join(path, 'manifest.bin'), join(directory, 'manifest.json'), key, header.id, header.manifest, signal)
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
    if (manifest.id !== header.id || manifest.files.some(file => file.member === 'manifest.bin') || new Set(manifest.files.map(file => file.member)).size !== manifest.files.length
      || manifest.files.filter(file => file.kind === 'store').length !== 1) throw new Error('Invalid checkpoint member identities')
    const bindings = manifest.files.filter(file => file.kind === 'world').map(file => file.binding!)
    if (new Set(bindings).size !== bindings.length) throw new Error('Duplicate checkpoint world identities')
    for (const file of manifest.files) {
      await regular(join(path, file.member), file.bytes)
      await unseal(join(path, file.member), join(directory, file.member), key, header.id, file, signal)
      if (file.kind !== 'session') {
        const db = await database(join(directory, file.member))
        try {
          if (file.kind === 'world') {
            const record = JSON.parse(String(db.prepare('SELECT value FROM execution_world WHERE id=1').get()?.value)) as WorldRecord
            if (worldBinding(record.endpointId, record.grant) !== file.binding) throw new Error('World authority differs from its checkpoint manifest')
          }
        } finally { db.close() }
      }
    }
    if (new Set(manifest.sessions.map(item => item.id)).size !== manifest.sessions.length
      || new Set(manifest.sessions.map(item => item.member)).size !== manifest.sessions.length) throw new Error('Duplicate checkpoint Session identities')
    for (const session of manifest.sessions) {
      const file = manifest.files.find(file => file.member === session.member && file.kind === 'session')
      if (!file || file.sha256 !== session.sha256 || file.bytes !== session.bytes) throw new Error('Session member differs from its checkpoint manifest')
      await inspectSession(join(directory, file.member), session as unknown as SessionArchive, signal)
    }
    for (const file of manifest.files.filter(file => file.kind === 'world')) {
      const db = await database(join(directory, file.member))
      try {
        for (const id of receiptSessions(db)) if (!manifest.sessions.some(session => session.id === id))
          throw new Error('A remote execution receipt references missing Session history')
      } finally { db.close() }
    }
    if (manifest.files.filter(file => file.kind === 'session').length !== manifest.sessions.length) throw new Error('Unindexed Session member')
    const store = await database(join(directory, manifest.files.find(file => file.kind === 'store')!.member))
    try {
      if (identity(store) !== manifest.masterId || kv(store, RESTORE_HOLD)) throw new Error('Coordinator identity or recovery state differs from its checkpoint')
      references(store, new Set(manifest.sessions.map(session => session.id)), new Set(bindings))
    } finally { store.close() }
    return { directory, manifest }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  finally { key.fill(0) }
}

export async function verifyCheckpoint(path: string, keyFile: string, signal = new AbortController().signal): Promise<CheckpointManifest> {
  const verified = await unpack(path, keyFile, signal)
  try { return verified.manifest } finally { await rm(verified.directory, { recursive: true, force: true }) }
}

/** Hold the staged writer lock and prove its entire logical database still matches the authenticated source checkpoint. */
export async function withVerifiedStagedCheckpoint<T>(path: string, keyFile: string, destination: string, requestedSignal: AbortSignal,
  operation: (context: { root: string; archive: string; manifest: CheckpointManifest; db: DatabaseSync; signal: AbortSignal }) => Promise<T>): Promise<T> {
  const root = privateDirectory(await realpath(destination)), abort = new AbortController(), signal = AbortSignal.any([requestedSignal, abort.signal])
  const release = lockSync(root, { stale: 30_000, onCompromised: error => abort.abort(error) })
  let verified: Awaited<ReturnType<typeof unpack>> | undefined, original: DatabaseSync | undefined, db: DatabaseSync | undefined
  try {
    verified = await unpack(path, keyFile, signal)
    original = await database(join(verified.directory, verified.manifest.files.find(file => file.kind === 'store')!.member))
    const file = join(root, 'orchestrator.sqlite'); await regular(file)
    db = new DatabaseSync(file); db.exec('PRAGMA synchronous=FULL'); integrity(db)
    const hold = kv(db, RESTORE_HOLD) as { checkpoint?: string; state?: string } | null
    if (hold?.checkpoint !== verified.manifest.id || hold.state !== 'staged' || identity(db) !== verified.manifest.masterId)
      throw new Error('Recovery requires the matching staged coordinator with its execution hold intact')
    if (recoveryStateDigest(original, signal) !== recoveryStateDigest(db, signal)) throw new Error('Staged coordinator data differs from the authenticated checkpoint')
    for (const member of verified.manifest.files.filter(item => item.kind !== 'store')) {
      const hash = createHash('sha256'); let bytes = 0
      for await (const chunk of privateInput(join(root, member.member), signal)) {
        bytes += chunk.length; if (bytes > member.bytes) throw new Error('Staged member exceeds the authenticated size'); hash.update(chunk)
      }
      if (bytes !== member.bytes || hash.digest('hex') !== member.sha256) throw new Error('Staged world or Session member differs from the authenticated checkpoint')
    }
    signal.throwIfAborted()
    return await operation({ root, archive: verified.directory, manifest: verified.manifest, db, signal })
  } finally {
    try { try { db?.close() } finally { original?.close() } } finally {
      try { if (verified) await rm(verified.directory, { recursive: true, force: true }) } finally { release() }
    }
  }
}

/** Stage a verified restore without executing anything. Ownership reconciliation is a separate required state transition. */
export async function stageCheckpoint(path: string, keyFile: string, destination: string, signal = new AbortController().signal): Promise<CheckpointManifest> {
  if (!isAbsolute(destination)) throw new Error('Restore destination must be absolute')
  try { await lstat(destination); throw new Error('Restore refuses an existing destination') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const parent = privateDirectory(dirname(resolve(destination))), target = join(parent, basename(resolve(destination)))
  const verified = await unpack(path, keyFile, signal)
  let staging: string | undefined
  try {
    staging = await mkdtemp(join(parent, '.restore-'))
    const store = verified.manifest.files.find(file => file.kind === 'store')!
    await copyFile(join(verified.directory, store.member), join(staging, 'orchestrator.sqlite'))
    const db = new DatabaseSync(join(staging, 'orchestrator.sqlite'))
    try { db.prepare('INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(RESTORE_HOLD, JSON.stringify({ checkpoint: verified.manifest.id, at: new Date().toISOString(), state: 'staged' })); db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { db.close() }
    for (const file of verified.manifest.files.filter(file => file.kind !== 'store')) await copyFile(join(verified.directory, file.member), join(staging, file.member))
    await writeFile(join(staging, 'restore-manifest.json'), JSON.stringify(verified.manifest), { mode: 0o600 })
    for (const file of ['orchestrator.sqlite', 'restore-manifest.json', ...verified.manifest.files.filter(file => file.kind !== 'store').map(file => file.member)])
      await syncDirectory(join(staging, file))
    await syncDirectory(staging); signal.throwIfAborted()
    // mkdir reserves the final name; replacing an existing state directory is never a recovery operation.
    await mkdir(target, { mode: 0o700 }); await rename(staging, target); await syncDirectory(parent)
    return verified.manifest
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }) }
    finally { await rm(verified.directory, { recursive: true, force: true }) }
  }
}

/** Import verified logical history into the maintenance profile's backend, retaining the staged coordinator's execution hold. */
export async function importCheckpointSessions(path: string, keyFile: string, destination: string, persistence: SessionPersistence,
  requestedSignal = new AbortController().signal): Promise<CheckpointManifest> {
  const root = await realpath(destination), abort = new AbortController(), signal = AbortSignal.any([requestedSignal, abort.signal])
  const release = lockSync(root, { stale: 30_000, onCompromised: error => abort.abort(error) })
  let verified: Awaited<ReturnType<typeof unpack>> | undefined
  try {
    verified = await unpack(path, keyFile, signal)
    const db = await database(join(root, 'orchestrator.sqlite'))
    try {
      const hold = kv(db, RESTORE_HOLD) as { checkpoint?: unknown; state?: unknown } | null
      if (hold?.checkpoint !== verified.manifest.id || hold.state !== 'staged' || identity(db) !== verified.manifest.masterId)
        throw new Error('Session import requires the matching staged coordinator with its execution hold intact')
    } finally { db.close() }
    for (const session of verified.manifest.sessions) {
      signal.throwIfAborted()
      await importSession(persistence, join(verified.directory, session.member), session as unknown as SessionArchive, signal)
    }
    return verified.manifest
  } finally {
    try { if (verified) await rm(verified.directory, { recursive: true, force: true }) } finally { release() }
  }
}
