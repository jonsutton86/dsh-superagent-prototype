import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { publicationFixture } from './fixtures/publication.ts'
import { channelPublicationFixture } from './fixtures/channel-publication.ts'
import { startRuntime } from './fixtures/host.ts'
import { verifyPublicationState } from '../src/recovery/publications.ts'
import { recoveryStateDigest } from '../src/recovery/state.ts'
import type { Store } from '../src/app/store.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const verify = (store: Store, settled = false) => verifyPublicationState(store.db, new AbortController().signal, settled)
const alter = (store: Store, table: string, id: string, change: (value: any) => void) => {
  const value = JSON.parse(String(store.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)!.value)); change(value)
  store.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), id)
}
async function fixture() {
  const authority = await ownershipAuthority(cleanup), publisher = await publicationFixture(cleanup, authority.resource)
  const host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true, ownership: authority.config, publication: publisher.connection })
  cleanup.push(() => host.stop())
  const artifact = host.runtime.library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'Original artifact', summary: 'Approved bytes', content: 'Original report' })
  const destination = (await host.runtime.publications.destinations()).items[0]!
  const approval = { requestId: randomUUID(), revision: artifact.revision, hash: artifact.hash, destination: destination.id, destinationHash: destination.hash, checks: [] }
  await host.runtime.publications.publish(artifact.id, approval)
  return { host, publisher, artifact, approval, store: host.runtime.store }
}

it('retains original artifact approval and destination after archive without contacting the publisher', async () => {
  const h = await fixture()
  h.host.runtime.library.archive(h.artifact.id, { requestId: randomUUID(), revision: h.artifact.revision, archived: true })
  const before = recoveryStateDigest(h.store.db), posts = h.publisher.posts
  expect(await verify(h.store, true)).toMatchObject({ artifacts: 1, receipts: 1, sent: 1, unresolved: 0, legacyApprovals: 0, legacyDestinations: 0 })
  expect(recoveryStateDigest(h.store.db)).toBe(before); expect(h.publisher.posts).toBe(posts)
  expect(await h.host.runtime.publications.publish(h.artifact.id, h.approval)).toMatchObject({ receipt: { phase: 'sent' } })
})

it('refuses substituted approval, original content, receipt, destination, owner and external target evidence', async () => {
  const h = await fixture(), original = recoveryStateDigest(h.store.db)
  const changes: ((value: any) => void)[] = [
    value => { value.approval.revision++ }, value => { value.fingerprint = '0'.repeat(64) }, value => { value.intent.text = 'private-substitution' },
    value => { value.artifactId = randomUUID(); value.intent.artifact.id = value.artifactId }, value => { value.serviceId = randomUUID() },
    value => { value.attempts[0].coordinatorId = 'other' }, value => { value.receipt.ownership.nonce = randomUUID() },
    value => { value.receipt.bytes++ }, value => { value.receipt.artifact.revision++ }, value => { value.destinationSnapshot.issue++ },
    value => { value.receipt.external.bodyHash = '0'.repeat(64) }, value => { value.receipt.external.url = value.receipt.external.url.replace('/7#', '/8#') },
  ]
  for (const change of changes) {
    h.store.db.exec('SAVEPOINT corruption')
    try { alter(h.store, 'workspace_publication', h.approval.requestId, change); await expect(verify(h.store)).rejects.toThrow(/recovery_publications_/)
    } finally { h.store.db.exec('ROLLBACK TO corruption; RELEASE corruption') }
    expect(recoveryStateDigest(h.store.db)).toBe(original)
  }
})

it('reconstructs legacy artifact requests including explicit empty checks and exposes missing destination snapshots', async () => {
  const h = await fixture()
  alter(h.store, 'workspace_publication', h.approval.requestId, value => { delete value.approval; delete value.destinationSnapshot })
  expect(await verify(h.store, true)).toMatchObject({ legacyApprovals: 1, legacyDestinations: 1, sent: 1 })
  alter(h.store, 'workspace_publication', h.approval.requestId, value => { value.fingerprint = '0'.repeat(64) })
  await expect(verify(h.store)).rejects.toThrow('publication_legacy_approval')
})

