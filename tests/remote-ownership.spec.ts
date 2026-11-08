import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteWorld } from '../src/remote/world.ts'
import { RemoteError, type EffectOwner, type RemoteJob, type RemoteOperation } from '../src/remote/protocol.ts'
import { remoteFixture } from './fixtures/remote.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.restoreAllMocks() })
const owner = (id = 'one'): EffectOwner => ({ kind: 'assignment', ticketId: `ticket-${id}`, assignmentId: `assignment-${id}`,
  sessionId: `worker-${id}`, callId: `call-${id}`, tool: 'bash' })
async function fixture() {
  const h = await remoteFixture(cleanup)
  vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const config = { ...h.client.connection, stateDir: join(h.directory, 'world') }
  const open = async () => {
    const world = new RemoteWorld(config); cleanup.push(() => world.close()); await world.start(); return world
  }
  const world = await open()
  return { ...h, world, open, client: world.executionClient() }
}

it('commits trusted ownership before HTTP and keeps one receipt across an acknowledgement loss', async () => {
  const h = await fixture(), dispatch = h.endpoint.rpc.bind(h.endpoint)
  vi.spyOn(h.endpoint, 'rpc').mockImplementation(async (...args) => {
    const request = args[1] as { op: string; requestId: string }
    if (request.op === 'job.spawn') expect(h.world.effects('ticket-one').items[0]).toMatchObject({ id: request.requestId, owner: owner() })
    return dispatch(...args)
  })
  h.lose()
  const job = await h.world.withOwner(owner(), () => {}, () => h.client.call<RemoteJob>(h.spawn('printf once >> result', { requestId: 'lost-ack',
    owner: owner('spoof'), env: { DSH_SESSION_ID: 'spoof' } })))
  await h.settled(job.id); await h.world.refreshEffects()
  expect(h.endpoint.journal.jobs()).toHaveLength(1)
  expect(h.endpoint.journal.job(job.id)?.request.owner).toEqual(owner())
  expect(await readFile(join(h.enrolled.grant.root, 'result'), 'utf8')).toBe('once')
  expect(h.world.effects('ticket-one').items).toEqual([expect.objectContaining({ id: 'lost-ack', phase: 'settled', quiescent: true, owner: owner() })])
  expect(h.world.effects('ticket-spoof').items).toEqual([])
})

it('isolates concurrent tool ownership and excludes payloads from operator metadata', async () => {
  const h = await fixture()
  await Promise.all(['one', 'two'].map(id => h.world.withOwner(owner(id), () => {}, async () => {
    await new Promise(resolve => setTimeout(resolve, id === 'one' ? 10 : 1))
    const request = h.spawn(`printf private-command-${id}`, { requestId: id, env: { SAFE_VALUE: 'private-environment' } })
    // The endpoint permits only its documented environment keys.
    request.env = { DSH_SESSION_ID: `spoof-${id}` }
    await h.client.intent(request)
  })))
  for (const id of ['one', 'two']) {
    await h.settled(id)
    expect(h.world.effects(`ticket-${id}`).items).toHaveLength(1)
    expect(h.endpoint.journal.job(id)?.request.owner).toEqual(owner(id))
  }
  const written = await h.world.withOwner(owner(), () => {}, () => h.client.intent<RemoteOperation>({ op: 'fs.write', requestId: 'write',
    path: join(h.enrolled.grant.root, 'private.txt'), content: 'private-content' }))
  expect(written.owner).toEqual(owner())
  await h.world.refreshEffects()
  const serialized = JSON.stringify(h.world.effects())
  expect(serialized).not.toMatch(/private-command|private-environment|private-content|argv|content|stdin/)
  const page = h.world.effects(undefined, 0, 1)
  expect(page.total).toBe(3); expect(page.nextOffset).toBe(1)
  expect(h.world.effects(undefined, 1, 1).items[0]?.id).not.toBe(page.items[0]?.id)
})

it('revalidates assignment authorization immediately before dispatch, including same-ID retries', async () => {
  const h = await fixture()
  let valid = true
  const authorize = () => { if (!valid) throw new Error('Assignment ended') }
  await expect(h.world.withOwner(owner(), authorize, async () => {
    valid = false
    return h.client.intent(h.spawn('touch never', { requestId: 'never' }))
  })).rejects.toThrow('Assignment ended')
  expect(h.world.effects().total).toBe(0); expect(h.endpoint.journal.jobs()).toHaveLength(0)
  valid = true
  const dispatch = h.endpoint.rpc.bind(h.endpoint)
  vi.spyOn(h.endpoint, 'rpc').mockImplementationOnce(async (...args) => { await dispatch(...args); valid = false; throw new Error('Lost response') })
  await expect(h.world.withOwner(owner(), authorize, () => h.client.intent(h.spawn('printf once > result', { requestId: 'ended-after-send' })))).rejects.toThrow('could not be confirmed')
  expect(h.endpoint.journal.jobs()).toHaveLength(1)
  expect(h.world.status().effectsBlocked).toBe(1)
  await h.settled('ended-after-send'); await h.world.refreshEffects()
  expect(h.world.status().ready).toBe(true)
})

