import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Engine } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { ConversationInbox } from '../src/publication/inbound.ts'
import { verifyConnectorState } from '../src/recovery/connectors.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import { inboundFixture } from './fixtures/inbound.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function store(source?: Store) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-connectors-')), path = join(directory, 'state.sqlite')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  if (source) await backup(source.db, path)
  const result = new Store(path); cleanup.push(async () => result.close()); return result
}
const verify = (store: Store, signal = new AbortController().signal) => verifyConnectorState(store.db, signal)
const alter = (store: Store, table: string, id: string, update: (value: any) => void) => {
  const value = JSON.parse(String(store.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)!.value))
  update(value); store.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), id)
}

it.each(['github-comment', 'github-review', 'feishu-reply'] as const)('verifies actual %s receipts, authority and unsupported content without changing state', async kind => {
  const f = await inboundFixture(cleanup, kind)
  f.publisher.receive(f.sender, 'An authorized follow-up'); f.publisher.receive(f.sender, 'x'.repeat(16001))
  f.publisher.receive('outsider', 'Not authorized')
  expect((await f.poll()).items).toHaveLength(2)
  const copy = await store(f.runtime.store), before = recoveryStateDigest(copy.db), result = await verify(copy)
  expect(result).toMatchObject({ version: 1, bindings: 1, messages: 2, nativeMessages: 2, legacyMessages: 0, cycles: 0, github: 0, feishu: 0, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(recoveryStateDigest(copy.db)).toBe(before); expect(await verify(copy)).toEqual(result)
}, 15000)

it('preserves a partial page and consumes only unseen messages when the listener is reconstructed', async () => {
  const f = await inboundFixture(cleanup)
  for (let i = 0; i < 47; i++) f.publisher.receive(f.sender, `Reply ${i}`)
  expect((await f.poll()).items).toHaveLength(40)
  const copy = await store(f.runtime.store), before = recoveryStateDigest(copy.db)
  expect(await verify(copy)).toMatchObject({ bindings: 1, messages: 40, cycles: 1 })
  expect(recoveryStateDigest(copy.db)).toBe(before)
  // Reconstruct only the listener component under the existing fixture owner. This does not activate a held coordinator.
  const engine = new Engine({ repo: copy, scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => ({ version: 'test', paused: false, evalTimeoutMs: 60000, gate: () => ({ admissible: false, reason: 'No new tasks' }), revalidate: () => true, admitsInferred: () => false }),
    executor: { start: () => {}, deliver: () => {}, stop: () => {} }, assessor: { request: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const listener = new ConversationInbox({ store: copy, channels: f.runtime.channelPublications, ownership: f.runtime.ownership,
    connection: f.publisher.connection, lifetime: new AbortController().signal, engine: () => engine, authorized: () => true, requestPass: () => {} })
  cleanup.push(() => listener.stop())
  expect((await listener.poll(f.mission.id)).items).toHaveLength(47)
  expect(await verify(copy)).toMatchObject({ messages: 47, cycles: 0 })
  expect((await listener.poll(f.mission.id, true)).items).toHaveLength(47)
  expect(copy.tickets.get(f.ticket.id)!.inputs.filter(input => input.kind === 'trigger')).toHaveLength(47)
}, 15000)

it('retains replaced and disabled listeners and their historical deduplication receipts', async () => {
  const f = await inboundFixture(cleanup)
  f.publisher.receive(f.sender, 'Original input'); await f.poll()
  f.runtime.conversations.configure(f.mission.id, { ...f.request, requestId: randomUUID(), revision: 1, enabled: false })
  const copy = await store(f.runtime.store), before = recoveryStateDigest(copy.db)
  expect(await verify(copy)).toMatchObject({ bindings: 2, messages: 1, nativeMessages: 1, legacyMessages: 0 })
  expect(recoveryStateDigest(copy.db)).toBe(before)
  const item = f.runtime.conversations.state(f.mission.id).items[0]!
  alter(copy, 'conversation_message', item.id, value => { delete value.nativeId })
  const legacy = recoveryStateDigest(copy.db)
  expect(await verify(copy)).toMatchObject({ bindings: 2, messages: 1, nativeMessages: 0, legacyMessages: 1 })
  expect(recoveryStateDigest(copy.db)).toBe(legacy)
}, 15000)

it('rejects contradictory connector authority and pagination without modifying the snapshot', async () => {
  const f = await inboundFixture(cleanup)
  for (let i = 0; i < 41; i++) f.publisher.receive(f.sender, `Reply ${i}`)
  const state = await f.poll(), copy = await store(f.runtime.store), incoming = state.items[0]!, binding = state.binding!
  const mutations: (() => void)[] = [
    () => alter(copy, 'conversation_binding', binding.id, value => { value.senders = ['mallory'] }),
    () => alter(copy, 'conversation_binding', binding.id, value => { value.ticketId = 'different-ticket' }),
    () => alter(copy, 'conversation_binding', binding.id, value => { value.destination.issue++ }),
    () => {
      alter(copy, 'conversation_binding', binding.id, value => { value.destination.issue++ })
      alter(copy, 'delivery_grant', binding.grantId!, value => { value.destination.issue++ })
    },
    () => alter(copy, 'conversation_binding', binding.id, value => { value.revision++ }),
    () => alter(copy, 'conversation_binding', binding.id, value => { value.watermark = '2020-01-01T00:00:00.000Z' }),
    () => alter(copy, 'conversation_binding', binding.id, value => { value.cycle.cursor = 'private-unrecorded-cursor' }),
    () => alter(copy, 'conversation_binding', binding.id, value => { value.received++ }),
    () => alter(copy, 'conversation_message', incoming.id, value => { value.ticketId = 'different-ticket' }),
    () => alter(copy, 'conversation_message', incoming.id, value => { value.sender = 'mallory' }),
    () => alter(copy, 'conversation_message', incoming.id, value => { value.triggerId = 'wrong-trigger' }),
    () => alter(copy, 'conversation_message', incoming.id, value => { value.nativeId = 'different-native-message' }),
    () => alter(copy, 'conversation_message', incoming.id, value => { value.hash = '0'.repeat(64) }),
    () => alter(copy, 'trigger', incoming.triggerId!, value => { value.text = 'Changed message content' }),
    () => alter(copy, 'trigger', incoming.triggerId!, value => { value.meta.inbound = '0'.repeat(64) }),
    () => alter(copy, 'trigger', incoming.triggerId!, value => { value.channel.address.grantId = randomUUID() }),
    () => alter(copy, 'disposition', incoming.triggerId!, value => { value.recipient = 'different-ticket' }),
    () => { copy.db.prepare('DELETE FROM conversation_message WHERE id=?').run(incoming.id) },
    () => { copy.db.prepare('UPDATE delivery_grant SET mission=? WHERE id=?').run(randomUUID(), binding.grantId!) },
  ]
  for (const mutate of mutations) {
    copy.db.exec('SAVEPOINT corrupt_connector')
    try {
      mutate(); const before = recoveryStateDigest(copy.db)
      await expect(verify(copy)).rejects.toThrow('recovery_connector_')
      expect(recoveryStateDigest(copy.db)).toBe(before)
    } finally { copy.db.exec('ROLLBACK TO corrupt_connector; RELEASE corrupt_connector') }
  }
  expect(await verify(copy)).toMatchObject({ messages: 40, cycles: 1 })
}, 15000)

it('checks all retained legacy cursor families without advancing, resetting or reinterpreting unknown plugin state', async () => {
  const copy = await store(), at = '2026-01-02T03:04:05.000Z'
  copy.threads.save({ key: 'feishu:topic', ref: { source: 'feishu', id: 'topic' }, createdAt: at, subscriptions: [], correlated: [], pending: [], meta: {} })
  copy.set(KV.github.since, at); copy.set(KV.github.cursor(7), at)
  copy.set(KV.github.retries, { '7': { since: at, pr: true, failedAt: at, attempts: 3 } })
  copy.set(KV.github.stream('issues'), { since: at, started: { issues: at, pulls: at }, etag: '"retained"' })
  copy.set(KV.github.branchCi, { branch: 'main', failures: ['check failed', 'check failed', ''], revision: 1 })
  copy.set(KV.github.ci(7), { fingerprint: 'original-fingerprint', revision: 0 })
  copy.set(KV.feishu.chats, { oc_team: false }); copy.set(KV.feishu.history('oc_team'), at)
  copy.set(KV.feishu.topics('oc_team'), { om_topic: at }); copy.set(KV.feishu.seen('feishu:topic'), ['om_root', 'om_seen'])
  copy.set(KV.feishu.initialized('feishu:topic'), true); copy.set('disabled-custom:cursor', { opaque: true })
  const before = recoveryStateDigest(copy.db), result = await verify(copy)
  expect(result).toMatchObject({ github: 6, feishu: 5, bindings: 0, messages: 0 })
  expect(recoveryStateDigest(copy.db)).toBe(before)
  copy.set('disabled-custom:cursor', { opaque: 'different' }); expect(await verify(copy)).toEqual(result)
  copy.set(KV.github.cursor(7), 'not-a-time')
  await expect(verify(copy)).rejects.toMatchObject({ code: 'shape' })
  copy.set(KV.github.cursor(7), at); copy.set(KV.feishu.seen('feishu:topic'), ['om_same', 'om_same'])
  await expect(verify(copy)).rejects.toMatchObject({ code: 'shape' })
  copy.set(KV.feishu.seen('feishu:topic'), ['om_root']); copy.db.prepare('DELETE FROM thread WHERE key=?').run('feishu:topic')
  await expect(verify(copy)).rejects.toMatchObject({ code: 'reference' })
})

it('bounds connector records and yields to cancellation without changing cursor state', async () => {
  const copy = await store(), at = '2026-01-02T03:04:05.000Z'
  for (let i = 1; i <= 300; i++) copy.set(KV.github.cursor(i), at)
  const before = recoveryStateDigest(copy.db), controller = new AbortController(), cancellation = setImmediate(() => controller.abort())
  try { await expect(verify(copy, controller.signal)).rejects.toThrow() } finally { clearImmediate(cancellation) }
  expect(recoveryStateDigest(copy.db)).toBe(before)
  copy.set(KV.github.stream('issues'), { since: at, started: {}, etag: 'private'.repeat(700000) })
  await expect(verify(copy)).rejects.toMatchObject({ code: 'limit', message: 'recovery_connector_limit: github-stream:issues' })
})
