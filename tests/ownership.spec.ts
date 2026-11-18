import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { OwnershipAuthority } from '../src/ownership/authority.ts'
import { OwnershipClient } from '../src/ownership/client.ts'
import { ownershipHandler } from '../src/ownership/http.ts'
import type { OwnershipClaim, OwnershipEnrollment, OwnershipView, RecoveryClaim } from '../src/ownership/protocol.ts'
import { remoteFixture } from './fixtures/remote.ts'
import { RemoteClient } from '../src/remote/client.ts'
import type { RemoteJob } from '../src/remote/protocol.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { RemoteWorld } from '../src/remote/world.ts'
import { RemoteEndpoint } from '../src/remote/endpoint.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const rid = () => randomUUID()
async function fixture(resources = ['endpoint-a', 'endpoint-b']) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ownership-')))
  let tick = 100, wall = Date.now(), offline = false, authority = new OwnershipAuthority(directory, { monotonic: () => tick, wall: () => wall })
  const server = createServer((req, res) => { if (offline) { res.destroy(); return }; void ownershipHandler(authority)(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const connection = { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, authorityId: authority.id, credentialFile: join(directory, 'admin.token') }
  const admin = new OwnershipClient(connection)
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); authority.close(); await rm(directory, { recursive: true, force: true }) })
  const enrolled = await admin.call<OwnershipEnrollment>({ op: 'coordinator.create', requestId: rid(), id: 'coordinator', resources })
  const claimant = admin.withCredential(enrolled.credential)
  const participants = enrolled.resources.map(resource => ({ id: resource.id, client: admin.withCredential(resource.credential) }))
  const acquire = (requestId = rid(), instanceId = rid(), leaseMs = 5000) => claimant.call<OwnershipClaim>({ op: 'lease.acquire', requestId, instanceId, leaseMs })
  const acknowledge = (claim: OwnershipClaim) => Promise.all(participants.map(resource => resource.client.call<OwnershipView>({
    op: 'resource.acknowledge', requestId: rid(), stamp: claim.lease.owner!,
  })))
  return { directory, admin, claimant, participants, acquire, acknowledge, connection, enrolled,
    advance: (elapsed: number) => { tick += elapsed; wall += elapsed },
    wall: (elapsed: number) => { wall += elapsed },
    offline: (value: boolean) => { offline = value },
    restart: () => { authority.close(); authority = new OwnershipAuthority(directory, { monotonic: () => tick, wall: () => wall }) },
  }
}

it('elects one writer over real HTTP and requires every resource to fence its exact generation', async () => {
  const h = await fixture(), contenders = await Promise.allSettled([h.acquire(), h.acquire()])
  expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const claim = (contenders.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<OwnershipClaim>).value
  expect(claim.lease).toMatchObject({ phase: 'preparing', epoch: 1, acknowledged: [] })
  const owner = h.admin.withCredential(claim.credential)
  await expect(owner.call({ op: 'lease.activate', requestId: rid() })).rejects.toThrow('All enrolled resources')
  await expect(h.participants[0]!.client.call({ op: 'lease.verify', proof: claim.credential })).rejects.toThrow('drain prior work')
  await h.participants[0]!.client.call({ op: 'resource.acknowledge', requestId: rid(), stamp: claim.lease.owner! })
  await expect(owner.call({ op: 'lease.activate', requestId: rid() })).rejects.toThrow('All enrolled resources')
  await h.participants[1]!.client.call({ op: 'resource.acknowledge', requestId: rid(), stamp: claim.lease.owner! })
  expect(await owner.call({ op: 'lease.activate', requestId: rid() })).toMatchObject({ phase: 'active' })
  expect(await h.participants[0]!.client.call({ op: 'lease.verify', proof: claim.credential })).toMatchObject({ phase: 'active', owner: claim.lease.owner })
  await expect(h.acquire()).rejects.toThrow('Another coordinator')
})

