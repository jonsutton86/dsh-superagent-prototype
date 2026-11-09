import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec, type SubprocessOutcome, type SubprocessTerminalSpawnSpec,
  type SubprocessTerminalHandle, type SubprocessTerminalEnvironment, type SubprocessOutputReader, type SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'
import { RemoteClient, RemoteUncertain } from './client.ts'
import { MAX_WINDOW, type RemoteGrant, type RemoteJob, type OutputWindow } from './protocol.ts'
import { worldBinding } from './world-journal.ts'

/** Non-consuming byte-offset reader; remote truncation and local tail eviction are always reported as loss. */
class OutputTail implements SubprocessOutputReader {
  private bytes = Buffer.alloc(0)
  private start = 0
  private end = 0
  private finished = false
  constructor(private readonly cap: number) {}
  append(window: OutputWindow): Buffer {
    if (window.offset !== this.end) throw new Error('Remote output cursor changed')
    const bytes = Buffer.from(window.data, 'base64')
    if (window.gap) { this.bytes = Buffer.alloc(0); this.start = window.nextOffset }
    else {
      if (window.nextOffset !== window.offset + bytes.length) throw new Error('Invalid remote output window')
      this.bytes = Buffer.concat([this.bytes, bytes]); this.end = window.nextOffset
      if (this.bytes.length > this.cap) { this.start += this.bytes.length - this.cap; this.bytes = this.cap ? this.bytes.subarray(-this.cap) : Buffer.alloc(0) }
    }
    this.end = window.nextOffset
    return bytes
  }
  finish(): void { this.finished = true }
  readFrom(offset: number): SubprocessOutputRead {
    const from = Math.max(this.start, Math.min(this.end, offset))
    let end = this.bytes.length
    if (!this.finished && end) {
      let lead = end - 1
      while (lead > 0 && end - lead < 4 && (this.bytes[lead]! & 0xc0) === 0x80) lead--
      const byte = this.bytes[lead]!, needed = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1
      if (end - lead < needed) end = lead
    }
    return { text: this.bytes.subarray(from - this.start, end).toString('utf8'), nextOffset: this.start + end, lossy: offset < this.start }
  }
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Ephemeral command ownership shared only by providers borrowed from one live host-owned execution world. */
export class RemoteCommandScope {
  private readonly active = new Set<string>()
  private readonly observations = new Set<Set<string>>()
  readonly uncertain = new Set<string>()
  constructor(readonly binding: string) {}
  assertReady(): void {
    if (this.uncertain.size) throw new RemoteUncertain([...this.uncertain][0]!, 'A prior command still needs reconciliation')
  }
  track(id: string): void {
    this.active.add(id)
    for (const tracked of this.observations) tracked.add(id)
  }
  release(id: string): void { this.active.delete(id) }
  /** Retain IDs for exactly the lifetime of each catalog request, including commands started during that request. */
  async observe<T>(read: () => Promise<T>): Promise<{ value: T; tracked: ReadonlySet<string> }> {
    const tracked = new Set(this.active)
    this.observations.add(tracked)
    try { return { value: await read(), tracked } }
    finally { this.observations.delete(tracked) }
  }
}

/** Harness process handles use remote command receipts and byte cursors; service disposal requests cancellation and observes quiescence. */
export class RemoteSubprocess extends SubprocessRuntime {
  readonly executionBinding: string
  private readonly active = new Set<SubprocessHandle>()
  constructor(ctx: Context, private readonly client: RemoteClient, private readonly grant: RemoteGrant,
    private readonly commands = new RemoteCommandScope(worldBinding(client.connection.endpointId, grant))) {
    super(ctx)
    client.bindGrant(grant)
    this.executionBinding = worldBinding(client.connection.endpointId, grant)
    if (commands.binding !== this.executionBinding) throw new Error('Command scope belongs to a different execution world')
    ctx.effect(() => async () => {
      const deadline = AbortSignal.timeout(10_000)
      for (const handle of this.active) handle.terminate()
      await Promise.allSettled([...this.active].map(handle => handle.waitForExit(deadline)))
    })
  }
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    if (env && Object.keys(env).length) return Promise.reject(new Error('Remote executable resolution uses the endpoint runtime PATH'))
    return this.client.call({ op: 'process.executable', command }, signal)
  }
  async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> { return { platform: 'posix', defaultShell: '/bin/bash' } }
  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> { throw new Error('This endpoint does not provide a terminal capability') }
  async reconcileCommand(id: string): Promise<RemoteJob> {
    const job = await this.client.call<RemoteJob>({ op: 'job.get', id })
    if (!job.quiescent) throw new RemoteUncertain(id, 'The managed process range is not confirmed quiescent')
    this.commands.uncertain.delete(id)
    return job
  }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted()
    this.commands.assertReady()
    if (!spec.argv.length || spec.argv.some(value => typeof value !== 'string' || value.includes('\0')) || !spec.cwd
      || !Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > 30_000) throw new Error('Invalid remote process specification')
    if (spec.stdio.stdin === 'pipe' || spec.stdio.control) throw new Error('This endpoint does not provide interactive stdin or a control channel')
    for (const mode of [spec.stdio.stdout, spec.stdio.stderr]) if (typeof mode === 'object' && (!Number.isSafeInteger(mode.maxBytes) || mode.maxBytes < 0)) throw new Error('Invalid output collection bound')
    const id = randomUUID(), outcome = Promise.withResolvers<SubprocessOutcome>(), stopped = Promise.withResolvers<boolean>()
    const tails = { stdout: new OutputTail(typeof spec.stdio.stdout === 'object' ? spec.stdio.stdout.maxBytes : MAX_WINDOW),
      stderr: new OutputTail(typeof spec.stdio.stderr === 'object' ? spec.stdio.stderr.maxBytes : MAX_WINDOW) }
    const pipes = { stdout: spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined, stderr: spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined }
    let cancel = false, cancelled = false, settled = false, submitted = false, quiescent = false, cancelling: Promise<unknown> | undefined
    const requestCancel = () => {
      cancel = true
      if (submitted && !cancelled && !cancelling) {
        cancelling = this.client.intent({ op: 'job.cancel', id, requestId: `cancel-${id}` }).then(() => { cancelled = true })
          .catch(() => { /* The polling path retries this same cancellation receipt after reconnect. */ }).finally(() => { cancelling = undefined })
      }
    }
    const handle: SubprocessHandle = { stdin: undefined, control: undefined, ...pipes,
      collected: { ...(typeof spec.stdio.stdout === 'object' ? { stdout: tails.stdout } : {}), ...(typeof spec.stdio.stderr === 'object' ? { stderr: tails.stderr } : {}) },
      done: outcome.promise, terminate: requestCancel,
      waitForExit: async signal => {
        if (signal?.aborted) return false
        if (!signal) return stopped.promise
        return new Promise<boolean>((resolve, reject) => {
          const abort = () => resolve(false)
          signal.addEventListener('abort', abort, { once: true })
          void stopped.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
        })
      } }
    const aborted = requestCancel
    spec.signal?.addEventListener('abort', aborted, { once: true })
    this.active.add(handle)
    this.commands.track(id)
    const run = async () => {
      const status = await this.client.call<{ grant: RemoteGrant; authorized: boolean }>({ op: 'grant.status' })
      if (!status.authorized || status.grant.id !== this.grant.id || status.grant.epoch !== this.grant.epoch) throw new Error('Remote execution grant changed')
      let offset = 0
      for (let page = 0; ; page++) {
        if (page >= 100) throw new Error('Remote command catalog exceeds reconciliation bound')
        // A tracked command can finish while this observation is in flight. Retain only this request's
        // snapshot, not an unbounded history of completed commands. New sibling commands are also tracked.
        const { value: catalog, tracked } = await this.commands.observe(() =>
          this.client.call<{ items: RemoteJob[]; nextOffset: number | null }>({ op: 'job.list', offset }))
        const orphan = catalog.items.find(job => !job.quiescent && !tracked.has(job.id))
        if (orphan) throw new RemoteUncertain(orphan.id, 'A command from a previous provider instance needs reconciliation')
        if (catalog.nextOffset === null) break
        offset = catalog.nextOffset
      }
      this.commands.assertReady()
      if (cancel) throw new Error('Command cancelled before remote dispatch')
      let job = await this.client.intent<RemoteJob>({ op: 'job.spawn', requestId: id, revision: status.grant.revision, argv: [...spec.argv], cwd: spec.cwd,
        graceMs: spec.graceMs, ...(typeof spec.stdio.stdin === 'object' ? { stdin: spec.stdio.stdin.data } : {}),
        // Forward only Harness identity facts, never coordinator control paths, URLs, credentials or unset ambient keys.
        env: Object.fromEntries(Object.entries(spec.env ?? {}).filter(([key, value]) => value !== undefined
          && (!key.startsWith('DSH_') || key.startsWith('DSH_SUPERAGENT_') || ['DSH_SHELL', 'DSH_SESSION_ID', 'DSH_PROFILE'].includes(key)))
          .map(([key, value]) => [key, value ?? null])) })
      submitted = true
      // Process observation never waits for a downstream reader to drain its pipe.
      const monitor = (async () => {
        for (;;) {
          if (cancel && !cancelled) requestCancel()
          if (job.phase === 'unknown') throw new RemoteUncertain(id, job.error ?? 'Remote command outcome is unknown')
          if (job.quiescent) { quiescent = true; stopped.resolve(true); return }
          await sleep(50)
          job = await this.client.observe<RemoteJob>({ op: 'job.get', id }, id)
        }
      })()
      void monitor.catch(() => {})
      const pumping = new AbortController()
      const pump = async (stream: 'stdout' | 'stderr') => {
        let cursor = 0
        for (;;) {
          pumping.signal.throwIfAborted()
          if (job.phase === 'unknown') throw new RemoteUncertain(id, job.error ?? 'Remote command outcome is unknown')
          // Read after observing settlement so the final output cannot race the receipt.
          const final = job.phase === 'settled'
          for (;;) {
            const window = await this.client.observe<OutputWindow>({ op: 'job.output', id, stream, offset: cursor, limit: MAX_WINDOW }, id)
            const bytes = tails[stream].append(window); cursor = window.nextOffset
            if (pipes[stream] && bytes.length) {
              const pipe = pipes[stream]!
              if (!pipe.write(bytes)) await new Promise<void>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | undefined, finished = false
                const finish = (error?: unknown) => {
                  if (finished) return
                  finished = true; if (timer) clearTimeout(timer)
                  pipe.off('drain', drained); pipe.off('close', closed); pumping.signal.removeEventListener('abort', aborted)
                  if (error) reject(error); else resolve()
                }
                const drained = () => finish(), closed = () => finish(new Error('Remote output pipe closed before it drained'))
                const aborted = () => finish(pumping.signal.reason)
                pipe.once('drain', drained); pipe.once('close', closed); pumping.signal.addEventListener('abort', aborted, { once: true })
                void monitor.then(() => { if (!finished) timer = setTimeout(() => finish(new Error('Remote process exited but its output consumer did not drain')), spec.graceMs) }, finish)
                if (pipe.destroyed) closed()
                if (pumping.signal.aborted) aborted()
              })
            }
            else if (spec.stdio[stream] === 'inherit') process[stream].write(bytes)
            if (window.gap && pipes[stream]) throw new RemoteUncertain(id, 'Piped output exceeded the endpoint retention limit')
            if (window.nextOffset >= window.totalBytes) break
          }
          if (final) { tails[stream].finish(); pipes[stream]?.end(); return }
          await sleep(50)
        }
      }
      const outputs = Promise.all([pump('stdout'), pump('stderr')])
      try {
        await Promise.race([outputs, monitor.then(() => outputs)])
        settled = true
        if (job.outcome) outcome.resolve(job.outcome as SubprocessOutcome)
        else outcome.reject(new Error(job.error ?? 'Remote command did not start'))
        await monitor
      } catch (error) {
        pumping.abort(error); requestCancel()
        await monitor.catch(() => {})
        throw error
      }
    }
    void run().catch(error => {
      const failure = !submitted && !(error instanceof RemoteUncertain) || quiescent ? error
        : error instanceof RemoteUncertain ? error : new RemoteUncertain(id, error instanceof Error ? error.message : String(error))
      if (!quiescent && failure instanceof RemoteUncertain) this.commands.uncertain.add(failure.operationId)
      if (!settled) outcome.reject(failure)
      if (!submitted && !(failure instanceof RemoteUncertain)) stopped.resolve(true)
      else if (!quiescent) stopped.reject(failure)
      pipes.stdout?.destroy(); pipes.stderr?.destroy()
    }).finally(() => { this.active.delete(handle); this.commands.release(id); spec.signal?.removeEventListener('abort', aborted) })
    // Consumers may inspect outcome before waiting for quiescence; keep the independent rejection observed.
    void stopped.promise.catch(() => {})
    return handle
  }
}
