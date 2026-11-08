/** Independent ownership authority: a single durable writer, monotonic live deadlines, and a resource-drain barrier. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { privateCredential, privateDirectory, privateFile } from '../environments/endpoint-files.ts'
import { OwnershipError, OwnershipRequest, type OwnershipPrincipal, type OwnershipStamp, type OwnershipView, type OwnershipEnrollment } from './protocol.ts'

interface Coordinator {
  id: string; epoch: number; resources: string[]
  owner?: { stamp: OwnershipStamp; phase: 'preparing' | 'active'; expiresAt: string }
  acknowledged: string[]
}
interface Clock { monotonic(): number; wall(): number }
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const secret = (file: string) => {
  try { return privateCredential(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  privateFile(file, randomBytes(32).toString('base64url')); return privateCredential(file)
}

/** A lease is executable only after every enrolled resource acknowledges the exact new owner after draining prior work. */
export class OwnershipAuthority {
  readonly id: string
  private readonly db: DatabaseSync
  private readonly signing: string
  private readonly adminCredential: string
  private readonly release: () => void
  private readonly deadlines = new Map<string, { nonce: string; until: number }>()
  private closed = false
  private disposed = false
  constructor(directory: string, private readonly clock: Clock = { monotonic: () => performance.now(), wall: () => Date.now() }) {
    const root = privateDirectory(directory)
    this.release = lockSync(root, { stale: 30_000, onCompromised: () => { this.closed = true; this.deadlines.clear() } })
    let opened: DatabaseSync | undefined
    try {
      this.signing = secret(join(root, 'signing.key')); this.adminCredential = secret(join(root, 'admin.token'))
      this.db = opened = new DatabaseSync(join(root, 'ownership.sqlite')); chmodSync(join(root, 'ownership.sqlite'), 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS ownership_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS coordinator_owner (id TEXT PRIMARY KEY,value TEXT NOT NULL);'
        + 'CREATE TABLE IF NOT EXISTS ownership_intent (id TEXT PRIMARY KEY,digest TEXT NOT NULL,value TEXT NOT NULL);')
      this.db.prepare('INSERT OR IGNORE INTO ownership_meta VALUES (?,?)').run('id', randomUUID())
      this.id = String(this.db.prepare('SELECT value FROM ownership_meta WHERE key=?').get('id')!.value)
      // No monotonic deadline survives this process. Persist the invalidation before serving any inspection or acquisition.
      this.atomic(() => {
        for (const row of this.db.prepare('SELECT value FROM coordinator_owner').all()) {
          const coordinator = JSON.parse(String(row.value)) as Coordinator
          delete coordinator.owner; coordinator.acknowledged = []; this.save(coordinator)
        }
      })
    } catch (error) { opened?.close(); this.release(); throw error }
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = operation(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private get(id: string): Coordinator {
    const row = this.db.prepare('SELECT value FROM coordinator_owner WHERE id=?').get(id)
    if (!row) throw new OwnershipError(404, 'not_found', 'Coordinator identity is not enrolled')
    return JSON.parse(String(row.value)) as Coordinator
  }
  private save(value: Coordinator): void {
    this.db.prepare('INSERT INTO coordinator_owner VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value))
  }
  private sign(body: string): string { return body + '.' + createHmac('sha256', this.signing).update(body).digest('base64url') }
  private credential(stamp: OwnershipStamp): string { return this.sign(['lease', stamp.coordinatorId, stamp.epoch, stamp.nonce, stamp.instanceId].join('.')) }
  authenticate(header: string | undefined): OwnershipPrincipal {
    if (this.closed) throw new OwnershipError(503, 'unavailable', 'Ownership authority is unavailable')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    if (same(token, this.adminCredential)) return { role: 'admin' }
    const parts = token.split('.'), signature = parts.pop()
    if (!signature || !same(token, this.sign(parts.join('.')))) throw new OwnershipError(401, 'unauthorized', 'Ownership credential required')
    const [role, coordinatorId, a, b, c] = parts
    if (!coordinatorId || !/^[a-zA-Z0-9_-]{1,100}$/.test(coordinatorId)) throw new OwnershipError(401, 'unauthorized', 'Invalid ownership credential')
    const coordinator = this.get(coordinatorId)
    if (role === 'claim' && parts.length === 2) return { role: 'claimant', coordinatorId }
    if (role === 'resource' && parts.length === 3 && coordinator.resources.includes(a!)) return { role: 'resource', coordinatorId, resourceId: a! }
    if (role === 'lease' && parts.length === 5 && Number.isSafeInteger(Number(a)) && Number(a) > 0)
      return { role: 'lease', coordinatorId, epoch: Number(a), nonce: b!, instanceId: c! }
    throw new OwnershipError(401, 'unauthorized', 'Invalid ownership credential')
  }
  private remaining(coordinator: Coordinator): number {
    const entry = this.deadlines.get(coordinator.id)
    return coordinator.owner && entry?.nonce === coordinator.owner.stamp.nonce ? Math.max(0, Math.floor(entry.until - this.clock.monotonic())) : 0
  }
  private view(coordinator: Coordinator): OwnershipView {
    const remainingMs = this.remaining(coordinator)
    return { coordinatorId: coordinator.id, epoch: coordinator.epoch, phase: remainingMs ? coordinator.owner!.phase : 'vacant', remainingMs,
      ...(remainingMs ? { owner: coordinator.owner!.stamp } : {}), resources: coordinator.resources,
      acknowledged: remainingMs ? coordinator.acknowledged : [] }
  }
  private current(principal: OwnershipPrincipal): Coordinator {
    if (principal.role !== 'lease') throw new OwnershipError(403, 'lease_required', 'Current owner lease required')
    const coordinator = this.get(principal.coordinatorId), owner = coordinator.owner?.stamp
    if (!this.remaining(coordinator) || !owner || owner.epoch !== principal.epoch || owner.nonce !== principal.nonce || owner.instanceId !== principal.instanceId)
      throw new OwnershipError(409, 'owner_superseded', 'Owner lease has expired, been released, or been superseded')
    return coordinator
  }
  private enrollment(coordinator: Coordinator): OwnershipEnrollment {
    return { coordinatorId: coordinator.id, credential: this.sign('claim.' + coordinator.id),
      resources: coordinator.resources.map(id => ({ id, credential: this.sign('resource.' + coordinator.id + '.' + id) })) }
  }
  private replay(principal: OwnershipPrincipal, request: OwnershipRequest & { requestId: string }): { value: unknown } | undefined {
    const id = digest({ principal, requestId: request.requestId }), fingerprint = digest(request)
    const existing = this.db.prepare('SELECT digest,value FROM ownership_intent WHERE id=?').get(id)
    if (existing) {
      if (existing.digest !== fingerprint) throw new OwnershipError(409, 'request_conflict', 'Ownership request ID already has a different payload')
      return { value: JSON.parse(String(existing.value)) }
    }
  }
  /** Store only authority identities in intent receipts; derive secrets in memory for the authorized caller. */
  private intent<T>(principal: OwnershipPrincipal, request: OwnershipRequest & { requestId: string }, operation: () => T): T {
    const replay = this.replay(principal, request)
    if (replay) return replay.value as T
    const id = digest({ principal, requestId: request.requestId }), fingerprint = digest(request)
    return this.atomic(() => {
      const result = operation()
      this.db.prepare('INSERT INTO ownership_intent VALUES (?,?,?)').run(id, fingerprint, JSON.stringify(result))
      return result
    })
  }
  rpc(principal: OwnershipPrincipal, input: unknown): unknown {
    if (this.closed) throw new OwnershipError(503, 'unavailable', 'Ownership authority is unavailable')
    const request = OwnershipRequest.parse(input)
    if (request.op === 'identity') return { id: this.id, protocol: 1 }
    if (request.op === 'coordinator.create') {
      if (principal.role !== 'admin') throw new OwnershipError(403, 'admin_required', 'Ownership administration required')
      const id = this.intent(principal, request, () => {
        if (this.db.prepare('SELECT 1 FROM coordinator_owner WHERE id=?').get(request.id)) throw new OwnershipError(409, 'already_enrolled', 'Coordinator identity already exists')
        this.save({ id: request.id, epoch: 0, resources: [...new Set(request.resources)].sort(), acknowledged: [] }); return request.id
      })
      return this.enrollment(this.get(id))
    }
    if (request.op === 'resources.add') {
      if (principal.role !== 'admin') throw new OwnershipError(403, 'admin_required', 'Ownership administration required')
      const id = this.intent(principal, request, () => {
        const coordinator = this.get(request.id)
        if (this.remaining(coordinator) || coordinator.epoch !== request.epoch) throw new OwnershipError(409, 'owner_busy', 'Add resources only while ownership is vacant at the expected generation')
        coordinator.resources = [...new Set([...coordinator.resources, ...request.resources])].sort()
        if (coordinator.resources.length > 256) throw new OwnershipError(409, 'resource_limit', 'Coordinator resource limit exceeded')
        this.save(coordinator); return coordinator.id
      })
      return this.enrollment(this.get(id))
    }
    if (request.op === 'lease.acquire') {
      if (principal.role !== 'claimant') throw new OwnershipError(403, 'claimant_required', 'Coordinator acquisition credential required')
      let created = false
      const stamp = this.intent(principal, request, () => {
        const coordinator = this.get(principal.coordinatorId)
        if (this.remaining(coordinator)) throw new OwnershipError(409, 'owner_busy', 'Another coordinator instance owns this identity')
        if (coordinator.epoch >= Number.MAX_SAFE_INTEGER) throw new OwnershipError(409, 'epoch_exhausted', 'Ownership generation exhausted')
        const stamp: OwnershipStamp = { coordinatorId: coordinator.id, epoch: ++coordinator.epoch, nonce: randomUUID(), instanceId: request.instanceId }
        coordinator.owner = { stamp, phase: 'preparing', expiresAt: new Date(this.clock.wall() + request.leaseMs).toISOString() }
        coordinator.acknowledged = []; this.save(coordinator); created = true; return stamp
      })
      if (created) this.deadlines.set(stamp.coordinatorId, { nonce: stamp.nonce, until: this.clock.monotonic() + request.leaseMs })
      const coordinator = this.current({ role: 'lease', ...stamp })
      return { lease: this.view(coordinator), credential: this.credential(stamp) }
    }
    if (request.op === 'lease.inspect') {
      if (principal.role === 'admin') throw new OwnershipError(403, 'scope_required', 'Use the coordinator or resource credential for scoped inspection')
      return this.view(this.get(principal.coordinatorId))
    }
    if (request.op === 'lease.verify') {
      if (principal.role !== 'resource') throw new OwnershipError(403, 'resource_required', 'Resource verification credential required')
      const owner = this.authenticate('Bearer ' + request.proof)
      if (owner.role !== 'lease' || owner.coordinatorId !== principal.coordinatorId) throw new OwnershipError(403, 'owner_mismatch', 'Lease does not own this resource')
      const coordinator = this.current(owner)
      if (coordinator.owner!.phase !== 'active') throw new OwnershipError(409, 'fencing_required', 'Resources must drain prior work before execution')
      return this.view(coordinator)
    }
    if (request.op === 'resource.acknowledge') {
      if (principal.role !== 'resource' || request.stamp.coordinatorId !== principal.coordinatorId)
        throw new OwnershipError(403, 'resource_required', 'A resource may acknowledge only its own coordinator')
      const coordinator = this.current({ role: 'lease', ...request.stamp })
      if (coordinator.owner!.phase !== 'preparing' && !coordinator.acknowledged.includes(principal.resourceId))
        throw new OwnershipError(409, 'fencing_phase', 'Cannot add a fencing acknowledgement to active ownership')
      this.intent(principal, request, () => {
        if (!coordinator.acknowledged.includes(principal.resourceId)) coordinator.acknowledged.push(principal.resourceId)
        this.save(coordinator); return true
      })
      return this.view(this.get(coordinator.id))
    }
    if (request.op === 'lease.release' && principal.role === 'lease' && this.replay(principal, request))
      return this.view(this.get(principal.coordinatorId))
    const coordinator = this.current(principal)
    if (request.op === 'lease.renew') {
      let renewed = false
      this.intent(principal, request, () => {
        coordinator.owner!.expiresAt = new Date(this.clock.wall() + request.leaseMs).toISOString(); this.save(coordinator); renewed = true; return true
      })
      if (renewed) this.deadlines.set(coordinator.id, { nonce: coordinator.owner!.stamp.nonce, until: this.clock.monotonic() + request.leaseMs })
    } else if (request.op === 'lease.activate') {
      this.intent(principal, request, () => {
        if (!coordinator.resources.every(id => coordinator.acknowledged.includes(id))) throw new OwnershipError(409, 'fencing_required', 'All enrolled resources must acknowledge this exact owner before activation')
        coordinator.owner!.phase = 'active'; this.save(coordinator); return true
      })
    } else if (request.op === 'lease.release') {
      this.intent(principal, request, () => { delete coordinator.owner; coordinator.acknowledged = []; this.save(coordinator); return true })
      this.deadlines.delete(coordinator.id)
    }
    return this.view(this.get(coordinator.id))
  }
  close(): void {
    if (this.disposed) return
    this.disposed = this.closed = true; this.deadlines.clear()
    try { this.db.close() } finally { this.release() }
  }
}