it('reserves recovery only at the reviewed vacant epoch, invalidates the old claimant and retains the resource barrier', async () => {
  const h = await fixture(), original = await h.acquire(), owner = h.admin.withCredential(original.credential)
  const request = { op: 'coordinator.recover' as const, requestId: rid(), id: 'coordinator', epoch: 1, generation: 0,
    selection: { checkpoint: rid(), digest: 'a'.repeat(64) } }
  await expect(h.claimant.call(request)).rejects.toThrow('independent ownership administration')
  await expect(h.admin.call(request)).rejects.toThrow('vacant ownership')
  await owner.call({ op: 'lease.release', requestId: rid() })
  await expect(h.admin.call({ ...request, epoch: 0 })).rejects.toThrow('reviewed epoch')
  const reserved = await h.admin.call<RecoveryClaim>(request)
  expect(reserved.recovery).toEqual({ ...request.selection, generation: 1 })
  await expect(h.acquire()).rejects.toThrow('replaced by a recovery reservation')
  const replacement = await h.admin.withCredential(reserved.credential).call<OwnershipClaim>({ op: 'lease.acquire', requestId: rid(), instanceId: rid(), leaseMs: 5000 })
  expect(replacement.lease).toMatchObject({ phase: 'preparing', epoch: 2, recovery: reserved.recovery, acknowledged: [] })
  const successor = h.admin.withCredential(replacement.credential)
  await expect(successor.call({ op: 'lease.activate', requestId: rid() })).rejects.toThrow('All enrolled resources')
  await h.acknowledge(replacement)
  expect(await successor.call({ op: 'lease.activate', requestId: rid() })).toMatchObject({ phase: 'active', recovery: reserved.recovery })
  await expect(h.participants[0]!.client.call({ op: 'lease.verify', proof: original.credential })).rejects.toThrow('superseded')
})

it('recovers original reservation credentials after response loss or authority restart without adopting a later selection', async () => {
  const h = await fixture(), request = { op: 'coordinator.recover' as const, requestId: rid(), id: 'coordinator', epoch: 0, generation: 0,
    selection: { checkpoint: rid(), digest: 'b'.repeat(64) } }
  const first = await h.admin.call<RecoveryClaim>(request)
  h.restart(); expect(await h.admin.call(request)).toEqual(first)
  await expect(h.admin.call({ ...request, selection: { ...request.selection, checkpoint: rid() } })).rejects.toThrow('different payload')
  const second = await h.admin.call<RecoveryClaim>({ ...request, requestId: rid(), generation: 1, selection: { checkpoint: rid(), digest: 'c'.repeat(64) } })
  expect(second.recovery.generation).toBe(2); expect(await h.admin.call(request)).toEqual(first)
  await expect(h.admin.withCredential(first.credential).call({ op: 'lease.acquire', requestId: rid(), instanceId: rid(), leaseMs: 5000 })).rejects.toThrow('replaced')
  expect(await h.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })).toMatchObject({ phase: 'vacant', recovery: second.recovery })
  await expect(h.participants[0]!.client.call({ op: 'coordinator.inspect', id: 'coordinator' })).rejects.toThrow('administration')
})

it('proves the original recovery claimant through a read-only operation that refuses other credential roles', async () => {
  const h = await fixture()
  await expect(h.claimant.call({ op: 'recovery.claimant' })).rejects.toThrow('original recovery')
  const request = { op: 'coordinator.recover' as const, requestId: rid(), id: 'coordinator', epoch: 0, generation: 0,
    selection: { checkpoint: rid(), digest: 'd'.repeat(64) } }
  const reserved = await h.admin.call<RecoveryClaim>(request), claimant = h.admin.withCredential(reserved.credential)
  const before = await h.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })
  expect(await claimant.call({ op: 'recovery.claimant' })).toEqual(before)
  for (const client of [h.admin, h.participants[0]!.client]) await expect(client.call({ op: 'recovery.claimant' })).rejects.toThrow('acquisition credential')
  await expect(h.claimant.call({ op: 'recovery.claimant' })).rejects.toThrow('replaced')
  expect(await h.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })).toEqual(before)
  const newer = await h.admin.call<RecoveryClaim>({ ...request, requestId: rid(), generation: 1, selection: { checkpoint: rid(), digest: 'e'.repeat(64) } })
  await expect(claimant.call({ op: 'recovery.claimant' })).rejects.toThrow('replaced')
  expect(await h.admin.withCredential(newer.credential).call({ op: 'recovery.claimant' })).toMatchObject({ phase: 'vacant', epoch: 0, recovery: newer.recovery })
})

