import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { key, latestAssignment } from '../src/core/index.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { speculationFixture } from './fixtures/speculation.ts'
import { Outbox } from '../src/app/outbox.ts'
import type { SourceRegistry } from '../src/sources/registry.ts'
import type { SpeculationView } from '../src/speculation/model.ts'
import { ExecutionEffects } from '../src/remote/effects.ts'
import { RemoteWorkspace } from '../src/environments/remote-workspace.ts'
import type { RemoteWorld } from '../src/remote/world.ts'
import type { Commands } from '../src/infra/commands.ts'

let host: Host | undefined
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); await host?.stop(); vi.restoreAllMocks() })
async function prepare() {
  const h = host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true }), r = h.runtime
  const sent = vi.fn(async () => 'sent' as const)
  r.sources.register({ kind: 'probe', title: { en: 'Probe', zh: '测试' }, description: { en: '', zh: '' }, schema: z.object({}), fields: [], health: [],
    scope: () => ({ listened: true, observed: true }), channel: { send: sent, link: () => ({ url: '', label: { en: 'Fixture', zh: '测试' } }) } })
  await r.settings.save('eval', { ...r.store.settings().eval, mode: 'auto' }, r.store.blockRevision('eval'), 'panel')
  const policy = r.store.settings().policy
  await r.settings.save('policy', { ...policy, sources: { ...policy.sources, probe: { allowed: [{ id: 'alice' }], admission: {} } },
    rules: [{ id: 'probe', name: 'Prepare', enabled: true, instruction: 'Prepare the synthetic work locally' }] }, r.store.blockRevision('policy'), 'panel')
  const trigger = { id: 'probe-input', source: 'probe', threads: [{ source: 'probe', id: '1' }], actor: { source: 'probe', id: 'alice' }, human: true,
    at: new Date().toISOString(), text: 'A preparation opportunity', meta: {}, channel: { source: 'probe', thread: 'probe:1', address: { id: 'sink' } } }
  r.receive(trigger)
  const decision = r.engine.decide(trigger.id, { kind: 'accept', title: 'Prepare', name: 'prepare-fixture', scope: 'Synthetic work', reason: 'Fixture assessment', rules: ['probe'], acknowledgement: 'Prepared acknowledgement' })
  if (decision.kind !== 'accept') throw new Error('Fixture not accepted')
  await r.pump(); await r.idle()
  return { h, r, sent, ticket: r.store.tickets.get(decision.ticketId!)!, run: r.speculation.page().items[0]! }
}
it('uses the runtime launch/tool guards, durable HTTP reviews and separate outbox publication approvals', async () => {
  const { h, r, sent, ticket, run } = await prepare()
  expect(run.state).toBe('admitted'); expect(ticket.mandate.strength).toBe('inferred'); expect(sent).not.toHaveBeenCalled()
  r.engine.report(ticket.id, { state: 'ready', summary: 'Prepared result with retained evidence' })
  await r.idle(); await vi.waitFor(async () => { await r.speculation.tick(); expect(r.speculation.get(run.id).releasedAt).toBeDefined() })
  const ready = (await h.api('GET', `speculation/${run.id}`)).body
  expect(ready.state).toBe('ready')
  const promoted = await h.api('POST', `speculation/${run.id}/review`, { requestId: 'promote', revision: ready.revision, evidence: ready.evidence, command: 'promote', note: 'Evidence reviewed' })
  expect(promoted.status).toBe(200); expect(sent).not.toHaveBeenCalled()
  const message = (promoted.body as unknown as SpeculationView).messages.find((m: { id: string }) => m.id === key('ack', 'probe-input'))!
  expect(message.approved).toBe(false)
  const approval = await h.api('POST', `speculation/${run.id}/messages`, { requestId: 'send', revision: promoted.body.revision, receiptId: message.id, fingerprint: message.fingerprint, note: 'Exact message reviewed' })
  expect(approval.status).toBe(200)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await r.pump(); await r.sendReplies() } finally { vi.useRealTimers() }
  expect(sent).toHaveBeenCalledOnce(); expect(r.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
  expect((await h.api('GET', 'speculation/versions/0')).status).toBe(200)
})
it('stops old speculative activity without cancelling a newly queued assignment', async () => {
  const { r, ticket, run } = await prepare()
  r.engine.report(ticket.id, { state: 'blocked', summary: 'Needs retry' }); r.engine.retryTicket(ticket.id)
  const next = latestAssignment(r.store.tickets.get(ticket.id)!)!
  await r.speculation.tick()
  const row = r.store.db.prepare("SELECT 1 FROM effect WHERE kind='launch' AND key=?").get(next.id)
  expect(row).toBeDefined(); expect(r.speculation.get(run.id).state).toBe('cancelled')
})
it('rechecks publication authority after asynchronous observation but settles an already accepted delivery', async () => {
  const f = speculationFixture(); cleanup.push(f.dispose); f.policy(); const ticket = f.ticket(); await f.admit(ticket)
  const message = { id: 'message', ticketId: ticket.id, kind: 'reply' as const, text: 'Prepared', channel: { source: 'probe', thread: 'probe:1', address: {} } }
  f.store.receipts.add(message); const ready = await f.ready(ticket), promoted = f.spec.review(ready.id, { requestId: 'promote', revision: ready.revision, evidence: ready.evidence, command: 'promote', note: 'Reviewed' })
  f.spec.approveMessage(ready.id, { requestId: 'approve', revision: promoted.revision, receiptId: message.id, fingerprint: promoted.messages[0]!.fingerprint, note: 'Reviewed' })
  let deliver!: (payload: unknown, id: string) => Promise<void>
  const send = vi.fn(async () => 'sent' as const), observe = vi.fn(async () => { f.advance(24 * 60 * 60000); return undefined as 'sent' | undefined })
  new Outbox({ store: f.store, commands: {} as Commands, paused: () => false,
    effects: { enqueue: vi.fn(), cancel: vi.fn(), idle: async () => {}, handle: (_kind, handler) => { deliver = handler as typeof deliver } },
    sources: { instance: (() => ({ id: 'probe', kind: 'probe', enabled: true, config: {} })) as SourceRegistry['instance'], channelAllowed: () => true, send },
    publication: { observe, withdraw: () => false }, publicationProblem: message => f.spec.messageProblem(message) })
  await expect(deliver({}, message.id)).rejects.toThrow('unexpired'); expect(send).not.toHaveBeenCalled()
  observe.mockResolvedValue('sent'); await deliver({}, message.id); expect(f.store.receipts.get(message.id)!.status).toBe('sent'); expect(send).not.toHaveBeenCalled()
})

