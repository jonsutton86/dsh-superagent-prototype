import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ownershipAuthority } from './fixtures/ownership-authority.ts'
import { publicationFixture } from './fixtures/publication.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { contentHash } from '../src/publication/github.ts'
import { DestinationView, PublicationReceipt, type Publication } from '../src/publication/protocol.ts'
import { PublicationService } from '../src/publication/service.ts'
import type { OwnershipView } from '../src/ownership/protocol.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
async function fixture() {
  const authority = await ownershipAuthority(cleanup), owner = new CoordinatorOwnership(authority.config)
  const host = await publicationFixture(cleanup, authority.resource, owner)
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
  await expect(host.client.call({ op: 'publish', publication: { ...publication, text: 'Different', hash: contentHash('Different'), artifact: { ...publication.artifact, hash: contentHash('Different') } } })).rejects.toThrow('different content')
  await host.restart()
  expect(await host.client.call({ op: 'receipt.get', id: publication.id })).toEqual(original)
  await vi.waitFor(async () => expect(await host.client.call({ op: 'publish', publication })).toEqual(original))
  expect(host.posts).toBe(1)
  expect(JSON.stringify(original)).not.toContain(host.secret)
})

it('retains an unknown provider commit and blocks ownership handoff until read-only observation confirms the exact comment', async () => {
  const { host, publication, authority, owner } = await fixture()
  host.loseProviderReply()
  const unknown = await host.client.call<PublicationReceipt>({ op: 'publish', publication })
  expect(unknown.phase).toBe('unknown'); expect(host.posts).toBe(1)
  await host.restart(); await owner.close()
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
  expect(() => new PublicationService({ ...host.config, destinations: [{ ...host.destination, issue: 8 }] })).toThrow('cannot be removed or replaced')
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
