import { randomUUID } from 'node:crypto'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { publicationFixture } from './fixtures/publication.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { contentHash } from '../src/publication/github.ts'
import { DestinationView, PublicationReceipt, PublicationConfigurationObservation, type Publication } from '../src/publication/protocol.ts'
import { InventoryPage } from '../src/ownership/inventory.ts'
import { PublicationService } from '../src/publication/service.ts'
import type { OwnershipView } from '../src/ownership/protocol.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
async function fixture(kind: 'github-comment' | 'github-review' | 'feishu-reply' = 'github-comment') {
  const authority = await ownershipAuthority(cleanup), owner = new CoordinatorOwnership(authority.config)
  const host = await publicationFixture(cleanup, authority.resource, owner, kind)
  cleanup.push(() => owner.close()); await owner.start()
  const destinations = await host.client.call<DestinationView[]>({ op: 'destinations' })
  const text = 'Reviewed artifact content', hash = contentHash(text)
  const publication: Publication = { id: randomUUID(), destination: destinations[0]!.id, destinationHash: destinations[0]!.hash,
    text, hash, artifact: { id: randomUUID(), revision: 1, hash } }
  return { authority, owner, host, publication }
}

it('publishes once, preserves exact original receipts through lost acknowledgements and restart, and rejects ID substitution', async () => {
  const { host, publication, owner } = await fixture()
  host.loseServiceReply()
  await expect(host.client.call({ op: 'publish', publication })).rejects.toThrow()
  const original = await host.client.call<PublicationReceipt>({ op: 'receipt.get', id: publication.id })
  expect(original).toMatchObject({ phase: 'sent', hash: publication.hash, ownership: owner.status().owner, external: { id: '1' } })
  expect(host.posts).toBe(1)
  expect(await host.client.call({ op: 'publish', publication })).toEqual(original)
  await expect(host.client.call({ op: 'publish', publication: { ...publication, text: 'Different', hash: contentHash('Different'), artifact: { ...publication.artifact!, hash: contentHash('Different') } } })).rejects.toThrow('different content')
  await host.restart()
  expect(await host.client.call({ op: 'receipt.get', id: publication.id })).toEqual(original)
  await vi.waitFor(async () => expect(await host.client.call({ op: 'publish', publication })).toEqual(original))
  expect(host.posts).toBe(1)
  expect(JSON.stringify(original)).not.toContain(host.secret)
})

it.each(['github-comment', 'github-review', 'feishu-reply'] as const)('verifies %s account and destination configuration without a lease, publication or administrator substitution', async kind => {
  const { host, publication, owner, authority } = await fixture(kind); await owner.close()
  const before = await authority.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })
  const inventory = InventoryPage.parse(await host.admin.call({ op: 'recovery.inventory', offset: 0 }))
  const request = { op: 'recovery.destination' as const, revision: inventory.revision, destination: publication.destination, destinationHash: publication.destinationHash }
  const observation = PublicationConfigurationObservation.parse(await host.client.call(request))
  expect(observation).toEqual({ revision: inventory.revision, identity: inventory.identity, destination: request.destination,
    destinationHash: request.destinationHash, account: true, target: true, quiescent: true })
  expect(JSON.stringify(observation)).not.toContain(host.secret); expect(JSON.stringify(observation)).not.toContain(host.destination.credentialFile)
  await expect(host.admin.call(request)).rejects.toThrow('coordinator publication credential')
  await expect(host.client.call({ ...request, destinationHash: '0'.repeat(64) })).rejects.toThrow('changed')
  expect(await host.admin.call({ op: 'recovery.inventory', offset: 0 })).toEqual(inventory)
  expect(await authority.admin.call({ op: 'coordinator.inspect', id: 'coordinator' })).toEqual(before)
  expect(host.posts).toBe(0)
})

it.each(['missing', 'public', 'changed', 'account'] as const)('refuses %s publication configuration and keeps private diagnostics off the wire', async kind => {
  const { host, publication, owner } = await fixture(); await owner.close()
  const inventory = InventoryPage.parse(await host.admin.call({ op: 'recovery.inventory', offset: 0 }))
  const request = { op: 'recovery.destination' as const, revision: inventory.revision, destination: publication.destination, destinationHash: publication.destinationHash }
  await host.client.call(request)
  if (kind === 'missing') await rm(host.destination.credentialFile)
  else if (kind === 'public') await chmod(host.destination.credentialFile, 0o644)
  else if (kind === 'changed') await writeFile(host.destination.credentialFile, 'synthetic-replacement-credential-value')
  else host.login('another-account')
  await expect(host.client.call(request)).rejects.toMatchObject({ code: 'configuration_unavailable', message: 'Publication account or destination configuration is unavailable' })
  expect(host.posts).toBe(0)
})

it.each(['bot', 'chat'] as const)('rejects an altered Feishu %s during read-only recovery verification', async kind => {
  const { host, publication, owner } = await fixture('feishu-reply'); await owner.close()
  const inventory = InventoryPage.parse(await host.admin.call({ op: 'recovery.inventory', offset: 0 }))
  if (kind === 'bot') host.bot('ou_other'); else host.parentChat('oc_other')
  await expect(host.client.call({ op: 'recovery.destination', revision: inventory.revision,
    destination: publication.destination, destinationHash: publication.destinationHash })).rejects.toMatchObject({ code: 'configuration_unavailable' })
  expect(host.posts).toBe(0)
})

