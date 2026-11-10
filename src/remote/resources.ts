import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { EndpointResources, budgetFiles, type ResourceStatus, type ResourceUsage } from './resource-model.ts'
import { RemoteError } from './protocol.ts'

export interface CgroupIO {
  platform: string; uid: number
  real(path: string): string
  info(path: string): { uid: number; directory: boolean; type: number }
  read(path: string): string
  write(path: string, value: string): void
  children(path: string): string[]
  mkdir(path: string): boolean
  remove(path: string): void
}
const kernel: CgroupIO = {
  platform: process.platform, uid: process.getuid?.() ?? -1, real: realpathSync,
  info: path => { const value = lstatSync(path); return { uid: value.uid, directory: value.isDirectory(), type: statfsSync(path).type } },
  read: path => readFileSync(path, 'utf8').trim(), write: (path, value) => writeFileSync(path, value),
  children: readdirSync, remove: rmdirSync,
  mkdir: path => { try { mkdirSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error } },
}
const controllers = ['cpu', 'memory', 'pids']
const scopeName = /^s-[a-f0-9]{32}-[a-f0-9]{32}$/
const tag = (owner: string) => createHash('sha256').update(owner).digest('hex').slice(0, 32)
const failure = (message: string) => new RemoteError(503, 'resource_boundary', message)
const number = (text: string) => { if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw failure('Invalid kernel resource counter'); return Number(text) }
interface Scope { path: string; owner: string; handle?: SubprocessHandle; exited: boolean; timer?: ReturnType<typeof setTimeout>; detach?: () => void }

