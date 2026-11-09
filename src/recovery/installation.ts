/** A private deployment of a prepared checkpoint. Historical requests are never rewritten to relocate a host. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { KV } from '../kv.ts'
import { credentialDigest, privateCredential, privateDirectory, privateFile } from '../environments/endpoint-files.ts'
import { fingerprint, inside } from '../remote/journal.ts'
import { worldBinding, type WorldRecord } from '../remote/world-journal.ts'
import type { RemoteWorldConfig } from '../remote/world.ts'
import type { CoordinatorOwnershipConfig } from '../ownership/lease.ts'
import type { PublicationConnection } from '../publication/client.ts'
import type { AuditCheckpointReceipts } from './audit.ts'
import type { RecoveryIntent } from './ownership.ts'
import { withVerifiedStagedCheckpoint } from './checkpoint.ts'
import { privateInput, recoveryKey } from './crypto.ts'
import { ReceiptImage, syncRecoveryPath, verifyReceiptImage } from './image.ts'
import { recoveryStateDigest } from './state.ts'
import { readRecoveryBindings, resolveRecoveryRegistration, resolveRecoveryWorld } from './bindings.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const absolute = z.string().min(1).max(4096).refine(isAbsolute)
const connection = z.object({ url: z.string().min(1).max(2048), credentialFile: absolute,
  timeoutMs: z.number().int().min(100).max(60_000).optional() })
const authority = connection.extend({ authorityId: z.string().min(1).max(200), coordinatorId: z.string().min(1).max(200) }).strict()
const publisher = connection.extend({ serviceId: z.string().uuid() }).strict()
const world = connection.extend({ endpointId: z.string().uuid(), stateDir: absolute }).strict()
export const Installation = z.object({ version: z.literal(1), id: z.string().uuid(), requestHash: digest, root: absolute,
  stateDir: absolute, image: ReceiptImage, masterId: z.string().min(1), sourceRoot: absolute,
  sessions: z.array(z.object({ id: z.string(), header: z.record(z.string(), z.unknown()), inheritedEventCount: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(), sha256: digest, bytes: z.number().int().nonnegative(), member: z.string().regex(/^[a-z0-9-]+\.bin$/) }).strict()).min(1).max(10000),
  workspaces: z.array(absolute).max(20000), storeDigest: digest,
  ownership: authority, publication: publisher.optional(),
  administrators: z.object({ authority, endpoints: z.array(connection.extend({ endpointId: z.string().uuid() }).strict()).max(256), publication: publisher.optional() }).strict(),
  worlds: z.array(z.object({ binding: digest, managed: z.boolean(), config: world, digest, original: z.unknown() }).strict()).max(20000),
  registrations: z.array(z.object({ original: digest, url: z.string().min(1).max(2048), credentialFile: absolute }).strict()).max(20000),
  credentials: z.array(z.object({ file: absolute, pin: digest }).strict()).max(20000),
}).strict()
export type Installation = z.infer<typeof Installation>
export interface InstallCheckpoint extends Pick<AuditCheckpointReceipts, 'checkpoint' | 'keyFile' | 'destination' | 'authority' | 'endpoints' | 'worlds' | 'publication' | 'publicationClient' | 'signal'> {
  preparationId: string; requestId: string; target: string
  /** Map a retained private path to the same credential on this host. The credential's original pin still applies. */
  credentials?: { from: string; to: string }[]
}
const mac = (value: unknown, key: Buffer, domain: string) => createHmac('sha256', key).update(domain + '\n').update(JSON.stringify(value)).digest()
export function signInstallationValue(value: unknown, keyFile: string, domain: string): string {
  const key = recoveryKey(keyFile)
  try { return JSON.stringify({ value, mac: mac(value, key, domain).toString('hex') }) } finally { key.fill(0) }
}
export function authenticateInstallationValue(input: string, keyFile: string, domain: string): unknown {
  const envelope = z.object({ value: z.unknown(), mac: digest }).strict().parse(JSON.parse(input)), key = recoveryKey(keyFile)
  try { if (!timingSafeEqual(mac(envelope.value, key, domain), Buffer.from(envelope.mac, 'hex'))) throw new Error('Installation authentication failed') }
  finally { key.fill(0) }
  return envelope.value
}
export async function readInstallation(root: string, keyFile: string, signal: AbortSignal): Promise<Installation> {
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('Installation requires a private owned directory')
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of privateInput(join(root, 'installation.json'), signal)) {
    bytes += chunk.length; if (bytes > 32_000_000) throw new Error('Installation manifest exceeds its bound')
    chunks.push(Buffer.from(chunk))
  }
  const value = Installation.parse(authenticateInstallationValue(Buffer.concat(chunks).toString('utf8'), keyFile, 'dsh-installation:1'))
  if (value.root !== resolve(root) || value.stateDir !== join(value.root, 'state')) throw new Error('Installation cannot be moved without a new installation request')
  for (const item of value.credentials) {
    if (!inside(join(value.root, 'control'), item.file)) throw new Error('Installed credential path differs from its private deployment')
    privateCredential(item.file, item.pin)
  }
  for (const item of value.worlds) if (item.config.stateDir !== join(value.root, 'worlds', item.binding)) throw new Error('Installed world directory differs')
  return value
}
const rows = <T>(db: DatabaseSync, table: string): T[] => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  ? db.prepare(`SELECT value FROM ${table}`).all().map(row => JSON.parse(String(row.value)) as T) : []
export const installationKV = <T>(db: DatabaseSync, key: string): T | undefined => {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : undefined
}
/** Installation does not acquire ownership. Only startup may consume it while holding the destination Store lock. */
export async function installCheckpoint(options: InstallCheckpoint): Promise<Installation> {
  z.string().uuid().parse(options.requestId); z.string().uuid().parse(options.preparationId)
  if (!isAbsolute(options.target) || resolve(options.target) !== options.target) throw new Error('Installation target must be a normalized absolute path')
  const signal = options.signal ?? new AbortController().signal
  return withVerifiedStagedCheckpoint(options.checkpoint, options.keyFile, options.destination, signal, async ({ root, manifest, db }) => {
    const imageRoot = join(root, 'prepared-' + options.preparationId), image = await verifyReceiptImage(imageRoot, options.keyFile, signal)
    if (image.checkpoint !== manifest.id || image.digest !== fingerprint(manifest)) throw new Error('Installation image differs from its checkpoint')
    for (const proof of ['administration', 'revocations', 'executionConfiguration', 'sessionBackend', 'controlConfiguration', 'inferenceConfiguration',
      'consumedInputs', 'sourceConfiguration', 'stateGraph', 'connectorState', 'workspaceState', 'resultState', 'registryState', 'contextState', 'budgetState', 'publicationState'] as const)
      if (!image[proof]) throw new Error('Installation requires a fully prepared current recovery image')
    const reservation = installationKV<RecoveryIntent>(db, KV.recovery.reservation)
    if (reservation?.phase !== 'reserved' || fingerprint(reservation.recovery) !== fingerprint(image.recovery)) throw new Error('Installation requires the original ownership reservation')
    const requestHash = fingerprint({ requestId: options.requestId, target: options.target, image: fingerprint(image), authority: options.authority,
      endpoints: options.endpoints.map(({ url, endpointId, credentialFile, timeoutMs }) => ({ url, endpointId, credentialFile, timeoutMs })),
      worlds: options.worlds, publication: options.publication, publicationClient: options.publicationClient, credentials: options.credentials })
    try {
      await lstat(options.target)
      const previous = await readInstallation(options.target, options.keyFile, signal)
      if (previous.id !== options.requestId || previous.requestHash !== requestHash) throw new Error('Installation target belongs to a different request')
      return previous
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = privateDirectory(dirname(options.target))
    if (join(parent, basename(options.target)) !== options.target) throw new Error('Installation target cannot use a redirected parent directory')
    const workspaces = new Set(manifest.executionWorkspaces)
    for (const file of image.files.filter(item => item.kind === 'world')) {
      const journal = new DatabaseSync(join(imageRoot, file.member), { readOnly: true })
      try { workspaces.add((JSON.parse(String(journal.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value)) as WorldRecord).grant.root) }
      finally { journal.close() }
    }
    if ([...workspaces].some(workspace => inside(workspace, options.target))) throw new Error('Installation and its private files must stay outside execution workspaces')
    const scratch = await mkdtemp(join(parent, '.install-'))
    const physical = (path: string) => join(scratch, path.slice(options.target.length + 1))
    try {
      privateDirectory(join(scratch, 'state')); privateDirectory(join(scratch, 'control')); privateDirectory(join(scratch, 'worlds')); privateDirectory(join(scratch, 'archive'))
      const mappings = new Map<string, string>()
      for (const item of options.credentials ?? []) {
        if (!isAbsolute(item.from) || !isAbsolute(item.to) || mappings.has(item.from) || mappings.size >= 20000) throw new Error('Credential mappings require unique bounded absolute paths')
        mappings.set(item.from, item.to)
      }
      const credentials: Installation['credentials'] = [], copied = new Map<string, string>()
      const copyCredential = (source: string, expected?: string): string => {
        const value = privateCredential(mappings.get(source) ?? source, expected), pin = credentialDigest(value)
        const file = join(options.target, 'control', pin + '.token')
        if (!copied.has(pin)) { privateFile(physical(file), value); copied.set(pin, file); credentials.push({ file, pin }) }
        return file
      }
      const copyConnection = <T extends { credentialFile: string }>(value: T): T => ({ ...value, credentialFile: copyCredential(value.credentialFile) })
      const stateDir = join(options.target, 'state'), storeFile = join(scratch, 'state', 'orchestrator.sqlite')
      await copyFile(join(imageRoot, 'orchestrator.sqlite'), storeFile); await chmod(storeFile, 0o600)
      const store = new DatabaseSync(storeFile)
      let value: Installation
      try {
        const previousBindings = readRecoveryBindings(store)
        store.prepare('DELETE FROM kv WHERE key=?').run(KV.recovery.activation)
        const owner = installationKV<{ authorityId: string; coordinatorId: string }>(store, KV.runtime.ownership)
        if (owner?.authorityId !== options.authority.authorityId || owner.coordinatorId !== options.authority.coordinatorId) throw new Error('Installation authority differs from original coordinator')
        const ownership = copyConnection({ ...options.authority, credentialFile: reservation.credentialFile })
        const previousPublication = installationKV<{ serviceId: string; credentialFile?: string }>(store, KV.runtime.publication)
        const publication = options.publicationClient ?? (options.publication && previousPublication?.credentialFile
          ? { ...options.publication, credentialFile: previousPublication.credentialFile } : undefined)
        if (previousPublication?.serviceId !== publication?.serviceId) throw new Error('Installation publication identity differs')
        type Managed = { id: string; config: RemoteWorldConfig; credentialPin: string }
        const managed = new Map(rows<Managed>(store, 'managed_world').map(record => [record.id, record]))
        const worlds: Installation['worlds'] = []
        for (const file of image.files.filter(item => item.kind === 'world')) {
          const originalFile = manifest.files.find(item => item.binding === file.binding && item.kind === 'world')
          if (!file.binding || !originalFile) throw new Error('Installation world lacks its original binding')
          const directory = privateDirectory(join(scratch, 'worlds', file.binding)), worldFile = join(directory, 'world.sqlite')
          await copyFile(join(imageRoot, file.member), worldFile); await chmod(worldFile, 0o600)
          const journal = new DatabaseSync(worldFile, { readOnly: true })
          try {
            const original = JSON.parse(String(journal.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value)) as WorldRecord
            if (worldBinding(original.endpointId, original.grant) !== file.binding) throw new Error('Installation world binding differs')
            const record = managed.get(file.binding), priorConfig = previousBindings?.worlds.find(item => item.binding === file.binding)?.config ?? record?.config
            const selected = options.worlds?.find(item => item.binding === file.binding) ?? priorConfig
            if (!selected || selected.endpointId !== original.endpointId) throw new Error('Installation requires the original world connection, including revoked worlds')
            const { url, endpointId, timeoutMs } = selected
            const config = { url, endpointId, ...(timeoutMs ? { timeoutMs } : {}), credentialFile: copyCredential(selected.credentialFile, record?.credentialPin), stateDir: join(options.target, 'worlds', file.binding) }
            worlds.push({ binding: file.binding, managed: !!record, config, original, digest: recoveryStateDigest(journal, signal) })
          } finally { journal.close() }
          await syncRecoveryPath(worldFile); await syncRecoveryPath(directory)
        }
        if (worlds.filter(item => !item.managed).length > 1) throw new Error('A deployment can mount only one dedicated execution world')
        type Registration = { id: string; url: string; credentialFile: string; credentialPin: string }
        type Command = { endpointId: string; registration: Registration; credentialPin?: string; result?: { grant?: { id: string; epoch: number } } }
        const commands = rows<Command>(store, 'operator_endpoint_command'), registrations: Installation['registrations'] = []
        const seen = new Set<string>()
        for (const record of [...rows<Registration>(store, 'operator_endpoint'), ...commands.map(command => command.registration)]) {
          const original = fingerprint(record)
          if (seen.has(original)) continue
          seen.add(original)
          const selected = options.endpoints.find(endpoint => endpoint.endpointId === record.id)
          if (!selected) throw new Error('Installation requires every retained endpoint connection')
          const operational = resolveRecoveryRegistration(previousBindings, record)
          registrations.push({ original, url: selected.url, credentialFile: copyCredential(operational.credentialFile, record.credentialPin) })
        }
        // Issued but not yet activated generations must remain available for an original-ID operator retry.
        for (const command of commands) if (command.credentialPin && command.result?.grant) {
          const grant = command.result.grant, suffix = join('operator-endpoints', command.endpointId, `${grant.id}-${grant.epoch}`, 'grant.token')
          const source = join(manifest.sourceRoot, suffix), credentialFile = copyCredential(source, command.credentialPin)
          const destination = join(stateDir, suffix); privateDirectory(dirname(physical(destination)))
          privateFile(physical(destination), privateCredential(physical(credentialFile), command.credentialPin))
        }
        value = Installation.parse({ version: 1, id: options.requestId, requestHash, root: options.target, stateDir, image, masterId: manifest.masterId,
          sourceRoot: manifest.sourceRoot, sessions: manifest.sessions, workspaces: [...workspaces], storeDigest: recoveryStateDigest(store, signal), ownership,
          ...(publication ? { publication: copyConnection(publication) } : {}), worlds, registrations, credentials,
          administrators: { authority: copyConnection(options.authority), endpoints: options.endpoints.map(({ url, endpointId, credentialFile, timeoutMs }) =>
            copyConnection({ url, endpointId, credentialFile, ...(timeoutMs ? { timeoutMs } : {}) })),
            ...(options.publication ? { publication: copyConnection(options.publication) } : {}) } })
      } finally { store.close() }
      for (const session of manifest.sessions) {
        const file = join(scratch, 'archive', session.member)
        await copyFile(join(imageRoot, session.member), file); await chmod(file, 0o600); await syncRecoveryPath(file)
      }
      await syncRecoveryPath(join(scratch, 'archive')); await syncRecoveryPath(join(scratch, 'worlds'))
      await writeFile(join(scratch, 'installation.json'), signInstallationValue(value, options.keyFile, 'dsh-installation:1'), { mode: 0o600 })
      await syncRecoveryPath(storeFile); await syncRecoveryPath(join(scratch, 'installation.json')); await syncRecoveryPath(scratch)
      signal.throwIfAborted(); await mkdir(options.target, { mode: 0o700 }); await rename(scratch, options.target); await syncRecoveryPath(parent)
      return value
    } finally { await rm(scratch, { recursive: true, force: true }) }
  })
}

/** Return only operational overrides; retained approvals, command fingerprints and world identities stay untouched. */
export function installationBindings(value: Installation) {
  return {
    registration: <T extends { url: string; credentialFile: string }>(record: T): T => resolveRecoveryRegistration(value, record),
    world: (binding: string, config: RemoteWorldConfig): RemoteWorldConfig => resolveRecoveryWorld(value, binding, config),
  }
}

export function installationProfile(value: Installation, keyFile: string) {
  return { executionMode: 'local' as const, stateDir: value.stateDir, ownership: value.ownership as CoordinatorOwnershipConfig,
    ...(value.publication ? { publication: value.publication as PublicationConnection } : {}), restore: { directory: value.root, keyFile } }
}
