import { AsyncLocalStorage } from 'node:async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { fingerprint, timestamp } from './journal.ts'
import { EffectOwner, RemoteError, Rpc, type RpcInput, type RemoteJob, type RemoteOperation } from './protocol.ts'

export interface ExecutionReceipt {
  id: string; world: string; grantId: string; epoch: number; fingerprint: string; owner: EffectOwner
  kind: 'command' | 'mutation'; operation: 'job.spawn' | 'fs.write' | 'fs.edit'; target: string; program?: string
  phase: 'pending' | 'accepted' | 'started' | 'settled' | 'refused' | 'unknown'; quiescent: boolean | null
  createdAt: string; updatedAt: string; observedAt?: string; problem?: string; recovered?: true
  outcome?: RemoteJob['outcome']; reconciled?: { at: string; note: string }
}
export interface ExecutionReceiptPage { items: ExecutionReceipt[]; total: number; nextOffset: number | null }
type Authority = { world: string; grantId: string; epoch: number }
const effect = (request: RpcInput) => request.op === 'job.spawn' || request.op === 'fs.write' || request.op === 'fs.edit'
const receiptId = (request: RpcInput): string | undefined => effect(request) && 'requestId' in request ? request.requestId
  : ['job.get', 'job.cancel', 'job.reconcile', 'operation.get', 'operation.reconcile'].includes(request.op) && 'id' in request ? request.id : undefined

