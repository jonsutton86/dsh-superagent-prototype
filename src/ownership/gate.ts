import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { privateCredential } from '../environments/endpoint-files.ts'
import { OwnershipClient, type OwnershipConnection } from './client.ts'
import { OwnershipError, OwnershipView, type OwnershipStamp } from './protocol.ts'

export interface ResourceOwnershipConfig extends OwnershipConnection { coordinatorId: string; resourceId: string }
export interface OwnershipGuard { stamp: OwnershipStamp; signal: AbortSignal }
export interface OwnershipFloor { epoch: number; nonce?: string }
interface GateHost {
  floor(): OwnershipFloor | undefined
  remember(value: OwnershipFloor): void
  fence(keepAccepted?: OwnershipStamp): void
  quiescent(keepAccepted?: OwnershipStamp): boolean
}
interface Admission { guard: OwnershipGuard; controller: AbortController; until: number; timer: ReturnType<typeof setTimeout> }
export const sameOwner = (a: OwnershipStamp, b: OwnershipStamp) => a.coordinatorId === b.coordinatorId && a.epoch === b.epoch
  && a.nonce === b.nonce && a.instanceId === b.instanceId

/** Resource-side ownership enforcement: verify online, cancel on uncertainty, and acknowledge only actual local quiescence. */
export class OwnershipGate {
  private readonly client: OwnershipClient
  private readonly lifetime = new AbortController()
  private admission?: Admission
  private refreshPending?: Promise<void>
  private poll?: ReturnType<typeof setInterval>
  private observation = 0
  private applied = 0
  private retiredEpoch = -1
  private problem = 'Waiting for ownership observation'
  constructor(readonly config: ResourceOwnershipConfig, private readonly host: GateHost) {
    const credential = privateCredential(config.credentialFile)
    if (!credential.startsWith('resource.' + config.coordinatorId + '.' + config.resourceId + '.')) throw new Error('Resource ownership credential does not match the configured scope')
    const pin = createHash('sha256').update(credential).digest('hex')
    this.client = new OwnershipClient(config, () => privateCredential(config.credentialFile, pin))
  }
  start(report: (error: unknown) => void): void {
    if (this.poll || this.lifetime.signal.aborted) throw new Error('Ownership resource monitor cannot start twice')
    const refresh = () => { void this.refresh().catch(report) }
    this.poll = setInterval(refresh, 500); this.poll.unref(); refresh()
  }
  status() {
    return { authorityId: this.config.authorityId, coordinatorId: this.config.coordinatorId, resourceId: this.config.resourceId,
      ready: !!this.admission && !this.admission.guard.signal.aborted && this.admission.until > performance.now(),
      ...(this.admission ? { owner: this.admission.guard.stamp } : {}), problem: this.problem || undefined }
  }
  private fence(reason: string): void {
    const admission = this.admission; this.admission = undefined; this.problem = reason
    if (admission) { clearTimeout(admission.timer); admission.controller.abort(new OwnershipError(409, 'ownership_lost', reason)) }
    this.host.fence()
  }
  private accept(input: unknown, started: number, sequence: number): OwnershipView {
    this.lifetime.signal.throwIfAborted()
    const view = OwnershipView.parse(input), floor = this.host.floor()
    if (view.coordinatorId !== this.config.coordinatorId || !view.resources.includes(this.config.resourceId))
      throw new OwnershipError(409, 'resource_mismatch', 'Ownership authority does not contain this resource scope')
    if (floor && (view.epoch < floor.epoch || view.epoch === floor.epoch && view.owner && floor.nonce && view.owner.nonce !== floor.nonce)) {
      if (sequence < this.applied) throw new OwnershipError(409, 'stale_observation', 'A newer ownership observation already superseded this response')
      throw new OwnershipError(409, 'authority_rollback', 'Ownership authority generation regressed or changed identity')
    }
    if (view.epoch < this.retiredEpoch || view.epoch === this.retiredEpoch && view.phase !== 'vacant')
      throw new OwnershipError(409, 'stale_observation', 'Delayed ownership observation cannot revive a retired owner')
    if (sequence < this.applied && view.phase === 'active' && view.owner && this.admission
      && sameOwner(view.owner, this.admission.guard.stamp) && !this.admission.guard.signal.aborted && this.admission.until > performance.now()) return view
    if (sequence < this.applied && view.phase !== 'vacant' && (!floor || view.epoch <= floor.epoch))
      throw new OwnershipError(409, 'stale_observation', 'A newer ownership observation already superseded this response')
    this.applied = Math.max(this.applied, sequence)
    if (!floor || view.epoch > floor.epoch || view.owner && !floor.nonce)
      this.host.remember({ epoch: view.epoch, ...(view.owner ? { nonce: view.owner.nonce } : {}) })
    if (view.phase === 'vacant') this.retiredEpoch = Math.max(this.retiredEpoch, view.epoch)
    if (view.phase !== 'active' || !view.owner || started + view.remainingMs <= performance.now()) {
      this.fence(view.phase === 'preparing' ? 'Draining work before ownership handoff' : 'Coordinator ownership is not active')
      return view
    }
    if (this.admission && !sameOwner(this.admission.guard.stamp, view.owner)) this.fence('Coordinator ownership changed')
    if (!this.admission) {
      this.host.fence(view.owner)
      if (!view.acknowledged.includes(this.config.resourceId) || !this.host.quiescent(view.owner)) {
        this.problem = 'Prior resource effects require quiescence or explicit reconciliation'; return view
      }
      const controller = new AbortController(), guard = { stamp: view.owner, signal: AbortSignal.any([controller.signal, this.lifetime.signal]) }
      this.admission = { guard, controller, until: 0, timer: setTimeout(() => {}, 0) }
    }
    const admission = this.admission
    clearTimeout(admission.timer); admission.until = started + view.remainingMs; this.problem = ''
    admission.timer = setTimeout(() => { if (this.admission === admission) this.fence('Coordinator lease observation expired') }, Math.max(0, admission.until - performance.now()))
    admission.timer.unref()
    return view
  }
  /** Every protected request proves its current owner; a rejected stale proof cannot cancel a different valid owner's work. */
  async authorize(proof: string | undefined): Promise<OwnershipGuard> {
    if (!proof) throw new OwnershipError(403, 'owner_required', 'Execution requires a current coordinator ownership proof')
    const started = performance.now(), sequence = ++this.observation
    try {
      const view = this.accept(await this.client.call({ op: 'lease.verify', proof }, this.lifetime.signal), started, sequence)
      const guard = this.admission?.guard
      if (!view.owner || !guard || !sameOwner(view.owner, guard.stamp) || guard.signal.aborted || this.admission!.until <= performance.now())
        throw new OwnershipError(409, 'resource_unavailable', this.problem)
      return guard
    } catch (error) {
      if (!(error instanceof OwnershipError) || error.status >= 500 || ['authority_rollback', 'authority_mismatch', 'resource_mismatch'].includes(error.code))
        this.fence('Ownership verification is unavailable')
      throw error
    }
  }
  /** Revalidate after awaited preparation and immediately before a process or file-effect boundary. */
  async verify(guard: OwnershipGuard): Promise<void> {
    guard.signal.throwIfAborted()
    const started = performance.now(), sequence = ++this.observation
    try {
      const view = this.accept(await this.client.call({ op: 'lease.inspect' }, this.lifetime.signal), started, sequence)
      guard.signal.throwIfAborted()
      if (view.phase !== 'active' || !view.owner || !sameOwner(view.owner, guard.stamp) || this.admission?.guard !== guard || this.admission.until <= performance.now())
        throw new OwnershipError(409, 'owner_superseded', 'This operation no longer belongs to the current coordinator')
    } catch (error) {
      if ((!this.admission || this.admission.guard === guard) && (!(error instanceof OwnershipError) || error.code !== 'stale_observation'))
        this.fence('Ownership revalidation failed')
      throw error
    }
  }
  /** Accepted but undispatched commands retain a non-secret owner stamp, never an execution credential. */
  async resume(stamp: OwnershipStamp | undefined): Promise<OwnershipGuard> {
    if (!stamp) throw new OwnershipError(409, 'owner_required', 'Unowned accepted work cannot resume under ownership fencing')
    await this.refresh()
    const guard = this.admission?.guard
    if (!guard || guard.signal.aborted || this.admission!.until <= performance.now() || !sameOwner(guard.stamp, stamp))
      throw new OwnershipError(409, 'owner_superseded', 'Accepted work belongs to a prior coordinator')
    return guard
  }
  refresh(): Promise<void> {
    if (this.refreshPending) return this.refreshPending
    const run = async () => {
      const started = performance.now(), sequence = ++this.observation
      const view = this.accept(await this.client.call({ op: 'lease.inspect' }, this.lifetime.signal), started, sequence)
      if (view.phase === 'preparing' && view.owner && this.host.quiescent()) {
        const requestId = createHash('sha256').update(JSON.stringify({ resource: this.config.resourceId, stamp: view.owner })).digest('hex')
        await this.client.call({ op: 'resource.acknowledge', requestId, stamp: view.owner }, this.lifetime.signal)
      }
    }
    const pending = run().catch(error => {
      if (!(error instanceof OwnershipError) || error.code !== 'stale_observation') this.fence('Ownership observation is unavailable')
      throw error
    }).finally(() => { if (this.refreshPending === pending) this.refreshPending = undefined })
    this.refreshPending = pending; return pending
  }
  close(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort(); if (this.poll) clearInterval(this.poll); this.fence('Ownership resource monitor stopped')
  }
}