it('keeps acquisition and renewal retries idempotent and rejects stale proofs without widening workspace authority', async () => {
  const h = await fixture(), requestId = rid(), instanceId = rid(), claim = await h.acquire(requestId, instanceId), owner = h.admin.withCredential(claim.credential)
  expect((await h.acquire(requestId, instanceId)).credential).toBe(claim.credential)
  await expect(h.acquire(requestId, rid())).rejects.toThrow('different payload')
  await h.acknowledge(claim); await owner.call({ op: 'lease.activate', requestId: rid() })
  const renew = { op: 'lease.renew' as const, requestId: rid(), leaseMs: 5000 }
  h.advance(1000); await owner.call(renew); h.advance(1500)
  expect(await owner.call(renew)).toMatchObject({ remainingMs: 3500 })
  h.wall(-86_400_000)
  expect(await owner.call({ op: 'lease.inspect' })).toMatchObject({ phase: 'active', remainingMs: 3500 })
  h.advance(3501)
  await expect(owner.call({ op: 'lease.renew', requestId: rid(), leaseMs: 5000 })).rejects.toThrow('expired')
  const replacement = await h.acquire()
  expect(replacement.lease.epoch).toBe(2)
  await expect(h.participants[0]!.client.call({ op: 'lease.verify', proof: claim.credential })).rejects.toThrow('expired')
  await expect(h.participants[0]!.client.call({ op: 'resource.acknowledge', requestId: rid(), stamp: claim.lease.owner! })).rejects.toThrow('superseded')
  await expect(h.acquire(requestId, instanceId)).rejects.toThrow('superseded')
})

it('invalidates all leases on authority restart while preserving generations, scope and durable intent conflicts', async () => {
  const h = await fixture(), claim = await h.acquire(), owner = h.admin.withCredential(claim.credential)
  await h.acknowledge(claim); await owner.call({ op: 'lease.activate', requestId: rid() })
  h.restart()
  expect(await h.claimant.call({ op: 'lease.inspect' })).toMatchObject({ epoch: 1, phase: 'vacant' })
  await expect(h.participants[0]!.client.call({ op: 'lease.verify', proof: claim.credential })).rejects.toThrow('expired')
  const replacement = await h.acquire(); expect(replacement.lease).toMatchObject({ epoch: 2, phase: 'preparing', acknowledged: [] })
  await expect(h.participants[0]!.client.call({ op: 'lease.acquire', requestId: rid(), instanceId: rid(), leaseMs: 5000 })).rejects.toThrow('acquisition credential')
  await expect(h.claimant.call({ op: 'resource.acknowledge', requestId: rid(), stamp: replacement.lease.owner! })).rejects.toThrow('resource may acknowledge')
  const other = await h.admin.call<OwnershipEnrollment>({ op: 'coordinator.create', requestId: rid(), id: 'another', resources: ['endpoint-a'] })
  await expect(h.admin.withCredential(other.resources[0]!.credential).call({ op: 'lease.verify', proof: replacement.credential })).rejects.toThrow('does not own')
})

it('replays a release without affecting a newer owner and permits only additive enrollment while vacant', async () => {
  const h = await fixture(), claim = await h.acquire(), owner = h.admin.withCredential(claim.credential)
  await expect(h.admin.call({ op: 'resources.add', requestId: rid(), id: 'coordinator', epoch: 1, resources: ['endpoint-c'] })).rejects.toThrow('vacant')
  const release = { op: 'lease.release' as const, requestId: rid() }
  expect(await owner.call(release)).toMatchObject({ phase: 'vacant' })
  const enrollment = await h.admin.call<OwnershipEnrollment>({ op: 'resources.add', requestId: rid(), id: 'coordinator', epoch: 1, resources: ['endpoint-c'] })
  expect(enrollment.resources.map(resource => resource.id)).toEqual(['endpoint-a', 'endpoint-b', 'endpoint-c'])
  const next = await h.acquire()
  expect(await owner.call(release)).toMatchObject({ phase: 'preparing', owner: next.lease.owner })
  await expect(owner.call({ op: 'lease.release', requestId: rid() })).rejects.toThrow('superseded')
  await expect(h.admin.withCredential(next.credential).call({ op: 'lease.activate', requestId: rid() })).rejects.toThrow('All enrolled resources')
})

