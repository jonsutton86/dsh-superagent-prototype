/** Host-only endpoint administration with durable request identities and immutable grant generation files. */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Store } from '../app/store.ts'
import { RemoteClient } from '../remote/client.ts'
import { ResourceUsageSchema } from '../remote/resource-model.ts'
import { fingerprint, inside } from '../remote/journal.ts'
import { RemoteError, type EndpointCredential, type EndpointIdentity, type GrantReceipt, type RemoteGrant, type RemoteJob, type RemoteOperation } from '../remote/protocol.ts'
import { EnvironmentError } from './model.ts'
import { ADMIN_ACTIONS, CredentialMetadata, EndpointCommand, EndpointPage, EndpointProfile, GrantMetadata, IdentityMetadata, RegisterEndpoint,
  type EndpointAction, type EndpointCatalog, type EndpointJob, type EndpointList, type EndpointOperation, type EndpointRegistration,
  type OperatorCommand, type RemoteProfileView } from './endpoint-model.ts'
import { credentialDigest, privateCredential, privateDirectory, privateFile } from './endpoint-files.ts'
import { remoteProfile } from './remote-profile.ts'
import type { RemoteWorldConfig } from '../remote/world.ts'
import type { OwnershipAccess } from '../ownership/protocol.ts'
import { requiresOwnership } from '../ownership/protocol.ts'
import type { CoordinatorOwnershipConfig } from '../ownership/lease.ts'
import type { PublicationConnection } from '../publication/client.ts'
import { assertOwnership } from '../ownership/runtime.ts'

export interface EndpointWorld { config: RemoteWorldConfig; grant: RemoteGrant; credentialPin: string }

interface Registration extends EndpointRegistration { credentialPin: string }
interface Command extends OperatorCommand { fingerprint: string; registration: Registration; expectedEpoch?: number; previousGrant?: RemoteGrant; credentialPin?: string }
interface EndpointHost { store: Store; stateDir: string; lifetime: AbortSignal; ownership?: OwnershipAccess; ownershipConfig?: CoordinatorOwnershipConfig;
  restoreRegistration?(record: Registration): Registration;
  publicationConfig?: PublicationConnection; workerRoots(): string[] }
const stamp = () => new Date().toISOString()
const jobView = ({ id, grantId, epoch, phase, createdAt, updatedAt, cancelRequested, quiescent, reconciled, resources }: EndpointJob): EndpointJob =>
  ({ id, grantId, epoch, phase, createdAt, updatedAt, cancelRequested, quiescent, reconciled, ...(resources ? { resources: ResourceUsageSchema.parse(resources) } : {}) })
const operationView = ({ id, grantId, epoch, kind, phase, at, reconciled, resources }: EndpointOperation): EndpointOperation =>
  ({ id, grantId, epoch, kind, phase, at, reconciled, ...(resources ? { resources: ResourceUsageSchema.parse(resources) } : {}) })