/** Cgroup v2 limits the whole worker pool and every managed process tree before untrusted execution. */
export class CgroupResources {
  readonly policy: EndpointResources
  private readonly owners = new AsyncLocalStorage<string>()
  private readonly scopes = new Map<string, Scope>()
  private readonly usage = new Map<string, ResourceUsage>()
  private pool = ''
  private closed = false
  private timer?: ReturnType<typeof setInterval>
  constructor(policy: EndpointResources, private readonly io: CgroupIO = kernel) {
    this.policy = EndpointResources.parse(policy)
    if (io.platform !== 'linux') throw failure('Resource enforcement requires Linux cgroup v2; there is no unbounded fallback')
  }
  start(endpointId: string): void {
    if (this.pool || this.closed || !/^[a-f0-9-]{36}$/.test(endpointId)) throw failure('Invalid resource-pool lifecycle')
    const root = this.policy.cgroupRoot
    this.directory(root)
    if (this.io.read(join(root, 'cgroup.procs'))) throw failure('The delegated cgroup must contain no processes; use a separate worker subtree')
    this.enable(root)
    const pool = join(root, 'dsh-' + endpointId), created = this.io.mkdir(pool)
    try {
      this.directory(pool)
      if (created) for (const [key, value] of Object.entries(budgetFiles(this.policy.pool, false))) this.io.write(join(pool, key), value)
      this.check(pool, budgetFiles(this.policy.pool, false))
      if (this.io.read(join(pool, 'cgroup.procs'))) throw failure('Worker pool must not contain direct processes')
      this.enable(pool)
      this.pool = pool
      this.cleanUnclaimed()
      this.timer = setInterval(() => this.cleanFinished(), 1000); this.timer.unref()
    } catch (error) {
      if (created) { try { this.io.remove(pool) } catch { /* Populated or incomplete state stays visible; never kill on setup failure. */ } }
      this.pool = ''; throw error
    }
  }
  private directory(path: string): void {
    const info = this.io.info(path)
    if (!isAbsolute(path) || this.io.real(path) !== path || !info.directory || info.uid !== this.io.uid || info.type !== 0x63677270
      || this.io.read(join(path, 'cgroup.type')) !== 'domain') throw failure('Resource directory must be a canonical, owned cgroup v2 domain')
  }
  private enable(path: string): void {
    if (!controllers.every(name => this.io.read(join(path, 'cgroup.controllers')).split(/\s+/).includes(name)))
      throw failure('Delegate the CPU, memory and pids controllers before enabling resource limits')
    this.io.write(join(path, 'cgroup.subtree_control'), controllers.map(name => '+' + name).join(' '))
    if (!controllers.every(name => this.io.read(join(path, 'cgroup.subtree_control')).split(/\s+/).includes(name)))
      throw failure('Resource controllers were not enabled')
  }
  private check(path: string, expected: Record<string, string>): void {
    this.directory(path)
    for (const [key, value] of Object.entries(expected)) if (this.io.read(join(path, key)) !== value)
      throw failure('Kernel resource limits differ from the pinned endpoint policy')
  }
  private populated(path: string): boolean {
    const fields = this.io.read(join(path, 'cgroup.events')).split('\n').map(line => line.trim().split(/\s+/))
    const value = fields.find(([key]) => key === 'populated')?.[1]
    if (value !== '0' && value !== '1') throw failure('Kernel process-tree population is unavailable')
    return value === '1'
  }
  private groups(): string[] {
    if (!this.pool || this.closed) throw failure('Resource pool is not running')
    return this.io.children(this.pool).filter(name => scopeName.test(name)).map(name => join(this.pool, name))
  }
  private cleanUnclaimed(): void {
    // An empty old group can be removed atomically. A late pre-exec helper then refuses execution when joining fails.
    for (const path of this.groups()) if (!this.scopes.has(path) && !this.populated(path)) {
      try { this.io.remove(path) } catch { /* A process may have joined after observation; preserve it. */ }
    }
  }
  private remove(scope: Scope): void {
    if (!scope.exited || this.populated(scope.path)) return
    const usage: ResourceUsage = { scopes: 1, complete: true, cpuMicroseconds: null, throttledPeriods: null, oomKills: null, processLimitEvents: null }
    for (const [field, file, key] of [['cpuMicroseconds', 'cpu.stat', 'usage_usec'], ['throttledPeriods', 'cpu.stat', 'nr_throttled'],
      ['oomKills', 'memory.events', 'oom_kill'], ['processLimitEvents', 'pids.events', 'max']] as const) {
      try { usage[field] = number(this.io.read(join(scope.path, file)).split('\n').map(line => line.split(/\s+/)).find(([name]) => name === key)?.[1] ?? '') }
      catch { usage.complete = false }
    }
    this.io.remove(scope.path)
    if (/^(job|operation):/.test(scope.owner)) {
      const prior = this.usage.get(scope.owner)
      if (prior) {
        usage.scopes += prior.scopes; usage.complete &&= prior.complete
        for (const key of ['cpuMicroseconds', 'throttledPeriods', 'oomKills', 'processLimitEvents'] as const)
          usage[key] = usage[key] !== null && prior[key] !== null ? usage[key] + prior[key] : null
      }
      this.usage.set(scope.owner, usage)
      // An endpoint closed before journal projection may leave observations unconsumed; bound volatile retention.
      if (this.usage.size > 512) this.usage.delete(this.usage.keys().next().value!)
    }
    if (scope.timer) clearTimeout(scope.timer)
    scope.detach?.(); this.scopes.delete(scope.path)
  }
  private cleanFinished(): void {
    for (const scope of this.scopes.values()) if (scope.exited) {
      try { this.remove(scope) } catch { /* A changed or populated group is retained; never report cleanup as quiescence. */ }
    }
  }
  run<T>(owner: string, action: () => T): T { return this.owners.run(owner, action) }
  takeUsage(owner: string): ResourceUsage | undefined {
    const value = this.usage.get(owner); this.usage.delete(owner)
    if (value && [...this.scopes.values()].some(scope => scope.owner === owner)) value.complete = false
    return value
  }
  hasLive(owner: string): boolean { const prefix = 's-' + tag(owner) + '-'; return this.groups().some(path => path.slice(this.pool.length + 1).startsWith(prefix) && this.populated(path)) }
  status(): ResourceStatus {
    const result: ResourceStatus = { kind: 'linux-cgroup-v2', policy: this.policy, ready: false, memoryBytes: null, processes: null, activeScopes: null }
    try {
      if (this.closed || !this.pool) return result
      this.check(this.pool, budgetFiles(this.policy.pool, false))
      result.memoryBytes = number(this.io.read(join(this.pool, 'memory.current')))
      result.processes = number(this.io.read(join(this.pool, 'pids.current')))
      result.activeScopes = this.groups().filter(path => this.populated(path)).length
      result.ready = true
    } catch { /* Unknown counters are not zero usage or proof of available enforcement. */ }
    return result
  }
  decorate(runtime: SubprocessRuntime, helper: string): SubprocessRuntime {
    const resources = this
    return new Proxy(runtime, { get(target, property) {
      if (property === 'spawn') return (spec: SubprocessSpawnSpec) => resources.spawn(target, helper, spec)
      if (property === 'spawnTerminal') return async () => { throw failure('Resource-bound endpoints do not expose terminals') }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  private spawn(runtime: SubprocessRuntime, helper: string, spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted()
    if (!this.pool || this.closed || !spec.argv.length) throw failure('Resource pool is not running or the command is empty')
    this.check(this.pool, budgetFiles(this.policy.pool, false))
    this.cleanFinished()
    if (this.groups().length >= 256) throw new RemoteError(429, 'resource_capacity', 'Resource-scope capacity is reserved')
    const owner = this.owners.getStore() ?? 'internal'
    const path = join(this.pool, `s-${tag(owner)}-${randomUUID().replaceAll('-', '')}`)
    if (!this.io.mkdir(path)) throw failure('Resource scope already exists')
    const scope: Scope = { path, owner, exited: false }
    this.scopes.set(path, scope)
    try {
      for (const [key, value] of Object.entries(budgetFiles(this.policy.command))) this.io.write(join(path, key), value)
      this.check(path, budgetFiles(this.policy.command))
      // Reading this kernel-only file proves support for whole-tree cancellation before dispatch.
      this.io.info(join(path, 'cgroup.kill'))
      const handle = runtime.spawn({ ...spec, env: { ...spec.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
        argv: [process.execPath, '--no-warnings', helper, path,
          JSON.stringify({ command: budgetFiles(this.policy.command), pool: budgetFiles(this.policy.pool, false) }), ...spec.argv] })
      scope.handle = handle
      const cancel = () => {
        handle.terminate()
        if (!scope.timer) {
          scope.timer = setTimeout(() => {
            try { if (this.scopes.has(path) && this.populated(path)) this.io.write(join(path, 'cgroup.kill'), '1') }
            catch { /* Failed cancellation remains non-quiescent; original endpoint receipts stay authoritative. */ }
          }, spec.graceMs)
          scope.timer.unref()
        }
      }
      spec.signal?.addEventListener('abort', cancel, { once: true })
      scope.detach = () => spec.signal?.removeEventListener('abort', cancel)
      if (spec.signal?.aborted) cancel()
      const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
        if (!await handle.waitForExit(signal)) return false
        scope.exited = true
        while (this.scopes.has(path)) {
          if (signal?.aborted) return false
          try {
            if (!this.populated(path)) { this.remove(scope); return true }
          } catch { return false }
          await new Promise<void>(resolve => setTimeout(resolve, 25))
        }
        return true
      }
      void handle.done.finally(() => waitForExit(AbortSignal.timeout(Math.min(spec.graceMs + 1000, 60000)))).catch(() => {})
      return { stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr, control: handle.control, collected: handle.collected,
        done: handle.done, terminate: cancel, waitForExit }
    } catch (error) {
      if (!scope.handle) { scope.exited = true; try { this.remove(scope) } catch { /* Preserve incomplete allocation for diagnosis. */ } }
      throw error
    }
  }
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.cleanFinished(); this.closed = true
    // No forced cleanup of live/unknown groups and no invented quiescence on endpoint disposal.
  }
}