it.each(['credential', 'inventory'] as const)('rechecks publication %s after the asynchronous account lookup', async kind => {
  const { host, publication, owner } = await fixture(); await owner.close()
  const inventory = InventoryPage.parse(await host.admin.call({ op: 'recovery.inventory', offset: 0 }))
  let release!: () => void
  host.holdPrepare(new Promise<void>(resolve => { release = resolve }))
  const checking = host.client.call({ op: 'recovery.destination', revision: inventory.revision,
    destination: publication.destination, destinationHash: publication.destinationHash })
  void checking.catch(() => {})
  try {
    await vi.waitFor(() => expect(host.inspections).toBe(1))
    if (kind === 'credential') await writeFile(host.destination.credentialFile, 'synthetic-replacement-credential-value')
    else host.service.journal.db.prepare("UPDATE resource_inventory_revision SET value=? WHERE id=1").run('0'.repeat(32))
    release()
    await expect(checking).rejects.toMatchObject({ code: kind === 'credential' ? 'configuration_unavailable' : 'inventory_changed' })
    expect(host.posts).toBe(0)
  } finally { release(); host.holdPrepare() }
})

it('retains an unknown provider commit and blocks ownership handoff until read-only observation confirms the exact comment', async () => {
  const { host, publication, authority, owner } = await fixture()
  host.loseProviderReply()
  const unknown = await host.client.call<PublicationReceipt>({ op: 'publish', publication })
  expect(unknown.phase).toBe('unknown'); expect(host.posts).toBe(1)
  await host.restart(); await owner.close()
  const inventory = InventoryPage.parse(await host.admin.call({ op: 'recovery.inventory', offset: 0 })), inspections = host.inspections
  await expect(host.client.call({ op: 'recovery.destination', revision: inventory.revision,
    destination: publication.destination, destinationHash: publication.destinationHash })).rejects.toMatchObject({ code: 'recovery_busy' })
  expect(host.inspections).toBe(inspections)
  const successor = new CoordinatorOwnership(authority.config); cleanup.push(() => successor.close())
  let active = false; const starting = successor.start().then(() => { active = true }); void starting.catch(() => {})
  await vi.waitFor(async () => expect((await authority.claimant.call<OwnershipView>({ op: 'lease.inspect' })).phase).toBe('preparing'))
  expect(active).toBe(false)
  expect(await host.client.call({ op: 'receipt.observe', id: publication.id })).toMatchObject({ phase: 'sent', external: { id: '1' }, ownership: unknown.ownership })
  await starting; expect(active).toBe(true); expect(host.posts).toBe(1)
  await expect(host.client.call({ op: 'publish', publication })).rejects.toThrow('unavailable')
}, 10_000)

it('does not treat an absent provider comment as proof of non-delivery, and requires separate administrator reconciliation', async () => {
  const { host, publication } = await fixture()
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve }); host.hold(held)
  const send = host.client.call<PublicationReceipt>({ op: 'publish', publication })
  await vi.waitFor(() => expect(host.posts).toBe(1))
  // Restart aborts the HTTP request locally; the provider can still commit it later.
  const restart = host.restart()
  const unknown = await send; await restart; expect(unknown.phase).toBe('unknown')
  expect(await host.client.call({ op: 'receipt.observe', id: publication.id })).toMatchObject({ phase: 'unknown' })
  await expect(host.client.call({ op: 'receipt.resolve', id: publication.id, note: 'Not an administrator', evidence: 'No independent evidence' })).rejects.toThrow('administrator')
  release(); host.hold()
  await vi.waitFor(() => expect(host.comments).toHaveLength(1))
  expect(await host.client.call({ op: 'receipt.observe', id: publication.id, externalId: '1' })).toMatchObject({ phase: 'sent' })
  expect(host.posts).toBe(1)
}, 10_000)

it('refuses wrong accounts before sending, validates content/destination digests and records explicit provider refusal', async () => {
  const { host, publication } = await fixture()
  await expect(host.client.call({ op: 'publish', publication: { ...publication, hash: '0'.repeat(64) } })).rejects.toThrow('approved digest')
  await expect(host.client.call({ op: 'publish', publication: { ...publication, destinationHash: '0'.repeat(64) } })).rejects.toThrow('approved digest')
  host.login('different-account')
  expect(await host.client.call({ op: 'publish', publication })).toMatchObject({ phase: 'failed' }); expect(host.posts).toBe(0)
  host.login('agent-bot'); host.refuse(true)
  expect(await host.client.call({ op: 'publish', publication: { ...publication, id: randomUUID() } })).toMatchObject({ phase: 'failed' })
  expect(host.posts).toBe(1)
})