it('checks original remote execution bindings and all receipts beyond the display page before release', async () => {
  const { r, ticket, run } = await prepare()
  r.engine.report(ticket.id, { state: 'ready', summary: 'Prepared' }); await r.idle()
  r.executor.halt(ticket.id, 'Stop for receipt check', run.assignmentId); await r.idle()
  const journal = new ExecutionEffects(r.store.db)
  for (let i = 0; i < 105; i++) r.store.db.prepare('INSERT INTO execution_effect VALUES (?,?)').run(`receipt-${i}`, JSON.stringify({
    id: `receipt-${i}`, owner: { ticketId: ticket.id }, createdAt: String(i).padStart(4, '0'), phase: 'settled', quiescent: i !== 0 }))
  expect(journal.list(ticket.id).items.every(item => item.quiescent)).toBe(true); expect(journal.quiescent(ticket.id)).toBe(false)
  const refreshEffects = vi.fn(async () => {}), remote = new RemoteWorkspace({ refreshEffects, quiescent: (id: string) => journal.quiescent(id) } as unknown as RemoteWorld, host!.ctx.fs, host!.ctx.subprocess, new AbortController().signal)
  const lookup = vi.spyOn(r.environments, 'remoteFor').mockReturnValue(remote)
  const recovered = { ...run, recovered: true, attestation: { at: new Date().toISOString(), note: 'Local attestation cannot override remote receipts' } }
  await vi.waitFor(async () => { expect(await r.executor.quiescence(recovered)).toBeUndefined(); expect(refreshEffects).toHaveBeenCalled() })
  expect(lookup.mock.calls.at(-1)![0].execution).toEqual(run.execution)
  journal.revoked(); expect(journal.quiescent(ticket.id)).toBe(true)
  expect(await r.executor.quiescence(recovered)).toContain('original endpoint effect receipts')
})
