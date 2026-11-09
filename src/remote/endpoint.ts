import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { FsError, FsVersion, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { verifyLocalWorkspace } from '../infra/environment.ts'
import { RemoteJournal, fingerprint, inside, timestamp } from './journal.ts'
import { Rpc, RemoteError, MAX_TEXT, MAX_WINDOW, type Principal, type RpcRequest, type RemoteGrant, type RemoteJob,
  type RemoteOperation, type EndpointIdentity } from './protocol.ts'
import type { ExecutionIsolation } from './isolation.ts'
import { EndpointCredentials } from './credentials.ts'
import { OwnershipGate, sameOwner, type ResourceOwnershipConfig, type OwnershipGuard, type OwnershipFloor } from '../ownership/gate.ts'
import { OwnershipError, requiresOwnership, type OwnershipStamp } from '../ownership/protocol.ts'
import { ResourceInventory } from '../ownership/inventory.ts'
import { worldBinding } from './world-journal.ts'

export interface EndpointHost {
  filesystem: FileSystem; subprocess: SubprocessRuntime; isolation: ExecutionIsolation; stateDir: string; root: string
  allowedEnv?: string[]; outputMaxBytes?: number; maxRunning?: number; shutdownMs?: number
  commandHelper?: string
  ownership?: ResourceOwnershipConfig
  report?(error: unknown): void
  filesystemRpc?(grant: RemoteGrant, request: RpcRequest, signal: AbortSignal): Promise<unknown>
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const DEFAULT_ENV = ['NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER', 'LANG', 'LC_ALL', 'CI', 'GIT_TERMINAL_PROMPT', 'DSH_SHELL', 'DSH_SESSION_ID', 'DSH_PROFILE']
const rootIdentity = async (path: string) => { const value = await stat(path, { bigint: true }); return `${value.dev}:${value.ino}:${value.birthtimeNs}` }

/** Independently authenticated execution endpoint; accepts durable intents before crossing a process or file-effect boundary. */
export class RemoteEndpoint {
  readonly journal: RemoteJournal
  readonly credentials: EndpointCredentials
  readonly ownership?: OwnershipGate
  private readonly inventory: ResourceInventory
  private readonly ownershipScope = new AsyncLocalStorage<OwnershipGuard>()
  private protectedCalls = 0
  private readonly lifetime = new AbortController()
  private readonly live = new Map<string, SubprocessHandle>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly grants = new Map<string, AbortController>()
  private adminQueue: Promise<unknown> = Promise.resolve()
  private fileQueue: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private closing = false
  private closed = false
  private stopping?: Promise<void>
  private initialized = false
  private root = ''
  constructor(private readonly host: EndpointHost) {
    this.journal = new RemoteJournal(host.stateDir, host.root)
    try {
      this.credentials = new EndpointCredentials(this.journal)
      const binding = host.ownership ? { authorityId: host.ownership.authorityId, coordinatorId: host.ownership.coordinatorId, resourceId: host.ownership.resourceId } : undefined
      const saved = this.journal.db.prepare('SELECT value FROM endpoint_meta WHERE key=?').get('ownership-binding')?.value
      if (saved && String(saved) !== JSON.stringify(binding)) throw new Error('Persisted endpoint ownership binding cannot be removed or replaced')
      if (host.ownership && this.journal.grants().some(grant => grant.owner !== host.ownership!.coordinatorId))
        throw new Error('Existing endpoint grants belong to a different ownership coordinator')
      if (host.ownership) this.ownership = new OwnershipGate(host.ownership, {
        floor: () => {
          const row = this.journal.db.prepare('SELECT value FROM endpoint_meta WHERE key=?').get('ownership-floor')
          return row ? JSON.parse(String(row.value)) as OwnershipFloor : undefined
        },
        remember: value => { this.journal.db.prepare('INSERT INTO endpoint_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('ownership-floor', JSON.stringify(value)) },
        fence: keep => this.fenceOwnership(keep), quiescent: keep => this.ownershipQuiescent(keep),
      })
      if (binding && !saved) this.journal.db.prepare('INSERT INTO endpoint_meta VALUES (?,?)').run('ownership-binding', JSON.stringify(binding))
      this.inventory = new ResourceInventory(this.journal.db, [
        { kind: 'grant', table: 'remote_grant', project: (grant: RemoteGrant) => ({ kind: 'grant', id: grant.id,
          requestHash: worldBinding(this.journal.id, grant), phase: grant.enabled ? 'enabled' : 'disabled', settled: true, epoch: grant.epoch }) },
        { kind: 'command', table: 'remote_job', project: (job: RemoteJob) => ({ kind: 'command', id: job.id, requestHash: job.fingerprint,
          grantId: job.grantId, epoch: job.epoch, ownership: job.ownership, phase: job.phase, settled: job.quiescent === true,
          resultHash: fingerprint(job.outcome ?? null) }) },
        { kind: 'mutation', table: 'remote_operation', project: (item: RemoteOperation) => ({ kind: 'mutation', id: item.id,
          requestHash: item.fingerprint, grantId: item.grantId, epoch: item.epoch, ownership: item.ownership, phase: item.phase,
          settled: item.phase === 'settled' || !!item.reconciled, resultHash: fingerprint(item.value ?? item.error ?? null) }) },
      ])
    }
    catch (error) { this.journal.close(); throw error }
  }
  async start(): Promise<void> {
    this.root = await realpath(this.host.root)
    const control = await realpath(this.host.stateDir)
    if (this.host.ownership) {
      const credential = await realpath(this.host.ownership.credentialFile)
      if (inside(this.root, credential) || ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc'].some(path => inside(path, credential)))
        throw new Error('Resource ownership credential must be outside the endpoint workspace and system runtime mounts')
    }
    if (['/', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc', '/tmp'].some(path => this.root === path || (path !== '/' && inside(path, this.root) && path !== '/tmp')))
      throw new Error('Endpoint workspaces must use a dedicated data directory outside system runtime mounts')
    if (['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc'].some(path => inside(path, control)))
      throw new Error('Endpoint control state must be outside system runtime mounts')
    await verifyLocalWorkspace(this.root, this.host.subprocess, this.lifetime.signal, this.host.filesystem)
    if (this.host.isolation.name === 'linux-bubblewrap') await this.verifyIsolation(control)
    this.initialized = true
    this.sweep()
    this.timer = setInterval(() => this.sweep(), 250); this.timer.unref()
    this.ownership?.start(error => this.host.report?.(error))
    for (const job of this.journal.jobs()) if (job.phase === 'accepted') this.enqueue(job.id)
  }
  private async verifyIsolation(control: string): Promise<void> {
    if (!this.host.filesystemRpc) throw new Error('Confined filesystem runner is required')
    const root = await mkdtemp(join(this.root, '.qualification-')), nonce = randomUUID(), at = timestamp()
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
    const grant: RemoteGrant = { id: nonce, owner: 'startup-proof', workspace: 'startup-proof', root, rootIdentity: await rootIdentity(root),
      operations: ['fs.read', 'fs.write', 'process.spawn'], enabled: true, epoch: 1, revision: 1, leaseUntil: Date.now() + 15_000, createdAt: at, updatedAt: at }
    let handle: SubprocessHandle | undefined
    try {
      await this.host.filesystemRpc(grant, { op: 'fs.write', requestId: nonce, path: 'proof', content: nonce, expected: { kind: 'createIfAbsent' } }, signal)
      const argv = await this.host.isolation.wrap(['/bin/sh', '-c', '[ ! -e "$1" ] && cat proof', 'dsh-isolation-proof', control], root, root, false, signal)
      handle = this.host.subprocess.spawn({ argv, cwd: root, graceMs: 1000, signal,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 4096 } } })
      const outcome = await handle.done
      if (outcome.exitCode !== 0 || !await handle.waitForExit(signal) || handle.collected.stdout!.readFrom(0).text !== nonce)
        throw new Error('Execution namespace proof failed: control state must be hidden and filesystem/process views must match')
      if (await this.host.filesystemRpc(grant, { op: 'fs.read', path: 'proof' }, signal) !== nonce) throw new Error('Confined filesystem proof failed')
    } finally {
      handle?.terminate()
      if (!handle || await handle.waitForExit(AbortSignal.timeout(2000)).catch(() => false)) await rm(root, { recursive: true, force: true })
    }
  }
  identity(): EndpointIdentity {
    return { protocol: 1, id: this.journal.id, platform: process.platform, confinement: this.host.isolation.name,
      ...(this.host.ownership ? { ownership: { authorityId: this.host.ownership.authorityId, coordinatorId: this.host.ownership.coordinatorId, resourceId: this.host.ownership.resourceId } } : {}),
      capabilities: { filesystem: true, process: true, terminal: false, interactiveStdin: false, controlChannel: false, outputWindow: MAX_WINDOW, effectOwnership: true, administration: true,
        ...(this.host.commandHelper ? { credentialBindings: true as const } : {}) } }
  }
  private admin(principal: Principal): void { if (principal.role !== 'admin') throw new RemoteError(403, 'admin_required', 'Endpoint administration credential required') }
  private owned(principal: Principal, value: { grantId: string; epoch: number }): void {
    if (principal.role !== 'admin' && (value.grantId !== principal.id || value.epoch !== principal.epoch)) throw new RemoteError(404, 'not_found', 'Receipt not found')
  }
  private grant(principal: Principal, operation?: RemoteGrant['operations'][number]): RemoteGrant {
    if (this.closing) throw new RemoteError(503, 'unavailable', 'Endpoint is stopping')
    if (this.ownership) {
      const guard = this.ownershipScope.getStore()
      if (!guard) throw new OwnershipError(403, 'owner_required', 'Operation has no verified coordinator owner')
      guard.signal.throwIfAborted()
    }
    if (principal.role !== 'grant') throw new RemoteError(403, 'grant_required', 'Use a workspace grant for execution')
    const grant = this.journal.grant(principal.id)
    if (grant.epoch !== principal.epoch || !grant.enabled || grant.leaseUntil <= Date.now())
      throw new RemoteError(409, 'grant_unavailable', 'Execution grant is revoked, expired or superseded')
    if (!this.credentials.valid(grant.credentials)) throw new RemoteError(409, 'credential_unavailable', 'Execution credential binding is revoked or superseded')
    if (operation && !grant.operations.includes(operation)) throw new RemoteError(403, 'operation_denied', `Grant does not allow ${operation}`)
    return grant
  }
  private signal(grant: RemoteGrant): AbortSignal {
    const key = `${grant.id}:${grant.epoch}`
    let controller = this.grants.get(key)
    if (!controller) { controller = new AbortController(); this.grants.set(key, controller) }
    const owner = this.ownershipScope.getStore()
    return AbortSignal.any([controller.signal, this.lifetime.signal, ...owner ? [owner.signal] : []])
  }
  private fenceOwnership(keepAccepted?: OwnershipStamp): void {
    if (this.closed) return
    for (const job of this.journal.jobs()) if (!job.quiescent
      && !(keepAccepted && job.phase === 'accepted' && !job.cancelRequested && job.ownership && sameOwner(keepAccepted, job.ownership))) this.cancel(job)
  }
  private ownershipQuiescent(keepAccepted?: OwnershipStamp): boolean {
    return !this.closed && this.protectedCalls === 0
      && ![...this.pending.keys()].some(id => {
        const job = this.journal.job(id)
        return !(keepAccepted && job.phase === 'accepted' && !job.cancelRequested && job.ownership && sameOwner(keepAccepted, job.ownership))
      })
      && !this.journal.jobs().some(job => !job.quiescent
        && !(keepAccepted && job.phase === 'accepted' && !job.cancelRequested && job.ownership && sameOwner(keepAccepted, job.ownership)))
      && !this.journal.operations().some(operation => operation.phase === 'started' || operation.phase === 'unknown' && !operation.reconciled)
  }
  private async verifyOwnership(): Promise<void> {
    if (!this.ownership) return
    const guard = this.ownershipScope.getStore()
    if (!guard) throw new OwnershipError(403, 'owner_required', 'Operation has no verified coordinator owner')
    await this.ownership.verify(guard)
  }
  private noUnknown(): void {
    if (this.journal.jobs().some(job => job.phase === 'unknown' && !job.quiescent)
      || this.journal.operations().some(operation => operation.phase === 'unknown' && !operation.reconciled))
      throw new RemoteError(409, 'reconciliation_required', 'An uncertain prior effect needs explicit operator reconciliation before new mutations')
  }
  private view(grant: RemoteGrant) { return { grant, ...(grant.enabled ? { credential: this.journal.credential(grant.id, grant.epoch) } : {}) } }
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.adminQueue.then(run, run); this.adminQueue = next.catch(() => {}); return next }
  private async enroll(principal: Principal, request: Extract<RpcRequest, { op: 'grant.create' }>) {
    this.admin(principal)
    if (this.host.ownership && request.owner !== this.host.ownership.coordinatorId) throw new OwnershipError(403, 'owner_mismatch', 'Grant owner differs from this endpoint ownership scope')
    return this.serial(async () => {
      this.lifetime.signal.throwIfAborted()
      await this.verifyOwnership()
      const digest = fingerprint({ principal, request }), replay = this.journal.receipt<string>(request.requestId, digest)
      if (replay) return this.view(this.journal.grant(replay))
      if (request.operations.includes('fs.write') && !request.operations.includes('fs.read')) throw new RemoteError(400, 'invalid_grant', 'Filesystem writes require read access for version guards')
      const credentials = this.credentialBindings(request.credentials ?? [], request.operations)
      if (this.journal.grants().some(grant => grant.workspace === request.workspace)) throw new RemoteError(409, 'workspace_enrolled', 'This workspace already has a grant; change its existing grant')
      const directory = join(this.root, request.workspace)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const root = await realpath(directory)
      if (!inside(this.root, root) || root === this.root) throw new RemoteError(403, 'workspace_escape', 'Workspace resolves outside its assigned root')
      const at = timestamp(), grant: RemoteGrant = { id: randomUUID(), owner: request.owner, workspace: request.workspace, root,
        operations: [...new Set(request.operations)], ...(credentials.length ? { credentials } : {}), enabled: true, revision: 1, epoch: 1, leaseUntil: Date.now() + request.leaseMs,
        createdAt: at, updatedAt: at, rootIdentity: await rootIdentity(root) }
      this.lifetime.signal.throwIfAborted()
      await this.verifyOwnership()
      this.journal.atomic(() => { this.journal.saveGrant(grant); this.journal.remember(request.requestId, digest, grant.id); this.journal.audit({ grant: grant.id, epoch: grant.epoch, action: 'enrolled' }) })
      return this.view(grant)
    })
  }
  private change(principal: Principal, request: Extract<RpcRequest, { op: 'grant.change' | 'grant.renew' }>) {
    if (request.op === 'grant.change') this.admin(principal)
    else this.grant(principal) // A receipt never lets an obsolete credential obtain the replacement generation's secret.
    const digest = fingerprint({ principal, request }), replay = this.journal.receipt<string>(request.requestId, digest)
    if (replay) return this.view(this.journal.grant(replay))
    const grant = request.op === 'grant.change' ? this.journal.grant(request.id) : this.grant(principal)
    if (grant.revision !== request.revision) throw new RemoteError(409, 'stale_revision', 'Grant revision changed')
    const oldEpoch = grant.epoch
    if (request.op === 'grant.change') {
      if (request.credentials !== undefined) grant.credentials = this.credentialBindings(request.credentials, grant.operations)
      else if (request.enabled && !this.credentials.valid(grant.credentials)) throw new RemoteError(409, 'credential_unavailable', 'Supply current credential versions or explicitly remove credential bindings')
    }
    grant.revision++; grant.updatedAt = timestamp(); grant.leaseUntil = Date.now() + request.leaseMs
    if (request.op === 'grant.change') { grant.epoch++; grant.enabled = request.enabled }
    this.journal.atomic(() => { this.journal.saveGrant(grant); this.journal.remember(request.requestId, digest, grant.id);
      this.journal.audit({ grant: grant.id, epoch: grant.epoch, action: request.op, ...(request.op === 'grant.change' ? { reason: request.reason } : {}) }) })
    if (request.op === 'grant.change') this.cancelGeneration(grant.id, oldEpoch)
    return this.view(grant)
  }
  private sweep(): void {
    if (this.closing) return
    for (const grant of this.journal.grants()) if (grant.enabled && (grant.leaseUntil <= Date.now() || !this.credentials.valid(grant.credentials))) {
      const epoch = grant.epoch
      grant.enabled = false; grant.epoch++; grant.revision++; grant.updatedAt = timestamp()
      this.journal.atomic(() => { this.journal.saveGrant(grant); this.journal.audit({ grant: grant.id, epoch: grant.epoch,
        action: grant.leaseUntil <= Date.now() ? 'lease_expired' : 'credential_invalidated' }) })
      this.cancelGeneration(grant.id, epoch)
    }
  }
  private credentialBindings(refs: readonly { id: string; version: string }[], operations: RemoteGrant['operations']) {
    if (refs.length && (!this.host.commandHelper || !operations.includes('process.spawn')))
      throw new RemoteError(400, 'credential_capability', 'Credential bindings require the confined command launcher and process permission')
    return this.credentials.resolve(refs)
  }
  /** A grant may remove only its own generation's authority, including after expiry; it cannot affect a replacement. */
  private revoke(principal: Principal, request: Extract<RpcRequest, { op: 'grant.revoke' }>) {
    if (principal.role !== 'grant') throw new RemoteError(403, 'grant_required', 'Workspace grant required')
    const digest = fingerprint({ principal, request })
    let receipt = this.journal.receipt<{ grantId: string; epoch: number; at: string }>(request.requestId, digest)
    if (!receipt) {
      const grant = this.journal.grant(principal.id), at = timestamp()
      receipt = { grantId: principal.id, epoch: principal.epoch, at }
      this.journal.atomic(() => {
        if (grant.epoch === principal.epoch) {
          grant.enabled = false; grant.epoch++; grant.revision++; grant.updatedAt = at
          this.journal.saveGrant(grant)
        }
        this.journal.remember(request.requestId, digest, receipt)
        this.journal.audit({ grant: principal.id, epoch: principal.epoch, action: request.op, reason: request.reason })
      })
    }
    this.cancelGeneration(principal.id, principal.epoch)
    const own = (value: { grantId: string; epoch: number }) => value.grantId === principal.id && value.epoch === principal.epoch
    const quiescent = !this.journal.jobs().some(job => own(job) && !job.quiescent)
      && !this.journal.operations().some(operation => own(operation) && (operation.phase === 'started' || operation.phase === 'unknown' && !operation.reconciled))
    return { ...receipt, quiescent }
  }
  private cancelGeneration(id: string, epoch: number): void {
    this.grants.get(`${id}:${epoch}`)?.abort(new Error('Execution grant no longer authorizes work'))
    for (const job of this.journal.jobs()) if (job.grantId === id && job.epoch === epoch && !job.quiescent) this.cancel(job)
  }
  private async target(grant: RemoteGrant, path: string, cwd = grant.root): Promise<FsTarget> {
    await this.verifyRoot(grant)
    const absolute = resolve(cwd, path)
    if (!inside(grant.root, absolute) || !inside(grant.root, resolve(cwd))) throw new FsError('Path is outside the granted workspace', 'FS_SANDBOX_DENIED')
    const target = await this.host.filesystem.resolve(absolute, { signal: this.signal(grant) })
    const root = await this.host.filesystem.resolve(grant.root, { signal: this.signal(grant) })
    if (!this.host.filesystem.contains(root, target)) throw new FsError('Path resolves outside the granted workspace', 'FS_SANDBOX_DENIED')
    return target
  }
  private async verifyRoot(grant: RemoteGrant): Promise<void> {
    if (await realpath(grant.root) !== grant.root || await rootIdentity(grant.root) !== grant.rootIdentity)
      throw new FsError('Granted directory identity changed; enroll a new workspace', 'FS_SANDBOX_DENIED')
  }
  private spawn(principal: Principal, request: Extract<RpcRequest, { op: 'job.spawn' }>): RemoteJob {
    const digest = fingerprint({ principal, request }), replay = this.journal.findJob(request.requestId)
    if (replay) { this.owned(principal, replay); if (replay.fingerprint !== digest) throw new RemoteError(409, 'request_conflict', 'Command ID already used'); return replay }
    const grant = this.grant(principal, 'process.spawn'); this.noUnknown()
    if (grant.revision !== request.revision) throw new RemoteError(409, 'stale_revision', 'Grant revision changed before dispatch')
    if (this.journal.jobs().filter(job => !job.quiescent && job.phase !== 'unknown').length >= (this.host.maxRunning ?? 8))
      throw new RemoteError(429, 'capacity', 'Endpoint process capacity is reserved')
    const allowed = new Set([...DEFAULT_ENV, ...this.host.allowedEnv ?? []])
    if (grant.credentials?.some(binding => binding.variable in request.env))
      throw new RemoteError(403, 'credential_override', 'Worker environment overrides cannot replace an endpoint credential binding')
    const denied = Object.keys(request.env).filter(key => !allowed.has(key) && !key.startsWith('DSH_SUPERAGENT_'))
    if (Object.keys(request.env).length > 100 || denied.length)
      throw new RemoteError(403, 'environment_denied', `Only explicitly allowed non-credential environment overrides may be forwarded; rejected names: ${denied.join(', ')}`)
    const at = timestamp(), job: RemoteJob = { id: request.requestId, grantId: grant.id, epoch: grant.epoch, revision: grant.revision,
      fingerprint: digest, request, ...(grant.credentials?.length ? { credentials: grant.credentials } : {}),
      ...(this.ownershipScope.getStore() ? { ownership: this.ownershipScope.getStore()!.stamp } : {}),
      phase: 'accepted', createdAt: at, updatedAt: at, cancelRequested: false, quiescent: false }
    this.journal.atomic(() => { this.journal.saveJob(job); this.journal.audit({ job: job.id, grant: grant.id, epoch: grant.epoch, action: 'accepted' }) })
    this.enqueue(job.id)
    return job
  }
  private enqueue(id: string): void {
    if (this.pending.has(id) || this.closing) return
    const running = Promise.resolve().then(async () => {
      if (!this.ownership) return this.launch(id)
      try {
        const guard = await this.ownership.resume(this.journal.job(id).ownership)
        await this.ownershipScope.run(guard, () => this.launch(id))
      } catch (error) {
        if (this.closed) return
        const job = this.journal.job(id)
        if (job.phase === 'accepted') { job.phase = 'settled'; job.quiescent = true; job.error = message(error).slice(0, 4000); this.journal.saveJob(job) }
      }
    }).finally(() => this.pending.delete(id))
    this.pending.set(id, running)
    void running.catch(() => { /* launch persists failures; shutdown may already have closed the journal. */ })
  }
  private async launch(id: string): Promise<void> {
    let job = this.journal.job(id)
    if (job.phase !== 'accepted' || this.closing) return
    try {
      const principal: Principal = { role: 'grant', id: job.grantId, epoch: job.epoch }, grant = this.grant(principal, 'process.spawn')
      this.noUnknown()
      const target = await this.target(grant, job.request.cwd), cwd = this.host.filesystem.processPath(target)
      if ((await this.host.filesystem.stat(target, this.signal(grant)))?.type !== 'directory') throw new FsError('Working directory is not a directory', 'FS_NOT_DIRECTORY')
      const mounts = await this.credentials.mounts(job.credentials ?? [])
      let command: readonly string[] = job.request.argv
      const attachments: { source: string; target: string }[] = [...mounts]
      if (mounts.length) {
        if (!this.host.commandHelper) throw new RemoteError(503, 'credential_capability', 'Confined command launcher is unavailable')
        const node = await this.host.subprocess.resolveExecutable('node', undefined, this.signal(grant))
        command = [node, '--no-warnings', '/run/dsh-command.mjs', JSON.stringify({ argv: job.request.argv,
          bindings: mounts.map(item => ({ path: item.target, variable: item.variable, mode: item.mode })) })]
        attachments.push({ source: this.host.commandHelper, target: '/run/dsh-command.mjs' })
      }
      const argv = await this.host.isolation.wrap(command, grant.root, cwd, grant.operations.includes('network'), this.signal(grant), job.request.env, undefined, attachments)
      await this.verifyOwnership()
      this.grant(principal, 'process.spawn'); this.noUnknown()
      job = this.journal.job(id)
      if (job.phase !== 'accepted' || job.cancelRequested || this.closing) return
      job.phase = 'started'; this.journal.saveJob(job) // Durable uncertainty boundary BEFORE invoking the process provider.
      const handle = this.host.subprocess.spawn({ argv, cwd, graceMs: job.request.graceMs, signal: this.signal(grant),
        stdio: { stdin: job.request.stdin === undefined ? 'ignore' : { data: job.request.stdin }, stdout: 'pipe', stderr: 'pipe' } })
      this.live.set(id, handle)
      for (const stream of ['stdout', 'stderr'] as const) handle[stream]?.on('data', (bytes: Buffer) => {
        if (!this.closed) this.journal.append(id, stream, Buffer.from(bytes), this.host.outputMaxBytes ?? 8 * 1024 * 1024)
      })
      const outcome = await handle.done
      if (this.closed) return
      job = this.journal.job(id); job.phase = 'settled'; job.outcome = outcome; this.journal.saveJob(job)
      const quiescent = await handle.waitForExit(this.lifetime.signal)
      if (!this.closed) { job = this.journal.job(id); job.quiescent = quiescent; this.journal.saveJob(job) }
      if (quiescent) this.live.delete(id)
    } catch (error) {
      if (this.closed) return
      job = this.journal.job(id)
      if (job.quiescent) return // A revoked, accepted command may have been settled while confinement was being prepared.
      if (job.phase === 'accepted') { job.phase = 'settled'; job.quiescent = true }
      else { job.phase = 'unknown'; job.quiescent = null; this.live.get(id)?.terminate() }
      job.error = message(error).slice(0, 4000); this.journal.saveJob(job)
    }
  }
  private cancel(job: RemoteJob): RemoteJob {
    job.cancelRequested = true
    if (job.phase === 'accepted') { job.phase = 'settled'; job.quiescent = true; job.error = 'Cancelled before process dispatch' }
    this.journal.saveJob(job)
    try { this.live.get(job.id)?.terminate() } catch { /* Unknown range remains visibly unresolved. */ }
    return job
  }
  private async mutate(principal: Principal, request: Extract<RpcRequest, { op: 'fs.write' | 'fs.edit' }>): Promise<RemoteOperation> {
    const digest = fingerprint({ principal, request }), replay = this.journal.operation(request.requestId)
    if (replay) { this.owned(principal, replay); if (replay.fingerprint !== digest) throw new RemoteError(409, 'request_conflict', 'Mutation ID already used'); return replay }
    const grant = this.grant(principal, 'fs.write'); this.noUnknown()
    const target = await this.target(grant, request.path), info = await this.host.filesystem.stat(target, this.signal(grant))
    if ((info?.size ?? 0) > MAX_TEXT) throw new FsError('Atomic text mutation exceeds endpoint limit; use a scoped process for larger files', 'FS_TOO_LARGE')
    await this.verifyOwnership()
    this.grant(principal, 'fs.write'); this.noUnknown()
    // Another identical request can finish path resolution first.
    const current = this.journal.operation(request.requestId)
    if (current) { if (current.fingerprint !== digest) throw new RemoteError(409, 'request_conflict', 'Mutation ID already used'); return current }
    const operation: RemoteOperation = { id: request.requestId, grantId: grant.id, epoch: grant.epoch, fingerprint: digest, kind: request.op,
      ...(request.owner ? { owner: request.owner } : {}), phase: 'started', at: timestamp() }
    if (this.ownershipScope.getStore()) operation.ownership = this.ownershipScope.getStore()!.stamp
    this.journal.saveOperation(operation)
    try {
      if (this.host.filesystemRpc) operation.value = await this.host.filesystemRpc(grant, request, this.signal(grant)) as RemoteOperation['value']
      else if (request.op === 'fs.write') operation.value = await this.host.filesystem.writeText(target, request.content,
        request.expected?.kind === 'replaceIfVersion' ? { ...request.expected, version: FsVersion(request.expected.version) } : request.expected, this.signal(grant))
      else operation.value = await this.host.filesystem.editText(target, request, request.expected ? { version: FsVersion(request.expected.version) } : undefined, this.signal(grant))
      operation.phase = 'settled'
    } catch (error) {
      operation.error = { code: error instanceof FsError ? error.code : 'operation_unknown', message: message(error).slice(0, 4000) }
      operation.phase = error instanceof FsError && !['FS_IO_ERROR', 'FS_ABORTED'].includes(error.code) ? 'settled' : 'unknown'
    }
    if (!this.closed) this.journal.saveOperation(operation)
    return operation
  }
  async rpc(principal: Principal, input: unknown, ownershipProof?: string): Promise<unknown> {
    if (!this.initialized || this.closing) throw new RemoteError(503, 'unavailable', 'Endpoint is not ready')
    const request = Rpc.parse(input)
    if (!this.ownership || !requiresOwnership(request.op)) return this.dispatch(principal, request)
    const guard = await this.ownership.authorize(ownershipProof)
    this.protectedCalls++
    try { return await this.ownershipScope.run(guard, () => this.dispatch(principal, request)) }
    finally { this.protectedCalls-- }
  }
  private async dispatch(principal: Principal, request: RpcRequest): Promise<unknown> {
    switch (request.op) {
      case 'identity': return this.identity()
      case 'recovery.inventory': {
        this.admin(principal)
        const ownership = this.identity().ownership
        if (!ownership) throw new OwnershipError(409, 'ownership_required', 'Recovery inventories require independent ownership')
        return this.inventory.page(request, { id: this.journal.id, kind: 'endpoint', ...ownership }, this.ownershipQuiescent())
      }
      case 'grant.get': this.admin(principal); return this.journal.grant(request.id)
      case 'grant.list': case 'operation.list': case 'job.catalog': {
        this.admin(principal)
        const all = request.op === 'grant.list' ? this.journal.grants() : request.op === 'operation.list' ? this.journal.operations() : this.journal.jobs()
        const page = all.slice(request.offset, request.offset + 100)
        // Administrative catalogs must not transport argv, stdin, env, output or file-edit payloads, even before coordinator projection.
        const items = request.op === 'job.catalog' ? (page as RemoteJob[]).map(({ id, grantId, epoch, phase, createdAt, updatedAt, cancelRequested, quiescent, reconciled }) =>
          ({ id, grantId, epoch, phase, createdAt, updatedAt, cancelRequested, quiescent, reconciled }))
          : request.op === 'operation.list' ? (page as RemoteOperation[]).map(({ id, grantId, epoch, kind, phase, at, reconciled }) =>
            ({ id, grantId, epoch, kind, phase, at, reconciled })) : page
        return { items, nextOffset: request.offset + 100 < all.length ? request.offset + 100 : null }
      }
      case 'credential.list': this.admin(principal); return this.credentials.list(request.offset)
      case 'credential.import': case 'credential.revoke': {
        this.admin(principal)
        return this.serial(async () => {
          this.lifetime.signal.throwIfAborted()
          await this.verifyOwnership()
          const result = request.op === 'credential.import' ? await this.credentials.import(request, () => this.verifyOwnership()) : this.credentials.revoke(request)
          this.sweep() // New dispatch was fenced by the catalog commit; cancel affected generations before acknowledging.
          return result
        })
      }
      case 'grant.create': return this.enroll(principal, request)
      case 'grant.change': case 'grant.renew': return this.change(principal, request)
      case 'grant.revoke': return this.revoke(principal, request)
      case 'grant.status': {
        if (principal.role !== 'grant') throw new RemoteError(403, 'grant_required', 'Workspace grant required')
        const grant = this.journal.grant(principal.id)
        return { grant, authorized: grant.enabled && grant.epoch === principal.epoch && grant.leaseUntil > Date.now() && this.credentials.valid(grant.credentials) }
      }
      case 'job.spawn': return this.spawn(principal, request)
      case 'job.list': {
        const all = this.journal.jobs().filter(job => principal.role === 'admin' || (job.grantId === principal.id && job.epoch === principal.epoch))
        return { items: all.slice(request.offset, request.offset + 100), nextOffset: request.offset + 100 < all.length ? request.offset + 100 : null }
      }
      case 'job.get': case 'job.output': case 'job.cancel': case 'job.reconcile': {
        const job = this.journal.job(request.id); this.owned(principal, job)
        if (request.op === 'job.get') return job
        if (request.op === 'job.output') return this.journal.output(job.id, request.stream, request.offset, request.limit)
        const digest = fingerprint({ principal, request }), replay = this.journal.receipt<string>(request.requestId, digest)
        if (replay) return this.journal.job(replay)
        if (request.op === 'job.reconcile') {
          this.admin(principal)
          if (job.phase !== 'unknown') throw new RemoteError(409, 'not_unknown', 'Only unknown commands need reconciliation')
          job.quiescent = true; job.reconciled = { at: timestamp(), note: request.note }
        }
        if (request.op === 'job.cancel') {
          job.cancelRequested = true
          if (job.phase === 'accepted') { job.phase = 'settled'; job.quiescent = true; job.error = 'Cancelled before process dispatch' }
        }
        this.journal.atomic(() => { this.journal.saveJob(job); this.journal.remember(request.requestId, digest, job.id); this.journal.audit({ action: request.op, job: job.id }) })
        if (request.op === 'job.cancel') try { this.live.get(job.id)?.terminate() } catch { /* Receipt remains for reconciliation. */ }
        return job
      }
      case 'operation.get': case 'operation.reconcile': {
        const operation = this.journal.operation(request.id)
        if (!operation) throw new RemoteError(404, 'not_found', 'Mutation receipt not found')
        this.owned(principal, operation)
        if (request.op === 'operation.reconcile') {
          this.admin(principal)
          const digest = fingerprint({ principal, request }), replay = this.journal.receipt<string>(request.requestId, digest)
          if (replay) return this.journal.operation(replay)
          if (operation.phase !== 'unknown') throw new RemoteError(409, 'not_unknown', 'Only unknown mutations need reconciliation')
          operation.reconciled = { at: timestamp(), note: request.note }
          this.journal.atomic(() => { this.journal.saveOperation(operation); this.journal.remember(request.requestId, digest, operation.id); this.journal.audit({ action: request.op, operation: operation.id, note: request.note }) })
        }
        return operation
      }
      case 'fs.write': case 'fs.edit': {
        const operation = this.fileQueue.then(() => this.mutate(principal, request))
        this.fileQueue = operation.catch(() => {})
        return operation
      }
      case 'process.executable': {
        this.grant(principal, 'process.spawn')
        const program = await this.host.subprocess.resolveExecutable(request.command, undefined, this.lifetime.signal)
        if (!['/usr', '/bin', '/sbin', '/lib', '/lib64'].some(root => inside(root, program))) throw new RemoteError(403, 'executable_denied', 'Executable is outside the mounted system runtime')
        return program
      }
      default: {
        const grant = this.grant(principal, 'fs.read'), fs = this.host.filesystem, signal = this.signal(grant)
        if (this.host.filesystemRpc) { await this.verifyRoot(grant); return this.host.filesystemRpc(grant, request, signal) }
        if (request.op === 'fs.lstat') {
          const path = resolve(request.cwd ?? grant.root, request.path)
          if (!inside(grant.root, path)) throw new FsError('Path is outside the granted workspace', 'FS_SANDBOX_DENIED')
          await this.target(grant, path === grant.root ? path : dirname(path))
          return await fs.lstat(path, undefined, signal) ?? null
        }
        const target = await this.target(grant, request.path, request.op === 'fs.resolve' ? request.cwd : undefined)
        if (request.op === 'fs.resolve') return target
        if (request.op === 'fs.stat') return await fs.stat(target, signal) ?? null
        if (request.op === 'fs.bytes') return Buffer.from(await fs.readByteRange(target, request, signal)).toString('base64')
        if (request.op === 'fs.read') {
          if ((await fs.stat(target, signal))?.size! > MAX_TEXT) throw new FsError('Text exceeds endpoint read limit; stream it in windows', 'FS_TOO_LARGE')
          const text = await fs.readText(target, signal)
          if (Buffer.byteLength(text) > MAX_TEXT) throw new FsError('Text exceeds endpoint read limit', 'FS_TOO_LARGE')
          return text
        }
        const entries = await fs.listDir(target, signal)
        if (entries.length > 2000) throw new FsError('Directory exceeds endpoint listing limit', 'FS_TOO_LARGE')
        const root = await fs.resolve(grant.root, { signal })
        if (entries.some(entry => !fs.contains(root, entry.target))) throw new FsError('Directory contains a link outside the granted workspace', 'FS_SANDBOX_DENIED')
        return entries
      }
    }
  }
  stop(): Promise<void> { return this.stopping ??= this.close() }
  private async close(): Promise<void> {
    this.closing = true; if (this.timer) clearInterval(this.timer)
    this.ownership?.close()
    this.lifetime.abort()
    for (const handle of this.live.values()) try { handle.terminate() } catch { /* The journal keeps uncertain work. */ }
    const timer = AbortSignal.timeout(this.host.shutdownMs ?? 10_000)
    await Promise.allSettled([...this.live.entries()].map(async ([id, handle]) => {
      const quiescent = await handle.waitForExit(timer)
      const job = this.journal.job(id)
      job.quiescent = quiescent
      if (!quiescent || job.phase === 'started') { job.phase = 'unknown'; job.error = 'Endpoint stopped without a complete command receipt' }
      this.journal.saveJob(job)
    }))
    if (!timer.aborted) await new Promise<void>(resolve => {
      const finish = () => { timer.removeEventListener('abort', finish); resolve() }
      timer.addEventListener('abort', finish, { once: true })
      void Promise.allSettled([this.adminQueue, this.fileQueue, ...this.pending.values()]).then(finish)
    })
    this.closed = true; this.journal.close()
  }
}