it('preserves historical plan delivery after revocation and detects grant/request/Outbox substitution', async () => {
  const h = await channelPublicationFixture(cleanup), runtime = h.host.runtime
  await runtime.channelPublications.configure(h.mission.id, h.configure)
  const { sessionId, trigger } = await h.run()
  await h.host.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'Original acknowledgement' })
  await runtime.channelPublications.configure(h.mission.id, { requestId: randomUUID(), revision: 1, missionRevision: h.mission.revision, enabled: false })
  runtime.workspace.add(h.mission.id, { requestId: randomUUID(), revision: runtime.workspace.get(h.mission.id).revision, title: 'Later plan', instructions: 'Human follow-up', owner: 'person' })
  const item = runtime.channelPublications.state(h.mission.id).items[0]!, store = runtime.store
  expect(await verify(store, true)).toMatchObject({ deliveryGrants: 2, revokedGrants: 1, deliveries: 1, sent: 1, legacyGrantRequests: 0, legacyPlanBindings: 0 })
  const changes = [
    () => alter(store, 'delivery_grant', h.configure.requestId, value => { value.planVersion++ }),
    () => alter(store, 'delivery_grant', h.configure.requestId, value => { value.revokedAt = '2000-01-01T00:00:00.000Z' }),
    () => store.db.prepare('UPDATE delivery_grant SET fingerprint=? WHERE id=?').run('0'.repeat(64), h.configure.requestId),
    () => alter(store, 'outbox', item.messageId, value => { value.text = 'private-substitution' }),
    () => alter(store, 'channel_publication', item.id, value => { value.original.channel.address.destination = 'Another destination' }),
    () => alter(store, 'channel_publication', item.id, value => { value.publication.message.planVersion++ }),
    () => alter(store, 'channel_publication', item.id, value => { value.receipt.phase = 'not_delivered'; delete value.receipt.external }),
  ]
  const original = recoveryStateDigest(store.db)
  for (const change of changes) {
    store.db.exec('SAVEPOINT corruption')
    try { change(); await expect(verify(store)).rejects.toThrow(/recovery_publications_/) }
    finally { store.db.exec('ROLLBACK TO corruption; RELEASE corruption') }
    expect(recoveryStateDigest(store.db)).toBe(original)
  }
  store.db.prepare('UPDATE delivery_grant SET request=NULL WHERE id=?').run(h.configure.requestId)
  expect(await verify(store, true)).toMatchObject({ legacyGrantRequests: 1, revokedGrants: 1 })
}, 15_000)

it('keeps uncertain withdrawn delivery held and restores only its original missing Outbox receipt', async () => {
  const h = await channelPublicationFixture(cleanup), runtime = h.host.runtime
  await runtime.channelPublications.configure(h.mission.id, h.configure)
  const { sessionId, trigger } = await h.run()
  h.publisher.loseProviderReply()
  await h.host.runTool(sessionId, 'orchestrator_ack', { trigger_id: trigger.id, text: 'Original delivery' })
  const item = runtime.channelPublications.state(h.mission.id).items[0]!
  runtime.outbox.withdraw(item.messageId)
  runtime.store.db.prepare('DELETE FROM outbox WHERE id=?').run(item.messageId)
  expect(await verify(runtime.store)).toMatchObject({ withdrawn: 1, unresolved: 1, missingOutbox: 1 })
  await expect(verify(runtime.store, true)).rejects.toThrow('unsettled')
  await runtime.channelPublications.refresh(item.id)
  expect(await verify(runtime.store, true)).toMatchObject({ sent: 1, unresolved: 0, missingOutbox: 0, withdrawn: 1 })
  expect(runtime.outbox.status(item.messageId)).toBe('sent'); expect(h.publisher.posts).toBe(1)
}, 15_000)

it('honors cancellation and bounds oversized saved approval diagnostics without copying content', async () => {
  const h = await fixture(), controller = new AbortController(); controller.abort(new Error('stop-inspection'))
  await expect(verifyPublicationState(h.store.db, controller.signal)).rejects.toThrow('stop-inspection')
  alter(h.store, 'workspace_publication', h.approval.requestId, value => { value.problem = 'private-value'.repeat(800000) })
  await expect(verify(h.store)).rejects.toThrow('recovery_publications_limit: workspace_publication')
  expect(h.publisher.posts).toBe(1)
})