/** Single-owner control plane. Remote mutations are journaled before dispatch and retried only under their original binding. */
export class Endpoints {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly stopped = new AbortController()
  constructor(private readonly host: EndpointHost) {
    host.store.db.exec(`CREATE TABLE IF NOT EXISTS operator_endpoint (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operator_endpoint_registration (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, endpoint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operator_endpoint_command (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, value TEXT NOT NULL);`)
  }
  private get(id: string): Registration {
    const row = this.host.store.db.prepare('SELECT value FROM operator_endpoint WHERE id=?').get(id)
    if (!row) throw new EnvironmentError(404, 'Endpoint registration not found')
    return JSON.parse(String(row.value)) as Registration
  }
  private registrationView(original: Registration): EndpointRegistration {
    const { credentialPin: _, ...record } = this.host.restoreRegistration?.(original) ?? original
    return record
  }
  private commandView({ fingerprint: _, registration: __, expectedEpoch: ___, previousGrant: ____, credentialPin: _____, ...record }: Command): OperatorCommand { return record }
  private page<T>(table: 'operator_endpoint' | 'operator_endpoint_command', input: unknown, endpoint?: string): EndpointList<T> {
    const { offset } = EndpointPage.parse(input)
    const rows = endpoint === undefined ? this.host.store.db.prepare(`SELECT value FROM ${table} ORDER BY rowid LIMIT 101 OFFSET ?`).all(offset)
      : this.host.store.db.prepare(`SELECT value FROM ${table} WHERE endpoint=? ORDER BY rowid DESC LIMIT 101 OFFSET ?`).all(endpoint, offset)
    return { items: rows.slice(0, 100).map(row => JSON.parse(String(row.value)) as T), nextOffset: rows.length > 100 ? offset + 100 : null }
  }
  list(input: unknown = {}): EndpointList<EndpointRegistration> {
    const page = this.page<Registration>('operator_endpoint', input)
    return { ...page, items: page.items.map(record => this.registrationView(record)) }
  }
  commands(id: string, input: unknown = {}): EndpointList<OperatorCommand> {
    this.get(id)
    const page = this.page<Command>('operator_endpoint_command', input, id)
    return { ...page, items: page.items.map(record => this.commandView(record)) }
  }
  private separate(path: string): void {
    if (this.host.workerRoots().some(root => {
      let canonical = resolve(root)
      try { canonical = realpathSync(root) } catch { /* A future workspace still must not enclose private control paths. */ }
      return inside(canonical, path)
    })) throw new EnvironmentError(409, 'Keep endpoint administration files outside every local execution workspace')
  }
  private client(record: Registration): RemoteClient {
    record = this.host.restoreRegistration?.(record) ?? record
    this.separate(record.credentialFile)
    return new RemoteClient({ url: record.url, endpointId: record.id, credentialFile: record.credentialFile,
      ownership: this.host.ownership, lifetime: this.stopped.signal }, request => {
      if (requiresOwnership(request.op)) this.host.lifetime.throwIfAborted()
    }, undefined, () => {
      this.separate(record.credentialFile)
      const credential = privateCredential(record.credentialFile, record.credentialPin)
      if (!/^[A-Za-z0-9_-]{43,}$/.test(credential)) throw new EnvironmentError(409, 'Use the endpoint administrator credential file')
      return credential
    })
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { this.stopped.signal.throwIfAborted(); this.host.lifetime.throwIfAborted(); return run() })
    this.queue = next.catch(() => {}); return next
  }
  async register(input: unknown): Promise<EndpointRegistration> {
    const request = RegisterEndpoint.parse(input), digest = fingerprint(request)
    return this.serial(async () => {
      const replay = this.host.store.db.prepare('SELECT fingerprint,endpoint FROM operator_endpoint_registration WHERE id=?').get(request.requestId)
      if (replay) {
        if (replay.fingerprint !== digest) throw new EnvironmentError(409, 'This registration request ID already has another payload')
        return this.registrationView(this.get(String(replay.endpoint)))
      }
      const existing = this.host.store.db.prepare('SELECT value FROM operator_endpoint WHERE id=?').get(request.endpointId)
      const previous = existing ? JSON.parse(String(existing.value)) as Registration : undefined
      if (request.revision !== (previous?.revision ?? 0)) throw new EnvironmentError(409, 'Endpoint registration changed; refresh before updating it')
      if (!isAbsolute(request.credentialFile) || lstatSync(request.credentialFile).isSymbolicLink())
        throw new EnvironmentError(409, 'Use an absolute path to a private administrator credential file')
      const credentialFile = join(realpathSync(dirname(request.credentialFile)), basename(request.credentialFile))
      this.separate(credentialFile)
      const at = stamp(), record = { id: request.endpointId, name: request.name, url: request.url, credentialFile,
        credentialPin: credentialDigest(privateCredential(credentialFile)), revision: request.revision + 1, createdAt: previous?.createdAt ?? at, updatedAt: at } as Registration
      const client = this.client(record)
      const identity = IdentityMetadata.parse(await client.call({ op: 'identity' }))
      assertOwnership(this.host.ownership, identity.ownership)
      if (identity.protocol !== 1 || identity.id !== record.id || !identity.capabilities.administration)
        throw new EnvironmentError(409, 'Endpoint does not support pinned operator administration')
      await client.call({ op: 'grant.list', offset: 0 }) // An identity response alone does not establish the administrator role.
      record.identity = identity
      this.host.store.atomic(() => {
        this.host.store.db.prepare('INSERT INTO operator_endpoint VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record))
        this.host.store.db.prepare('INSERT INTO operator_endpoint_registration VALUES (?,?,?)').run(request.requestId, digest, record.id)
      })
      return this.registrationView(record)
    })
  }
  async catalog(id: string, input: unknown = {}): Promise<EndpointCatalog> {
    const { offset } = EndpointPage.parse(input), client = this.client(this.get(id))
    const [grants, credentials, jobs, operations] = await Promise.all([
      client.call<EndpointList<RemoteGrant>>({ op: 'grant.list', offset }), client.call<EndpointList<EndpointCredential>>({ op: 'credential.list', offset }),
      client.call<EndpointList<EndpointJob>>({ op: 'job.catalog', offset }), client.call<EndpointList<EndpointOperation>>({ op: 'operation.list', offset }),
    ])
    return { grants: { ...grants, items: grants.items.map(value => GrantMetadata.parse(value)) }, credentials: { ...credentials, items: credentials.items.map(value => CredentialMetadata.parse(value)) },
      jobs: { ...jobs, items: jobs.items.map(jobView) }, operations: { ...operations, items: operations.items.map(operationView) } }
  }
  private findCommand(endpoint: string, id: string): Command | undefined {
    const row = this.host.store.db.prepare('SELECT value FROM operator_endpoint_command WHERE id=? AND endpoint=?').get(`${endpoint}:${id}`, endpoint)
    return row ? JSON.parse(String(row.value)) as Command : undefined
  }
  private save(command: Command): void {
    command.updatedAt = stamp()
    this.host.store.db.prepare('INSERT INTO operator_endpoint_command VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(`${command.endpointId}:${command.id}`, command.endpointId, JSON.stringify(command))
  }
  async submit(id: string, input: unknown): Promise<OperatorCommand> {
    const parsed = EndpointCommand.parse(input)
    if (!(ADMIN_ACTIONS as readonly string[]).includes(parsed.request.op)) throw new EnvironmentError(400, 'This RPC is not an operator administration action')
    const request = parsed.request as EndpointAction, digest = fingerprint(parsed)
    return this.serial(async () => {
      const replay = this.findCommand(id, request.requestId)
      if (replay) {
        if (replay.fingerprint !== digest) throw new EnvironmentError(409, 'This administration request ID already has another payload')
        return this.commandView(replay) // Re-submission observes; only the explicit retry endpoint resends a pending intent.
      }
      const registration = this.get(id)
      if (registration.revision !== parsed.revision) throw new EnvironmentError(409, 'Endpoint registration changed; refresh before submitting work')
      const client = this.client(registration), at = stamp()
      assertOwnership(this.host.ownership, registration.identity.ownership)
      const command: Command = { id: request.requestId, endpointId: id, enrollmentRevision: parsed.revision, registration, request,
        fingerprint: digest, phase: 'pending', createdAt: at, updatedAt: at }
      if (request.op === 'grant.create') command.expectedEpoch = 1
      if (request.op === 'grant.change') {
        const grant = GrantMetadata.parse(await client.call({ op: 'grant.get', id: request.id }))
        if (grant.revision !== request.revision) throw new EnvironmentError(409, 'Grant revision changed; refresh before authorizing it')
        command.expectedEpoch = grant.epoch + 1; command.previousGrant = grant
      }
      this.save(command) // Durable before any remote mutation, including a request whose response is lost.
      return this.deliver(command, true)
    })
  }
  retry(id: string, commandId: string): Promise<OperatorCommand> {
    return this.serial(async () => {
      const command = this.findCommand(id, commandId)
      if (!command) throw new EnvironmentError(404, 'Administration request not found')
      return command.phase === 'pending' || command.phase === 'unknown' ? this.deliver(command) : this.commandView(command)
    })
  }
  private directory(command: Command, grant: RemoteGrant): string {
    const base = join(privateDirectory(this.host.stateDir), 'operator-endpoints')
    this.separate(resolve(base))
    const root = privateDirectory(base); this.separate(root)
    return privateDirectory(join(privateDirectory(join(root, command.endpointId)), `${grant.id}-${grant.epoch}`))
  }
  private grantResult(command: Command, value: GrantReceipt): void {
    const grant = GrantMetadata.parse(value.grant), request = command.request, previous = command.previousGrant
    command.result = { grant }
    // Endpoint idempotency receipts return the grant's CURRENT generation. Never adopt later authority on an old replay.
    if (grant.epoch !== command.expectedEpoch || request.op === 'grant.create' && (grant.owner !== request.owner || grant.workspace !== request.workspace)
      || previous && (grant.id !== previous.id || grant.rootIdentity !== previous.rootIdentity || grant.root !== previous.root)) {
      command.phase = 'superseded'; command.problem = 'The endpoint returned another grant generation; authorize a fresh change explicitly'; return
    }
    const sameSet = (left: unknown[], right: unknown[]) => fingerprint(left.map(item => JSON.stringify(item)).sort()) === fingerprint(right.map(item => JSON.stringify(item)).sort())
    const expectedCredentials = request.op === 'grant.create' ? request.credentials ?? [] : request.op === 'grant.change' ? request.credentials ?? previous?.credentials ?? [] : []
    if (request.op !== 'grant.create' && request.op !== 'grant.change'
      || !sameSet(grant.operations, [...new Set(request.op === 'grant.create' ? request.operations : previous!.operations)])
      || !sameSet((grant.credentials ?? []).map(({ id, version }) => ({ id, version })), expectedCredentials.map(({ id, version }) => ({ id, version }))))
      throw new Error('Endpoint grant does not match the authorized request')
    if (request.op === 'grant.change' && (grant.owner !== previous!.owner || grant.workspace !== previous!.workspace || grant.enabled !== request.enabled))
      throw new Error('Endpoint grant does not match the authorized change')
    if (request.op === 'grant.create' || request.op === 'grant.change' && request.enabled) {
      if (!grant.enabled || grant.leaseUntil <= Date.now()) {
        command.phase = 'superseded'; command.problem = 'The issued grant has expired or was revoked; authorize a fresh generation'; return
      }
      if (!value.credential || !new RegExp(`^grant\\.${grant.id}\\.${grant.epoch}\\.[A-Za-z0-9_-]{43}$`).test(value.credential))
        throw new Error('Endpoint returned an invalid grant credential')
      privateFile(join(this.directory(command, grant), 'grant.token'), value.credential)
      command.credentialPin = credentialDigest(value.credential)
    }
    command.phase = 'done'
  }
  private async deliver(command: Command, firstDelivery = false): Promise<OperatorCommand> {
    const request = command.request
    try {
      assertOwnership(this.host.ownership, command.registration.identity.ownership)
      const value = await this.client(command.registration).call<unknown>(request)
      delete command.problem
      switch (request.op) {
        case 'grant.create': case 'grant.change': this.grantResult(command, value as GrantReceipt); break
        case 'credential.import': case 'credential.revoke': command.result = { credential: CredentialMetadata.parse(value) }; command.phase = 'done'; break
        case 'job.cancel': case 'job.reconcile': command.result = { job: jobView(value as RemoteJob) }; command.phase = 'done'; break
        case 'operation.reconcile': command.result = { operation: operationView(value as RemoteOperation) }; command.phase = 'done'; break
      }
    } catch (error) {
      command.phase = firstDelivery && error instanceof RemoteError && error.status < 500 ? 'refused' : 'unknown'
      // Transport/library errors can include local paths; never retain an unfiltered remote response or credential content.
      command.problem = error instanceof RemoteError ? `Endpoint refused the request (${error.code}). Refresh its catalog before retrying.`
        : 'The administration outcome is unconfirmed. Check connectivity and the pinned private files, then retry this original request.'
    }
    this.save(command)
    return this.commandView(command)
  }
  async profile(id: string, commandId: string, input: unknown): Promise<RemoteProfileView> {
    const { port } = EndpointProfile.parse(input)
    return this.serial(async () => {
      const { config, grant } = await this.worldConnection(id, commandId)
      if (this.host.ownership && !this.host.ownershipConfig) throw new EnvironmentError(409, 'Ownership configuration is required to generate a dedicated profile')
      const directory = dirname(config.stateDir), patch = remoteProfile({ ...config, directory, grant, port, ownership: this.host.ownershipConfig, publication: this.host.publicationConfig }), patchFile = join(directory, `profile-${port}.json`)
      privateFile(patchFile, JSON.stringify(patch, null, 2))
      return { endpointId: id, grantId: grant.id, epoch: grant.epoch, leaseUntil: grant.leaseUntil, port, patchFile, patch }
    })
  }
  /** Trusted activation material only; callers must never return the credential digest or private configuration through an agent tool. */
  world(id: string, commandId: string): Promise<EndpointWorld> { return this.serial(() => this.worldConnection(id, commandId)) }
  private async worldConnection(id: string, commandId: string): Promise<EndpointWorld> {
      const command = this.findCommand(id, commandId), grant = command?.result?.grant
      if (!command || command.phase !== 'done' || !grant?.enabled || !command.credentialPin)
        throw new EnvironmentError(409, 'A confirmed enabled grant generation is required to compose a profile')
      const client = this.client(command.registration), identity = await client.call<EndpointIdentity>({ op: 'identity' })
      assertOwnership(this.host.ownership, identity.ownership)
      if (identity.confinement !== 'linux-bubblewrap') throw new EnvironmentError(409, 'A Linux bubblewrap endpoint is required for an execution profile')
      const current = GrantMetadata.parse(await client.call({ op: 'grant.get', id: grant.id }))
      if (!current.enabled || current.epoch !== grant.epoch || current.leaseUntil <= Date.now() || current.root !== grant.root || current.rootIdentity !== grant.rootIdentity)
        throw new EnvironmentError(409, 'The grant expired or changed; explicitly authorize a new generation')
      if (!current.operations.includes('fs.read') || !current.operations.includes('process.spawn') || !identity.capabilities.effectOwnership
        || current.credentials?.length && !identity.capabilities.credentialBindings)
        throw new EnvironmentError(409, 'This grant and endpoint must support the paired Harness execution world and its credential bindings')
      const directory = this.directory(command, grant), credentialFile = join(directory, 'grant.token')
      privateCredential(credentialFile, command.credentialPin)
      return { config: { url: (this.host.restoreRegistration?.(command.registration) ?? command.registration).url, endpointId: id, credentialFile, stateDir: join(directory, 'world') },
        grant: current, credentialPin: command.credentialPin }
  }
  /** Drain administrative writes before Runtime closes its SQLite connection. In-flight requests remain recoverable. */
  async stop(): Promise<void> { this.stopped.abort(); await this.queue }
}