async function ownedEndpoint() {
  const authority = await fixture(['endpoint-a']), first = await authority.acquire(), owner = authority.admin.withCredential(first.credential)
  const resourceFile = join(authority.directory, 'resource.token'); await writeFile(resourceFile, authority.enrolled.resources[0]!.credential, { mode: 0o600 })
  const ownership = { ...authority.connection, credentialFile: resourceFile, coordinatorId: 'coordinator', resourceId: 'endpoint-a' }
  const access = { authorityId: authority.connection.authorityId, coordinatorId: 'coordinator', proof: () => first.credential }
  const endpoint = await remoteFixture(cleanup, { ownership, access, native: process.env.DSH_REMOTE_ISOLATION === '1',
    beforeEnroll: async endpoint => {
      await endpoint.ownership!.refresh()
      await owner.call({ op: 'lease.activate', requestId: rid() })
      await endpoint.ownership!.refresh()
    } })
  const client = (claim: OwnershipClaim) => new RemoteClient({ ...endpoint.connection, credentialFile: join(endpoint.directory, 'grant.token'),
    ownership: { ...access, proof: () => claim.credential } })
  return { authority, first, owner, ...endpoint, clientFor: client }
}

it('fences a running remote coordinator and transfers the same workspace grant only after resource acknowledgement', async () => {
  const h = await ownedEndpoint()
  const old = await h.client.call<RemoteJob>(h.spawn('sleep 20; printf stale > stale-result'))
  await vi.waitFor(() => expect(h.endpoint.journal.job(old.id).phase).toBe('started'))
  h.authority.advance(5001)
  const next = await h.authority.acquire(), owner = h.authority.admin.withCredential(next.credential), client = h.clientFor(next)
  await expect(owner.call({ op: 'lease.activate', requestId: rid() })).rejects.toThrow('All enrolled resources')
  await expect(client.call(h.spawn('printf premature'))).rejects.toThrow('drain prior work')
  await h.endpoint.ownership!.refresh()
  await h.settled(old.id)
  await h.endpoint.ownership!.refresh()
  await owner.call({ op: 'lease.activate', requestId: rid() })
  const job = await client.call<RemoteJob>(h.spawn('printf successor > successor-result; sleep 30'))
  await vi.waitFor(() => expect(h.endpoint.journal.job(job.id).phase).toBe('started'))
  expect(job).toMatchObject({ grantId: old.grantId, epoch: old.epoch, ownership: next.lease.owner })
  expect(await client.call({ op: 'fs.read', path: 'successor-result' })).toBe('successor')
  expect(await client.call({ op: 'fs.stat', path: 'stale-result' })).toBeNull()
  await expect(h.client.call(h.spawn('printf stale-again'))).rejects.toThrow('superseded')
  await expect(h.client.call({ op: 'fs.write', requestId: rid(), path: 'stale-write', content: 'bad' })).rejects.toThrow('superseded')
  expect(h.endpoint.journal.job(job.id)).toMatchObject({ phase: 'started', cancelRequested: false })
  await client.call({ op: 'job.cancel', requestId: rid(), id: job.id }); await h.settled(job.id)
  expect(await h.client.call({ op: 'job.get', id: old.id })).toMatchObject({ ownership: h.first.lease.owner, quiescent: true })
  expect(h.endpoint.journal.grant(old.grantId).epoch).toBe(old.epoch)
})

