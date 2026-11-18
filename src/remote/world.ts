import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { RemoteClient, type RemoteConnection } from './client.ts'
import { inside } from './journal.ts'
import { RemoteError, Rpc, type EndpointIdentity, type GrantReceipt, type RemoteGrant, type RevocationReceipt, type EffectOwner } from './protocol.ts'
import { WorldJournal, worldBinding, type WorldRecord } from './world-journal.ts'
import { ownershipReady } from '../ownership/runtime.ts'
import { emptyRemoteExecutionEvidence, type RemoteExecutionEvidence } from '../supervision/execution-evidence.ts'
import { requiresOwnership } from '../ownership/protocol.ts'
import { RemoteCommandScope } from './subprocess.ts'

export interface RemoteWorldConfig extends RemoteConnection { stateDir: string }
export interface RemoteWorldStatus {
  endpointId: string; grantId: string; epoch: number; root: string; binding: string
  phase: WorldRecord['phase']; ready: boolean; leaseUntil?: number; checkedAt?: string; problem?: string
  effectsBlocked: number
  revocation?: { requestId: string; reason: string; acknowledged: boolean; quiescent: boolean }
}
declare module '@deepseek-ai/cordis' { interface Context { superagentRemoteWorld: RemoteWorld } }

/** Persistent coordinator-side authority for one paired Harness world; local revocation closes admission before RPC. */
export class RemoteWorld {
  private readonly journal: WorldJournal
  private readonly control: RemoteClient
  private readonly lifetime = new AbortController()
  private record?: WorldRecord
  private observed?: { grant: RemoteGrant; authorized: boolean }
  private checkedAt?: string
  private problem?: string
  private closed = false
  private timer?: ReturnType<typeof setInterval>
  private maintaining?: Promise<void>
  private commandScope?: RemoteCommandScope
  constructor(private readonly config: RemoteWorldConfig, private readonly expected?: { grant: RemoteGrant; credentialReader: () => string }) {
    if (!isAbsolute(config.stateDir) || !isAbsolute(config.credentialFile)) throw new Error('Remote world state and credential paths must be absolute')
    // Keep host-side receipt observation available after execution lifetime loss; close() still aborts all transport.
    this.control = new RemoteClient({ ...config, lifetime: this.lifetime.signal }, request => {
      if (requiresOwnership(request.op)) config.lifetime?.throwIfAborted()
    }, {
      prepare: request => request,
      observed: (request, value) => this.journal.effects.observed(request, value),
      failed: (request, error, ambiguous) => this.journal.effects.failed(request, error, ambiguous),
    }, expected?.credentialReader)
    if (expected) this.control.bindGrant(expected.grant)
    this.journal = new WorldJournal(config.stateDir, error => {
      this.problem = error.message; this.lifetime.abort(error)
    })
  }
  private get signal(): AbortSignal {
    return this.config.lifetime ? AbortSignal.any([this.lifetime.signal, this.config.lifetime]) : this.lifetime.signal
  }
  get grant(): RemoteGrant {
    if (!this.record) throw new Error('Remote world has not started')
    return structuredClone(this.record.grant)
  }
  get ownershipBinding() { return this.config.ownership && { authorityId: this.config.ownership.authorityId, coordinatorId: this.config.ownership.coordinatorId } }
  /** Public deployment paths and endpoint identity, without the ownership capability or credential contents. */
  configuration(): Pick<RemoteWorldConfig, 'url' | 'endpointId' | 'credentialFile' | 'stateDir'> {
    const { url, endpointId, credentialFile, stateDir } = this.config
    return { url, endpointId, credentialFile, stateDir }
  }
  /** Sibling Sessions share live command ownership; a restarted world always begins with an empty scope. */
  get commands(): RemoteCommandScope { return this.commandScope ??= new RemoteCommandScope(this.status().binding) }
  /** Initialize once, refusing endpoint/credential replacement before renewing or exposing execution providers. */
  async start(): Promise<void> {
    if (this.record || this.closed) throw new Error('Remote world cannot be started twice')
    const stored = this.journal.read()
    if (stored && this.expected && worldBinding(stored.endpointId, stored.grant) !== worldBinding(this.config.endpointId, this.expected.grant))
      throw new RemoteError(409, 'world_changed', 'The persisted world differs from the explicitly activated grant')
    if (stored) {
      if (stored.endpointId !== this.config.endpointId) throw new RemoteError(409, 'world_changed', 'Execution endpoint differs from the persisted world binding')
      this.control.bindGrant(stored.grant)
    }
    const identity = await this.control.call<EndpointIdentity>({ op: 'identity' })
    if (identity.protocol !== 1 || identity.confinement !== 'linux-bubblewrap') throw new Error('Remote world requires the supported confined endpoint protocol')
    if (!identity.capabilities.effectOwnership) throw new Error('Remote world requires endpoint effect-ownership receipts; update the endpoint first')
    if (!!identity.ownership !== !!this.config.ownership || identity.ownership && (identity.ownership.authorityId !== this.config.ownership?.authorityId
      || identity.ownership.coordinatorId !== this.config.ownership?.coordinatorId))
      throw new Error('Remote world and coordinator must use the same explicit ownership authority')
    const current = await this.control.call<{ grant: RemoteGrant; authorized: boolean }>({ op: 'grant.status' })
    if (this.expected && (!stored || current.authorized) && worldBinding(this.config.endpointId, current.grant) !== worldBinding(this.config.endpointId, this.expected.grant))
      throw new RemoteError(409, 'world_changed', 'The endpoint grant differs from the explicitly activated authority')
    if (current.grant.credentials?.length && !identity.capabilities.credentialBindings)
      throw new Error('Remote world requires endpoint credential-binding support; update the endpoint first')
    const root = stored?.grant.root ?? current.grant.root, state = realpathSync(this.config.stateDir)
    if (inside(root, state) || inside(state, root) || inside(root, realpathSync(this.config.credentialFile)))
      throw new Error('Coordinator world state and credentials must be outside the granted workspace')
    if (!stored) {
      if (!current.authorized) throw new Error('Remote execution grant is not authorized')
      if (!current.grant.operations.includes('fs.read') || !current.grant.operations.includes('process.spawn'))
        throw new Error('A paired remote world requires filesystem reads and process execution')
      this.control.bindGrant(current.grant)
      this.record = this.journal.bind(this.config.endpointId, current.grant)
    } else {
      // An obsolete credential may still inspect and cancel its own receipts. It never adopts the current generation.
      if (current.authorized) this.journal.bind(this.config.endpointId, current.grant)
      this.record = stored
    }
    this.observe(current)
    await this.refresh()
  }
  /** Start lease maintenance only after composition succeeded. Revocation recovery always precedes renewal. */
  maintain(report: (error: unknown) => void): void {
    if (!this.record || this.closed) throw new Error('Remote world is not open')
    if (this.timer) return
    this.timer = setInterval(() => { void this.refresh().catch(report) }, 60_000)
    this.timer.unref()
  }
  private observe(current: { grant: RemoteGrant; authorized: boolean }): void {
    const same = !!this.record && worldBinding(this.record.endpointId, this.record.grant) === worldBinding(this.config.endpointId, current.grant)
    this.observed = { grant: current.grant, authorized: current.authorized && same }
    this.checkedAt = new Date().toISOString()
    this.problem = this.observed.authorized ? undefined : 'Execution grant is revoked, expired or differs from the persisted world binding'
  }
  status(): RemoteWorldStatus {
    const record = this.record
    if (!record) throw new Error('Remote world has not started')
    const revocation = record.revocation, effectsBlocked = this.journal.effects.blocked()
    let ownerReady = true
    try { this.config.ownership?.proof() } catch { ownerReady = false }
    return { endpointId: record.endpointId, grantId: record.grant.id, epoch: record.grant.epoch, root: record.grant.root,
      binding: worldBinding(record.endpointId, record.grant), phase: record.phase,
      ready: ownerReady && !this.closed && !this.signal.aborted && record.phase === 'active' && !this.problem && !effectsBlocked
        && !!this.observed?.authorized && this.observed.grant.leaseUntil > Date.now(),
      leaseUntil: this.observed?.grant.epoch === record.grant.epoch ? this.observed.grant.leaseUntil : undefined,
      checkedAt: this.checkedAt, effectsBlocked, problem: !ownerReady ? 'Coordinator execution ownership is unavailable'
        : this.problem ?? (effectsBlocked ? `${effectsBlocked} remote effects require observation or reconciliation` : undefined),
      ...(revocation ? { revocation: { requestId: revocation.requestId, reason: revocation.reason,
        acknowledged: !!revocation.receipt, quiescent: revocation.receipt?.quiescent === true } } : {}) }
  }
  /** Worker services may continue observing/cancelling receipts after revocation, but cannot start new effects or file reads. */
  executionClient(): RemoteClient {
    if (!this.record) throw new Error('Remote world has not started')
    const client = new RemoteClient({ ...this.config, lifetime: this.signal }, request => {
      this.journal.effects.authorize(request)
      if ((request.op.startsWith('fs.') || request.op === 'job.spawn' || request.op === 'process.executable') && !this.status().ready)
        throw new RemoteError(409, 'world_unavailable', 'Remote execution world is unavailable or locally revoked')
      if (request.op.startsWith('grant.') && request.op !== 'grant.status')
        throw new RemoteError(403, 'control_only', 'Worker execution providers cannot change execution authority')
    }, {
      prepare: request => this.journal.effects.prepare(request, { world: this.status().binding, grantId: this.record!.grant.id, epoch: this.record!.grant.epoch,
        ...(this.config.ownership ? { ownershipCoordinatorId: this.config.ownership.coordinatorId } : {}) }),
      observed: (request, value) => this.journal.effects.observed(request, value),
      failed: (request, error, ambiguous) => this.journal.effects.failed(request, error, ambiguous),
    }, this.expected?.credentialReader)
    client.bindGrant(this.record.grant)
    return client
  }
  /** Serial maintenance preserves a single renewal/revocation stream; failures close local admission until a successful check. */
  refresh(): Promise<void> {
    if (this.closed || !this.record) return Promise.reject(new Error('Remote world is not open'))
    if (this.maintaining) return this.maintaining
    const run = async () => {
      if (this.record!.revocation && !this.signal.aborted && ownershipReady(this.config.ownership)) { await this.flushRevocation(); return }
      const current = await this.control.call<{ grant: RemoteGrant; authorized: boolean }>({ op: 'grant.status' })
      this.observe(current)
      // Dedicated providers are mounted before Runtime acquires its lease. Their read-only state remains inspectable.
      if (this.signal.aborted || !ownershipReady(this.config.ownership)) { await this.refreshEffects(); return }
      if (this.record!.revocation) { await this.flushRevocation(); return }
      // Receipt recovery must not cause a healthy grant to expire while an operator observes or cancels old work.
      if (!this.observed?.authorized || this.record!.phase !== 'active') { await this.refreshEffects(); return }
      if (current.grant.leaseUntil - Date.now() < 240_000) {
        const renewed = await this.control.intent<GrantReceipt>({ op: 'grant.renew', requestId: randomUUID(), revision: current.grant.revision, leaseMs: 300_000 })
        this.observe({ grant: renewed.grant, authorized: true })
      }
      if (this.record!.revocation) await this.flushRevocation()
      else await this.refreshEffects()
    }
    const pending = run().catch(error => { this.problem = error instanceof Error ? error.message : String(error); throw error })
      .finally(() => { if (this.maintaining === pending) this.maintaining = undefined })
    this.maintaining = pending
    return pending
  }
  /** Durable local denial survives offline restarts; replay the same request until the endpoint acknowledges it. No re-enable method exists. */
  requestRevocation(requestId: string, reason: string): void {
    if (this.closed || !this.record) throw new Error('Remote world is not open')
    const request = Rpc.parse({ op: 'grant.revoke', requestId, reason }) as Extract<ReturnType<typeof Rpc.parse>, { op: 'grant.revoke' }>
    this.record = this.journal.revoke(request.requestId, request.reason)
  }
  async revoke(requestId: string, reason: string): Promise<RemoteWorldStatus> {
    this.requestRevocation(requestId, reason)
    // A renewal already sent may complete, but no later renewal can be admitted. Its lease still has the endpoint's hard cap.
    await this.maintaining?.catch(() => {})
    await this.refresh()
    return this.status()
  }
  private async flushRevocation(): Promise<void> {
    const request = this.record!.revocation!
    if (request.receipt?.quiescent) {
      // A durable terminal receipt, including one recovered from the independent journal, already completed this intent.
      // Keep observation access without resending a completed administrative mutation after every restart.
      this.journal.effects.revoked(); this.problem = undefined; return
    }
    const receipt = await this.control.intent<RevocationReceipt>({ op: 'grant.revoke', requestId: request.requestId, reason: request.reason })
    this.journal.acknowledge(receipt); this.record = this.journal.read()!; this.problem = undefined
    if (receipt.quiescent) this.journal.effects.revoked()
  }
  /** Trusted host scope is captured at tool/assignment dispatch, never reconstructed from worker arguments or environment text. */
  withOwner<T>(owner: EffectOwner, authorize: () => void, operation: () => T): T { return this.journal.effects.run(owner, authorize, operation) }
  effects(ticketId?: string, offset = 0, limit = 50) { return this.journal.effects.list(ticketId, offset, limit) }
  /** Original-ID host observation without a paginated search or a replacement dispatch. */
  executionReceipt(id: string) { return this.journal.effects.get(id) }
  /** Read saved exact-assignment receipts without consulting the endpoint or refreshing polling timestamps. */
  executionEvidence(ticketId: string, assignmentId: string, expectedWorld: string): RemoteExecutionEvidence {
    return this.record && !this.closed && worldBinding(this.record.endpointId, this.record.grant) === expectedWorld
      ? this.journal.effects.executionEvidence(ticketId, assignmentId, expectedWorld)
      : emptyRemoteExecutionEvidence()
  }
  quiescent(ticketId: string): boolean { return this.journal.effects.quiescent(ticketId) }
  /** Bounded read-only reconciliation; missing or conflicting receipts remain unknown, without automatic replacement dispatch. */
  async refreshEffects(): Promise<void> {
    if (this.closed) return
    await Promise.all(this.journal.effects.pending(16).map(async record => {
      const request = { op: record.kind === 'command' ? 'job.get' as const : 'operation.get' as const, id: record.id }
      try { await this.control.call(request) } catch (error) { this.journal.effects.failed(request, error, true) }
    }))
  }
  async cancelEffect(ticketId: string | undefined, id: string, requestId: string): Promise<void> {
    const record = this.journal.effects.get(id)
    if (!record || ticketId !== undefined && (record.owner.kind !== 'assignment' || record.owner.ticketId !== ticketId))
      throw new RemoteError(404, 'not_found', 'Execution receipt does not belong to this mission task')
    if (record.kind !== 'command') throw new RemoteError(409, 'not_cancellable', 'File mutations require observation or endpoint reconciliation')
    await this.control.intent({ op: 'job.cancel', id, requestId })
    await this.refreshEffects()
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; if (this.timer) clearInterval(this.timer)
    this.lifetime.abort(); await this.maintaining?.catch(() => {})
    this.journal.close()
  }
}
