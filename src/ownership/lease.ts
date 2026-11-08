import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { privateCredential } from '../environments/endpoint-files.ts'
import { OwnershipClient, type OwnershipConnection } from './client.ts'
import { OwnershipError, OwnershipView, type OwnershipAccess, type OwnershipClaim } from './protocol.ts'

export interface CoordinatorOwnershipConfig extends OwnershipConnection { coordinatorId: string; leaseMs?: number; prepareTimeoutMs?: number }
/** One process lifetime owns one instance identity. Loss is terminal: it never silently reacquires a new generation. */
export class CoordinatorOwnership implements OwnershipAccess {
  readonly authorityId: string
  readonly coordinatorId: string
  readonly instanceId = randomUUID()
  private readonly claimant: OwnershipClient
  private readonly lifetime = new AbortController()
  private readonly stopped = new AbortController()
  private readonly acquireId = randomUUID()
  private readonly activateId = randomUUID()
  private readonly leaseMs: number
  private credential?: string
  private owner?: OwnershipClient
  private view?: OwnershipView
  private deadline = 0
  private expiry?: ReturnType<typeof setTimeout>
  private renewal?: ReturnType<typeof setTimeout>
  private started?: Promise<void>
  private updating?: Promise<void>
  private closing?: Promise<void>
  private problem?: string
  constructor(readonly config: CoordinatorOwnershipConfig) {
    this.authorityId = config.authorityId; this.coordinatorId = config.coordinatorId
    this.leaseMs = config.leaseMs ?? 30_000
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1000 || this.leaseMs > 60_000) throw new Error('Ownership lease must be between 1 and 60 seconds')
    const credential = privateCredential(config.credentialFile)
    if (!credential.startsWith('claim.' + this.coordinatorId + '.')) throw new Error('Coordinator acquisition credential has the wrong scope')
    const pin = createHash('sha256').update(credential).digest('hex')
    this.claimant = new OwnershipClient(config, () => privateCredential(config.credentialFile, pin))
  }
  get signal(): AbortSignal { return this.lifetime.signal }
  status() { return { authorityId: this.authorityId, coordinatorId: this.coordinatorId, instanceId: this.instanceId,
    phase: this.lifetime.signal.aborted ? 'lost' : this.view?.phase ?? 'starting', owner: this.view?.owner, problem: this.problem } }
  proof(): string {
    if (this.lifetime.signal.aborted || this.view?.phase !== 'active' || this.deadline <= performance.now() || !this.credential)
      throw new OwnershipError(409, 'ownership_unavailable', 'Coordinator execution ownership is unavailable')
    return this.credential
  }
  private lose(error: unknown): void {
    if (this.lifetime.signal.aborted) return
    this.problem = error instanceof Error ? error.message : 'Coordinator ownership lost'
    this.lifetime.abort(new OwnershipError(409, 'ownership_lost', this.problem))
    if (this.expiry) clearTimeout(this.expiry); if (this.renewal) clearTimeout(this.renewal)
  }
  private observe(input: unknown, started: number): void {
    const view = OwnershipView.parse(input)
    if (!view.owner || view.coordinatorId !== this.coordinatorId || view.owner.instanceId !== this.instanceId
      || this.view?.owner && (this.view.owner.epoch !== view.owner.epoch || this.view.owner.nonce !== view.owner.nonce))
      throw new OwnershipError(409, 'owner_superseded', 'Authority response does not belong to this coordinator instance')
    const deadline = started + view.remainingMs
    if (deadline <= performance.now()) throw new OwnershipError(409, 'ownership_expired', 'Ownership response arrived after its conservative local deadline')
    this.view = view; this.deadline = deadline
    if (this.expiry) clearTimeout(this.expiry)
    this.expiry = setTimeout(() => this.lose(new Error('Coordinator ownership deadline expired')), deadline - performance.now()); this.expiry.unref()
  }
  private wait(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(this.stopped.signal.reason) }
      const timer = setTimeout(() => { this.stopped.signal.removeEventListener('abort', abort); resolve() }, ms)
      if (this.stopped.signal.aborted) abort()
      else this.stopped.signal.addEventListener('abort', abort, { once: true })
    })
  }
  /** Retry acquisition with the same identity only; no returned proof means no work is admitted. */
  start(): Promise<void> {
    if (this.started) return this.started
    this.started = (async () => {
      const until = performance.now() + (this.config.prepareTimeoutMs ?? 60_000)
      for (;;) {
        const started = performance.now()
        try {
          const claim = await this.claimant.call<OwnershipClaim>({ op: 'lease.acquire', requestId: this.acquireId, instanceId: this.instanceId, leaseMs: this.leaseMs }, this.stopped.signal)
          this.credential = claim.credential; this.owner = this.claimant.withCredential(claim.credential)
          this.stopped.signal.throwIfAborted(); this.observe(claim.lease, started); break
        } catch (error) {
          if (this.stopped.signal.aborted || performance.now() >= until || error instanceof OwnershipError && error.code !== 'owner_busy') throw error
          await this.wait(200)
        }
      }
      while (this.view?.phase !== 'active') {
        this.lifetime.signal.throwIfAborted()
        if (performance.now() >= until) throw new Error('Resources did not complete ownership fencing before the preparation deadline')
        await this.update(true)
        if (this.status().phase !== 'active') await this.wait(200)
      }
      this.schedule()
    })().catch(error => { this.lose(error); throw error })
    return this.started
  }
  private schedule(): void {
    if (this.lifetime.signal.aborted || this.stopped.signal.aborted) return
    this.renewal = setTimeout(() => { void this.update(false).then(() => this.schedule()).catch(error => this.lose(error)) }, Math.max(100, this.leaseMs / 3))
    this.renewal.unref()
  }
  private update(activate: boolean): Promise<void> {
    if (this.updating) return this.updating
    const operation = async () => {
      this.stopped.signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
      const started = performance.now()
      const view = await this.owner!.call({ op: 'lease.renew', requestId: randomUUID(), leaseMs: this.leaseMs }, this.stopped.signal)
      this.observe(view, started)
      if (activate) {
        const activationStart = performance.now()
        try { this.observe(await this.owner!.call({ op: 'lease.activate', requestId: this.activateId }, this.stopped.signal), activationStart) }
        catch (error) { if (!(error instanceof OwnershipError) || error.code !== 'fencing_required') throw error }
      }
    }
    const pending = operation().finally(() => { if (this.updating === pending) this.updating = undefined })
    this.updating = pending; return pending
  }
  /** Stop local admission before best-effort release. Remote resources still enforce the barrier if the release reply is lost. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.lose(new Error('Coordinator ownership stopped')); this.stopped.abort(new Error('Coordinator ownership stopped'))
      await this.started?.catch(() => {})
      await this.updating?.catch(() => {})
      if (this.owner) await this.owner.call({ op: 'lease.release', requestId: randomUUID() }, AbortSignal.timeout(5000)).catch(() => {})
      this.credential = undefined
    })()
  }
}