it('does not acknowledge handoff while an old file request is still preparing and rejects its delayed write', async () => {
  const h = await ownedEndpoint()
  let entered!: () => void, release!: () => void
  const prepared = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const original = h.fs.stat.bind(h.fs)
  vi.spyOn(h.fs, 'stat').mockImplementation(async (...args) => {
    if (h.fs.processPath(args[0]).endsWith('/delayed-write')) { entered(); await held }
    return original(...args)
  })
  const write = h.client.call({ op: 'fs.write', requestId: rid(), path: 'delayed-write', content: 'must not appear' })
  const outcome = write.then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([prepared, outcome.then(() => { throw new Error('File request ended before the held preparation boundary') })])
    h.authority.advance(5001)
    const next = await h.authority.acquire(), owner = h.authority.admin.withCredential(next.credential)
    await h.endpoint.ownership!.refresh()
    await expect(owner.call({ op: 'lease.activate', requestId: rid() })).rejects.toThrow('All enrolled resources')
    release(); expect(await outcome).toHaveProperty('error')
    await h.endpoint.ownership!.refresh(); await owner.call({ op: 'lease.activate', requestId: rid() })
    expect(await h.clientFor(next).call({ op: 'fs.stat', path: 'delayed-write' })).toBeNull()
  } finally { release(); await outcome }
})

it('keeps uncertain effects behind the handoff barrier until explicit operator reconciliation', async () => {
  const h = await ownedEndpoint(), id = rid()
  h.endpoint.journal.saveOperation({ id, grantId: h.enrolled.grant.id, epoch: h.enrolled.grant.epoch, fingerprint: 'uncertain-write',
    kind: 'fs.write', phase: 'unknown', at: new Date().toISOString(), ownership: h.first.lease.owner })
  h.authority.advance(5001)
  const next = await h.authority.acquire(), owner = h.authority.admin.withCredential(next.credential)
  await h.endpoint.ownership!.refresh()
  await expect(owner.call({ op: 'lease.activate', requestId: rid() })).rejects.toThrow('All enrolled resources')
  await h.admin.call({ op: 'operation.reconcile', id, requestId: rid(), note: 'Operator independently established the helper is stopped and inspected the file' })
  await h.endpoint.ownership!.refresh(); await owner.call({ op: 'lease.activate', requestId: rid() })
  expect(await h.clientFor(next).call({ op: 'fs.stat', path: 'missing' })).toBeNull()
})

it('renews a host lease, supplies proofs only while active, and treats ownership loss as a terminal process lifetime', async () => {
  const h = await fixture(['endpoint-a']), file = join(h.directory, 'claim.token')
  await writeFile(file, h.enrolled.credential, { mode: 0o600 })
  const ownership = new CoordinatorOwnership({ ...h.connection, credentialFile: file, coordinatorId: 'coordinator', leaseMs: 1000 })
  cleanup.push(() => ownership.close())
  expect(() => ownership.proof()).toThrow('unavailable')
  const started = ownership.start()
  await vi.waitFor(async () => {
    const view = await h.claimant.call<OwnershipView>({ op: 'lease.inspect' })
    expect(view.phase).toBe('preparing')
    await h.participants[0]!.client.call({ op: 'resource.acknowledge', requestId: rid(), stamp: view.owner! })
  })
  await started
  const proof = ownership.proof()
  expect(ownership.status().phase).toBe('active')
  h.advance(500)
  await vi.waitFor(async () => expect((await h.claimant.call<OwnershipView>({ op: 'lease.inspect' })).remainingMs).toBe(1000), { timeout: 2000 })
  expect(ownership.proof()).toBe(proof)
  h.restart()
  await vi.waitFor(() => expect(ownership.signal.aborted).toBe(true), { timeout: 2000 })
  expect(() => ownership.proof()).toThrow('unavailable')
  expect(ownership.status().phase).toBe('lost')
  expect(await h.claimant.call({ op: 'lease.inspect' })).toMatchObject({ phase: 'vacant', epoch: 1 })
})

