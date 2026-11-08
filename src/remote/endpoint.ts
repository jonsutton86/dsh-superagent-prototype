import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { FsError, FsVersion, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { verifyLocalWorkspace } from '../infra/environment.ts'
import { RemoteJournal, fingerprint, inside, timestamp } from './journal.ts'
import { Rpc, RemoteError, MAX_TEXT, MAX_WINDOW, type Principal, type RpcRequest, type RemoteGrant, type RemoteJob,
  type RemoteOperation, type EndpointIdentity } from './protocol.ts'
import type { ExecutionIsolation } from './isolation.ts'

export interface EndpointHost {
  filesystem: FileSystem; subprocess: SubprocessRuntime; isolation: ExecutionIsolation; stateDir: string; root: string
  allowedEnv?: string[]; outputMaxBytes?: number; maxRunning?: number; shutdownMs?: number
  filesystemRpc?(grant: RemoteGrant, request: RpcRequest, signal: AbortSignal): Promise<unknown>
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const DEFAULT_ENV = ['NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER', 'LANG', 'LC_ALL', 'CI', 'GIT_TERMINAL_PROMPT']
const rootIdentity = async (path: string) => { const value = await stat(path, { bigint: true }); return `${value.dev}:${value.ino}:${value.birthtimeNs}` }

/** Independently authenticated execution endpoint; accepts durable intents before crossing a process or file-effect boundary. */
export class RemoteEndpoint {
  readonly journal: RemoteJournal
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
  constructor(private readonly host: EndpointHost) { this.journal = new RemoteJournal(host.stateDir, host.root) }
  async start(): Promise<void> {
    this.root = await realpath(this.host.root)
    const control = await realpath(this.host.stateDir)
    if (['/', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc', '/tmp'].some(path => this.root === path || (path !== '/' && inside(path, this.root) && path !== '/tmp')))
      throw new Error('Endpoint workspaces must use a dedicated data directory outside system runtime mounts')
    if (['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc'].some(path => inside(path, control)))
      throw new Error('Endpoint control state must be outside system runtime mounts')
    await verifyLocalWorkspace(this.root, this.host.subprocess, this.lifetime.signal, this.host.filesystem)
    if (this.host.isolation.name === 'linux-bubblewrap') await this.verifyIsolation(control)
    this.initialized = true
    this.sweep()
    this.timer = setInterval(() => this.sweep(), 250); this.timer.unref()
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
      capabilities: { filesystem: true, process: true, terminal: false, interactiveStdin: false, controlChannel: false, outputWindow: MAX_WINDOW } }
  }
  private admin(principal: Principal): void { if (principal.role !== 'admin') throw new RemoteError(403, 'admin_required', 'Endpoint administration credential required') }
  private owned(principal: Principal, value: { grantId: string; epoch: number }): void {
    if (principal.role !== 'admin' && (value.grantId !== principal.id || value.epoch !== principal.epoch)) throw new RemoteError(404, 'not_found', 'Receipt not found')
  }
  private grant(principal: Principal, operation?: RemoteGrant['operations'][number]): RemoteGrant {
    if (this.closing) throw new RemoteError(503, 'unavailable', 'Endpoint is stopping')
    if (principal.role !== 'grant') throw new RemoteError(403, 'grant_required', 'Use a workspace grant for execution')
    const grant = this.journal.grant(principal.id)
    if (grant.epoch !== principal.epoch || !grant.enabled || grant.leaseUntil <= Date.now())
      throw new RemoteError(409, 'grant_unavailable', 'Execution grant is revoked, expired or superseded')
    if (operation && !grant.operations.includes(operation)) throw new RemoteError(403, 'operation_denied', `Grant does not allow ${operation}`)
    return grant
  }
  private signal(grant: RemoteGrant): AbortSignal {
    const key = `${grant.id}:${grant.epoch}`
    let controller = this.grants.get(key)
    if (!controller) { controller = new AbortController(); this.grants.set(key, controller) }
    return AbortSignal.any([controller.signal, this.lifetime.signal])
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
    return this.serial(async () => {
      this.lifetime.signal.throwIfAborted()
      const digest = fingerprint({ principal, request }), replay = this.journal.receipt<string>(request.requestId, digest)
      if (replay) return this.view(this.journal.grant(replay))
      if (request.operations.includes('fs.write') && !request.operations.includes('fs.read')) throw new RemoteError(400, 'invalid_grant', 'Filesystem writes require read access for version guards')
      if (this.journal.grants().some(grant => grant.workspace === request.workspace)) throw new RemoteError(409, 'workspace_enrolled', 'This workspace already has a grant; change its existing grant')
      const directory = join(this.root, request.workspace)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const root = await realpath(directory)
      if (!inside(this.root, root) || root === this.root) throw new RemoteError(403, 'workspace_escape', 'Workspace resolves outside its assigned root')
      const at = timestamp(), grant: RemoteGrant = { id: randomUUID(), owner: request.owner, workspace: request.workspace, root,
        operations: [...new Set(request.operations)], enabled: true, revision: 1, epoch: 1, leaseUntil: Date.now() + request.leaseMs,
        createdAt: at, updatedAt: at, rootIdentity: await rootIdentity(root) }
      this.lifetime.signal.throwIfAborted()
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
    grant.revision++; grant.updatedAt = timestamp(); grant.leaseUntil = Date.now() + request.leaseMs
    if (request.op === 'grant.change') { grant.epoch++; grant.enabled = request.enabled }
    this.journal.atomic(() => { this.journal.saveGrant(grant); this.journal.remember(request.requestId, digest, grant.id);
      this.journal.audit({ grant: grant.id, epoch: grant.epoch, action: request.op, ...(request.op === 'grant.change' ? { reason: request.reason } : {}) }) })
    if (request.op === 'grant.change') this.cancelGeneration(grant.id, oldEpoch)
    return this.view(grant)
  }
  private sweep(): void {
    if (this.closing) return
    for (const grant of this.journal.grants()) if (grant.enabled && grant.leaseUntil <= Date.now()) {
      const epoch = grant.epoch
      grant.enabled = false; grant.epoch++; grant.revision++; grant.updatedAt = timestamp()
      this.journal.atomic(() => { this.journal.saveGrant(grant); this.journal.audit({ grant: grant.id, epoch: grant.epoch, action: 'lease_expired' }) })
      this.cancelGeneration(grant.id, epoch)
    }
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
    if (Object.keys(request.env).length > 100 || Object.keys(request.env).some(key => !allowed.has(key) && !key.startsWith('DSH_SUPERAGENT_')))
      throw new RemoteError(403, 'environment_denied', 'Only explicitly allowed non-credential environment overrides may be forwarded')
    const at = timestamp(), job: RemoteJob = { id: request.requestId, grantId: grant.id, epoch: grant.epoch, revision: grant.revision,
      fingerprint: digest, request, phase: 'accepted', createdAt: at, updatedAt: at, cancelRequested: false, quiescent: false }
    this.journal.atomic(() => { this.journal.saveJob(job); this.journal.audit({ job: job.id, grant: grant.id, epoch: grant.epoch, action: 'accepted' }) })
    this.enqueue(job.id)
    return job
  }
  private enqueue(id: string): void {
    if (this.pending.has(id) || this.closing) return
    const running = Promise.resolve().then(() => this.launch(id)).finally(() => this.pending.delete(id))
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
      const argv = await this.host.isolation.wrap(job.request.argv, grant.root, cwd, grant.operations.includes('network'), this.signal(grant), job.request.env)
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
    this.grant(principal, 'fs.write'); this.noUnknown()
    // Another identical request can finish path resolution first.
    const current = this.journal.operation(request.requestId)
    if (current) { if (current.fingerprint !== digest) throw new RemoteError(409, 'request_conflict', 'Mutation ID already used'); return current }
    const operation: RemoteOperation = { id: request.requestId, grantId: grant.id, epoch: grant.epoch, fingerprint: digest, kind: request.op, phase: 'started', at: timestamp() }
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
  async rpc(principal: Principal, input: unknown): Promise<unknown> {
    if (!this.initialized || this.closing) throw new RemoteError(503, 'unavailable', 'Endpoint is not ready')
    const request = Rpc.parse(input)
    switch (request.op) {
      case 'identity': return this.identity()
      case 'grant.create': return this.enroll(principal, request)
      case 'grant.change': case 'grant.renew': return this.change(principal, request)
      case 'grant.status': {
        if (principal.role !== 'grant') throw new RemoteError(403, 'grant_required', 'Workspace grant required')
        const grant = this.journal.grant(principal.id)
        return { grant, authorized: grant.enabled && grant.epoch === principal.epoch && grant.leaseUntil > Date.now() }
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