/** Durable effect ownership before dispatch; recovery observes the original ID and never replays an effect automatically. */
export class ExecutionEffects {
  private readonly scope = new AsyncLocalStorage<{ owner: EffectOwner; authorize: () => void }>()
  private closed = false
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS execution_effect (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS execution_effect_ticket ON execution_effect(json_extract(value, '$.owner.ticketId'));
      CREATE INDEX IF NOT EXISTS execution_effect_time ON execution_effect(json_extract(value, '$.createdAt'));`)
    for (const record of this.pending()) {
      record.phase = 'unknown'; record.recovered = true; record.problem = 'Coordinator restarted before the effect was confirmed stopped'
      this.save(record)
    }
  }
  run<T>(owner: EffectOwner, authorize: () => void, operation: () => T): T {
    const trusted = EffectOwner.parse(owner)
    authorize()
    return this.scope.run({ owner: trusted, authorize }, operation)
  }
  authorize(request: RpcInput): void { if (effect(request)) this.scope.getStore()?.authorize() }
  get(id: string): ExecutionReceipt | undefined {
    const row = this.db.prepare('SELECT value FROM execution_effect WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as ExecutionReceipt : undefined
  }
  private save(value: ExecutionReceipt): void {
    if (this.closed) return
    value.updatedAt = timestamp()
    this.db.prepare('INSERT INTO execution_effect VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value))
  }
  list(ticketId?: string, offset = 0, limit = 50): ExecutionReceiptPage {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid receipt page')
    const where = ticketId === undefined ? '' : " WHERE json_extract(value, '$.owner.ticketId')=?", args = ticketId === undefined ? [] : [ticketId]
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM execution_effect${where}`).get(...args)!.n)
    const items = this.db.prepare(`SELECT value FROM execution_effect${where} ORDER BY json_extract(value, '$.createdAt') DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset).map(row => JSON.parse(String(row.value)) as ExecutionReceipt)
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null }
  }
  pending(limit?: number): ExecutionReceipt[] {
    const sql = "SELECT value FROM execution_effect WHERE json_extract(value, '$.quiescent') IS NOT 1 ORDER BY coalesce(json_extract(value, '$.observedAt'), ''), id"
    return (limit === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql + ' LIMIT ?').all(limit)).map(row => JSON.parse(String(row.value)) as ExecutionReceipt)
  }
  blocked(): number {
    return Number(this.db.prepare(`SELECT count(*) AS n FROM execution_effect WHERE json_extract(value, '$.quiescent') IS NOT 1
      AND (json_extract(value, '$.phase')='unknown' OR json_extract(value, '$.recovered')=1)`).get()!.n)
  }
  prepare<T extends RpcInput & { requestId: string }>(request: T, authority: Authority): T {
    if (!effect(request)) return request
    if (this.closed) throw new Error('Execution receipt journal is closed')
    const scope = this.scope.getStore(); scope?.authorize()
    if (this.blocked()) throw new RemoteError(409, 'effects_unresolved', 'Remote effects require observation or reconciliation before new execution')
    const owner = scope?.owner ?? { kind: 'host' as const, purpose: 'profile-maintenance' }
    // Caller arguments, environment variables and shell source cannot supply or override this ownership.
    const prepared = Rpc.parse({ ...request, owner }) as T
    const digest = fingerprint({ principal: { role: 'grant', id: authority.grantId, epoch: authority.epoch }, request: prepared })
    const existing = this.get(request.requestId)
    if (existing) {
      if (existing.fingerprint !== digest || existing.world !== authority.world) throw new RemoteError(409, 'effect_conflict', 'Effect ID already belongs to another request or execution world')
      return prepared
    }
    const at = timestamp(), operation = prepared as Extract<RpcInput, { op: 'job.spawn' | 'fs.write' | 'fs.edit' }>
    this.save({ ...authority, id: request.requestId, fingerprint: digest, owner, kind: operation.op === 'job.spawn' ? 'command' : 'mutation',
      operation: operation.op, target: operation.op === 'job.spawn' ? operation.cwd : operation.path,
      ...(operation.op === 'job.spawn' ? { program: operation.argv[0] } : {}), phase: 'pending', quiescent: null, createdAt: at, updatedAt: at })
    return prepared
  }
  observed(request: RpcInput, value: unknown): void {
    if (this.closed) return
    const id = receiptId(request), record = id && this.get(id)
    if (!record) return // Never invent attribution for legacy/unowned endpoint work.
    const remote = value as RemoteJob | RemoteOperation
    const owner = record.kind === 'command' ? (remote as RemoteJob)?.request?.owner : (remote as RemoteOperation)?.owner
    if (!remote || remote.id !== record.id || remote.grantId !== record.grantId || remote.epoch !== record.epoch
      || remote.fingerprint !== record.fingerprint || !owner || fingerprint(owner) !== fingerprint(record.owner)) {
      record.phase = 'unknown'; record.quiescent = null; record.problem = 'Endpoint receipt does not match the saved effect ownership and request'
      this.save(record); throw new RemoteError(409, 'receipt_mismatch', record.problem)
    }
    if (!['accepted', 'started', 'settled', 'unknown'].includes(remote.phase)) throw new Error('Invalid endpoint effect phase')
    if (record.quiescent === true) return // A late in-flight observation cannot undo confirmed quiescence.
    record.phase = remote.phase; record.observedAt = timestamp(); record.reconciled = remote.reconciled
    if (record.kind === 'command') {
      const job = remote as RemoteJob
      record.quiescent = job.quiescent; record.outcome = job.outcome; record.problem = job.error
    } else {
      const mutation = remote as RemoteOperation
      record.quiescent = mutation.phase === 'settled' || !!mutation.reconciled; record.problem = mutation.error?.message
    }
    this.save(record)
  }
  failed(request: RpcInput, error: unknown, ambiguous: boolean): void {
    if (this.closed) return
    const id = receiptId(request), record = id && this.get(id)
    if (!record || record.quiescent === true) return
    const refused = !ambiguous && !record.recovered && record.phase === 'pending' && error instanceof RemoteError
      && error.status < 500 && !['request_conflict', 'receipt_mismatch', 'endpoint_mismatch'].includes(error.code)
    record.phase = refused ? 'refused' : 'unknown'; record.quiescent = refused ? true : null
    record.observedAt = timestamp(); record.problem = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
    this.save(record)
  }
  /** An acknowledged, quiescent whole-grant revocation fences even a late request whose receipt cannot be located. */
  revoked(): void {
    for (const record of this.pending()) {
      record.phase = 'unknown'; record.quiescent = true
      record.problem = 'Grant revocation confirms execution stopped; this effect outcome remains unknown'
      this.save(record)
    }
  }
  close(): void { this.closed = true }
}