it('recovers a running receipt after coordinator restart without dispatching replacement work', async () => {
  const h = await fixture()
  await h.world.withOwner(owner(), () => {}, () => h.client.intent(h.spawn('sleep 30', { requestId: 'running' })))
  await h.world.close()
  const recovered = await h.open()
  expect(recovered.effects('ticket-one').items[0]).toMatchObject({ id: 'running', recovered: true, quiescent: false })
  expect(recovered.status()).toMatchObject({ ready: false, effectsBlocked: 1 })
  await expect(recovered.executionClient().intent(h.spawn('true'))).rejects.toThrow('require observation')
  expect(h.endpoint.journal.jobs()).toHaveLength(1)
  await expect(recovered.cancelEffect('ticket-other', 'running', 'wrong-owner')).rejects.toMatchObject({ status: 404 })
  await recovered.cancelEffect('ticket-one', 'running', 'stop-running')
  await vi.waitFor(async () => { await recovered.refreshEffects(); expect(recovered.status().ready).toBe(true) }, { timeout: 5000 })
  expect(recovered.effects('ticket-one').items[0]).toMatchObject({ quiescent: true })
})

it('keeps missing receipts unknown through restart until whole-grant revocation confirms quiescence', async () => {
  const h = await fixture()
  h.offline(true)
  await expect(h.world.withOwner(owner(), () => {}, () => h.client.intent(h.spawn('true', { requestId: 'offline' })))).rejects.toThrow('could not be confirmed')
  h.offline(false)
  await h.world.close()
  const recovered = await h.open()
  expect(recovered.status()).toMatchObject({ ready: false, effectsBlocked: 1 })
  expect(recovered.effects().items[0]).toMatchObject({ phase: 'unknown', quiescent: null })
  expect(h.endpoint.journal.jobs()).toHaveLength(0)
  await recovered.revoke('revoke-unknown', 'Fence possibly delayed requests')
  expect(recovered.status()).toMatchObject({ ready: false, effectsBlocked: 0, revocation: { quiescent: true } })
  expect(recovered.effects().items[0]).toMatchObject({ phase: 'unknown', quiescent: true })
})

it('distinguishes a first-request refusal from a refusal after an unconfirmed dispatch', async () => {
  const h = await fixture()
  await expect(h.client.intent(h.spawn('true', { requestId: 'refused', env: { OPENAI_API_KEY: 'never-forwarded' } }))).rejects.toThrow('environment')
  expect(h.world.effects().items[0]).toMatchObject({ phase: 'refused', quiescent: true })
  const dispatch = h.endpoint.rpc.bind(h.endpoint)
  vi.spyOn(h.endpoint, 'rpc').mockImplementationOnce(async (...args) => { await dispatch(...args); throw new Error('Lost after commit') })
    .mockRejectedValueOnce(new RemoteError(403, 'denied', 'Authorization changed during reconnect'))
  await expect(h.client.intent(h.spawn('true', { requestId: 'ambiguous' }))).rejects.toThrow('Authorization changed')
  expect(h.world.effects().items.find(item => item.id === 'ambiguous')).toMatchObject({ phase: 'unknown', quiescent: null })
  await h.settled('ambiguous'); await h.world.refreshEffects()
  expect(h.world.status().effectsBlocked).toBe(0)
})

it('rejects substituted endpoint ownership and never treats a mismatched receipt as success', async () => {
  const h = await fixture(), dispatch = h.endpoint.rpc.bind(h.endpoint)
  vi.spyOn(h.endpoint, 'rpc').mockImplementationOnce(async (...args) => {
    const receipt = await dispatch(...args) as RemoteJob
    return { ...receipt, request: { ...receipt.request, owner: owner('other') } }
  })
  await expect(h.world.withOwner(owner(), () => {}, () => h.client.intent(h.spawn('true', { requestId: 'mismatch' })))).rejects.toThrow('does not match')
  expect(h.world.status().effectsBlocked).toBe(1)
  expect(h.world.effects().items[0]?.owner).toEqual(owner())
  await h.settled('mismatch'); await h.world.refreshEffects()
  expect(h.world.status().ready).toBe(true)
})

it('requires an endpoint that supports durable ownership receipts', async () => {
  const h = await remoteFixture(cleanup)
  vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap',
    capabilities: { ...h.endpoint.identity().capabilities, effectOwnership: undefined } })
  const world = new RemoteWorld({ ...h.client.connection, stateDir: join(h.directory, 'world') }); cleanup.push(() => world.close())
  await expect(world.start()).rejects.toThrow('update the endpoint first')
})