it('retains destination identity and rejects browser or unpinned host requests', async () => {
  const { host, publication } = await fixture()
  const response = await fetch(host.connection.url + '/publication/v1', { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: JSON.stringify({ op: 'publish', publication }) })
  expect(response.status).toBe(403); expect(host.posts).toBe(0)
  await host.service.close()
  expect(() => new PublicationService({ ...host.config, destinations: [{ ...host.destination, name: 'Replaced destination' }] })).toThrow('cannot be removed or replaced')
})

it.each(['github-review', 'feishu-reply'] as const)('recovers an exact %s reply after an ambiguous commit and restart without another POST', async kind => {
  const { host, publication } = await fixture(kind)
  host.loseProviderReply()
  expect((await host.client.call<PublicationReceipt>({ op: 'publish', publication })).phase).toBe('unknown')
  await host.restart()
  const receipt = await host.client.call<PublicationReceipt>({ op: 'receipt.observe', id: publication.id })
  expect(receipt.phase).toBe('sent')
  expect(receipt.external?.url).toBe(kind === 'github-review'
    ? 'https://github.com/acme/project/pull/7#discussion_r1'
    : 'https://applink.feishu.cn/client/chat/open?openChatId=oc_chat')
  await vi.waitFor(async () => expect(await host.client.call({ op: 'publish', publication })).toEqual(receipt))
  expect(host.posts).toBe(1)
})

it.each(['parent', 'sender', 'body'] as const)('does not accept a Feishu receipt with a substituted %s', async field => {
  const { host, publication } = await fixture('feishu-reply')
  host.loseProviderReply()
  await host.client.call({ op: 'publish', publication })
  const message = host.messages[0]!, original = structuredClone(message)
  if (field === 'parent') message.parent_id = 'om_other'
  if (field === 'sender') message.sender = { id: 'cli_other', id_type: 'app_id', sender_type: 'app' }
  if (field === 'body') message.body = { content: JSON.stringify({ text: 'Substituted text' }) }
  expect(await host.client.call({ op: 'receipt.observe', id: publication.id, externalId: 'om_reply1' })).toMatchObject({ phase: 'unknown' })
  Object.assign(message, original)
  expect(await host.client.call({ op: 'receipt.observe', id: publication.id, externalId: 'om_reply1' })).toMatchObject({ phase: 'sent' })
  expect(host.posts).toBe(1)
})

it.each(['bot', 'chat'] as const)('refuses Feishu %s substitution before sending', async field => {
  const { host, publication } = await fixture('feishu-reply')
  if (field === 'bot') host.bot('ou_other'); else host.parentChat('oc_other')
  expect(await host.client.call({ op: 'publish', publication })).toMatchObject({ phase: 'failed' })
  expect(host.posts).toBe(0)
})

it('does not confirm a review reply under a different parent comment', async () => {
  const { host, publication } = await fixture('github-review')
  host.loseProviderReply(); await host.client.call({ op: 'publish', publication })
  host.comments[0]!.in_reply_to_id = 12
  expect(await host.client.call({ op: 'receipt.observe', id: publication.id, externalId: '1' })).toMatchObject({ phase: 'unknown' })
  host.comments[0]!.in_reply_to_id = 11
  expect(await host.client.call({ op: 'receipt.observe', id: publication.id, externalId: '1' })).toMatchObject({ phase: 'sent' })
  expect(host.posts).toBe(1)
})

it('rechecks ownership after asynchronous preparation and never dispatches the former owner’s accepted intent', async () => {
  const { host, publication, authority, owner } = await fixture()
  let release!: () => void; host.holdPrepare(new Promise<void>(resolve => { release = resolve }))
  const sending = host.client.call<PublicationReceipt>({ op: 'publish', publication })
  try {
    await vi.waitFor(() => expect(host.service.journal.get(publication.id)?.receipt.phase).toBe('accepted'))
    await owner.close()
    const successor = new CoordinatorOwnership(authority.config); cleanup.push(() => successor.close())
    const starting = successor.start(); void starting.catch(() => {})
    release()
    expect((await sending).phase).toBe('cancelled'); await starting
    expect(host.posts).toBe(0)
    expect(host.service.journal.get(publication.id)?.receipt.phase).toBe('cancelled')
  } finally { release(); host.holdPrepare() }
}, 10_000)

it('records independent reconciliation evidence durably and never replays a reconciled intent', async () => {
  const { host, publication } = await fixture()
  host.unavailable()
  expect((await host.client.call<PublicationReceipt>({ op: 'publish', publication })).phase).toBe('unknown')
  // The fixture administrator can inspect the completed handler; the ordinary client cannot infer this from HTTP 503.
  expect(host.comments).toHaveLength(0)
  const note = 'Provider operation settled without creating a comment', evidence = 'Independent provider audit: request handler returned before its commit branch'
  const receipt = await host.admin.call<PublicationReceipt>({ op: 'receipt.resolve', id: publication.id, note, evidence })
  expect(receipt).toMatchObject({ phase: 'not_delivered', reconciliation: { note, evidence } })
  await host.restart()
  await vi.waitFor(async () => expect(await host.client.call({ op: 'publish', publication })).toEqual(receipt))
  expect(host.posts).toBe(1)
})