it('reopens the same paired world after handoff, preserves original effect generations, and refuses substituted receipts', async () => {
  const h = await ownedEndpoint()
  if (process.env.DSH_REMOTE_ISOLATION !== '1')
    vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const open = async (claim: OwnershipClaim) => {
    const world = new RemoteWorld({ ...h.clientFor(claim).connection, stateDir: join(h.directory, 'world') })
    cleanup.push(() => world.close()); await world.start(); return world
  }
  const first = await open(h.first), request = h.spawn('sleep 30; printf stale >> ownership-result')
  const old = await first.executionClient().call<RemoteJob>(request)
  await vi.waitFor(() => expect(h.endpoint.journal.job(old.id).phase).toBe('started'))
  const binding = first.status().binding
  expect(first.effects().items[0]).toMatchObject({ ownership: h.first.lease.owner })
  await first.close()
  h.authority.advance(5001)
  const next = await h.authority.acquire(), owner = h.authority.admin.withCredential(next.credential)
  await h.endpoint.ownership!.refresh(); await h.settled(old.id); await h.endpoint.ownership!.refresh()
  await owner.call({ op: 'lease.activate', requestId: rid() })
  const successor = await open(next), client = successor.executionClient()
  expect(successor.status()).toMatchObject({ binding, ready: true, effectsBlocked: 0 })
  expect(successor.effects().items[0]).toMatchObject({ id: old.id, recovered: true, quiescent: true, ownership: h.first.lease.owner })
  expect(await client.call<RemoteJob>(request)).toMatchObject({ id: old.id, ownership: h.first.lease.owner })
  const fresh = await client.call<RemoteJob>(h.spawn('printf successor >> ownership-result'))
  await h.settled(fresh.id); await successor.refreshEffects()
  expect(successor.effects().items.find(item => item.id === fresh.id)).toMatchObject({ ownership: next.lease.owner, quiescent: true })
  expect(await client.call({ op: 'fs.read', path: 'ownership-result' })).toBe('successor')
  expect(JSON.stringify(successor.effects())).not.toContain(next.credential)
  const dispatch = h.endpoint.rpc.bind(h.endpoint)
  vi.spyOn(h.endpoint, 'rpc').mockImplementationOnce(async (...args) => ({ ...await dispatch(...args) as RemoteJob, ownership: next.lease.owner }))
  await expect(client.call({ op: 'job.get', id: old.id })).rejects.toThrow('does not match')
  expect(successor.effects().items.find(item => item.id === old.id)?.ownership).toEqual(h.first.lease.owner)
})

it('cancels resource work when the authority is unreachable and keeps receipt observation available', async () => {
  const h = await ownedEndpoint(), job = await h.client.call<RemoteJob>(h.spawn('sleep 30; printf stale > outage-result'))
  await vi.waitFor(() => expect(h.endpoint.journal.job(job.id).phase).toBe('started'))
  h.authority.offline(true)
  await expect(h.endpoint.ownership!.refresh()).rejects.toThrow()
  expect(h.endpoint.ownership!.status().ready).toBe(false)
  expect(await h.settled(job.id)).toMatchObject({ quiescent: true, ownership: h.first.lease.owner })
  await expect(h.client.call(h.spawn('printf forbidden'))).rejects.toThrow()
  h.authority.offline(false)
  await h.endpoint.ownership!.refresh()
  expect(await h.client.call({ op: 'fs.stat', path: 'outage-result' })).toBeNull()
  expect(h.endpoint.journal.jobs()).toHaveLength(1)
})

it('persists its resource binding and rejects credentials exposed inside a worker workspace', async () => {
  const h = await ownedEndpoint()
  await h.endpoint.stop()
  expect(() => new RemoteEndpoint({ ...h.host, ownership: undefined })).toThrow('cannot be removed')
  expect(() => new RemoteEndpoint({ ...h.host, ownership: { ...h.host.ownership!, resourceId: 'different-resource' } })).toThrow('cannot be removed')
  const file = join(h.enrolled.grant.root, 'resource.token')
  await writeFile(file, h.authority.enrolled.resources[0]!.credential, { mode: 0o600 })
  const endpoint = new RemoteEndpoint({ ...h.host, ownership: { ...h.host.ownership!, credentialFile: file } })
  try { await expect(endpoint.start()).rejects.toThrow('outside the endpoint workspace') } finally { await endpoint.stop() }
})

it('refuses an authority generation below the durable resource floor after endpoint restart', async () => {
  const h = await ownedEndpoint()
  h.endpoint.journal.db.prepare('UPDATE endpoint_meta SET value=? WHERE key=?')
    .run(JSON.stringify({ epoch: 2, nonce: rid() }), 'ownership-floor')
  await h.endpoint.stop()
  const endpoint = new RemoteEndpoint(h.host)
  try {
    await endpoint.start()
    await expect(endpoint.ownership!.refresh()).rejects.toThrow('regressed')
    expect(endpoint.ownership!.status().ready).toBe(false)
    await expect(endpoint.rpc(endpoint.journal.authenticate('Bearer ' + h.enrolled.credential), h.spawn('touch forbidden'), h.first.credential)).rejects.toThrow('regressed')
    expect(endpoint.journal.jobs()).toHaveLength(0)
  } finally { await endpoint.stop() }
})

it('rejects a delayed old authorization without cancelling a freshly verified successor', async () => {
  const h = await ownedEndpoint()
  let entered!: () => void, release!: () => void, intercepted = false
  const pending = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const call = OwnershipClient.prototype.call
  vi.spyOn(OwnershipClient.prototype, 'call').mockImplementation(async function (this: OwnershipClient, ...args) {
    const value = await call.apply(this, args)
    if (!intercepted && args[0].op === 'lease.verify' && args[0].proof === h.first.credential) {
      intercepted = true; entered(); await held
    }
    return value
  })
  const request = h.client.call({ op: 'fs.write', requestId: rid(), path: 'delayed-authorization', content: 'stale' })
  const outcome = request.then(value => ({ value }), error => ({ error }))
  try {
    await Promise.race([pending, outcome.then(() => { throw new Error('Request ended before delayed verification') })])
    h.authority.advance(5001)
    const next = await h.authority.acquire(), owner = h.authority.admin.withCredential(next.credential)
    await h.endpoint.ownership!.refresh(); await owner.call({ op: 'lease.activate', requestId: rid() })
    const client = h.clientFor(next), job = await client.call<RemoteJob>(h.spawn('sleep 30'))
    await vi.waitFor(() => expect(h.endpoint.journal.job(job.id).phase).toBe('started'))
    release(); expect(await outcome).toHaveProperty('error')
    expect(h.endpoint.ownership!.status().ready).toBe(true)
    expect(h.endpoint.journal.job(job.id)).toMatchObject({ phase: 'started', cancelRequested: false })
    expect(await client.call({ op: 'fs.stat', path: 'delayed-authorization' })).toBeNull()
    await client.call({ op: 'job.cancel', id: job.id, requestId: rid() }); await h.settled(job.id)
  } finally { release(); await outcome }
})

it('waits for cancelled command preparation to leave before acknowledging a successor', async () => {
  const h = await ownedEndpoint()
  let entered!: () => void, release!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const wrap = h.isolation.wrap.bind(h.isolation)
  vi.spyOn(h.isolation, 'wrap').mockImplementationOnce(async (...args) => {
    const result = await wrap(...args); entered(); await held; return result
  })
  const job = await h.client.call<RemoteJob>(h.spawn('printf stale > prepared-result'))
  try {
    await Promise.race([pending, h.settled(job.id).then(() => { throw new Error('Job ended before held command preparation') })])
    h.authority.advance(5001)
    const next = await h.authority.acquire(), owner = h.authority.admin.withCredential(next.credential)
    await h.endpoint.ownership!.refresh()
    expect(h.endpoint.journal.job(job.id)).toMatchObject({ phase: 'settled', quiescent: true, cancelRequested: true })
    await expect(owner.call({ op: 'lease.activate', requestId: rid() })).rejects.toThrow('All enrolled resources')
    release()
    await vi.waitFor(async () => {
      await h.endpoint.ownership!.refresh()
      expect((await owner.call<OwnershipView>({ op: 'lease.inspect' })).acknowledged).toEqual(['endpoint-a'])
    })
    await owner.call({ op: 'lease.activate', requestId: rid() })
    expect(await h.clientFor(next).call({ op: 'fs.stat', path: 'prepared-result' })).toBeNull()
  } finally { release() }
})
