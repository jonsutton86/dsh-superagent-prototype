import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { key, type Ticket } from '../src/core/index.ts'
import { reconcileConsumedInputs } from '../src/recovery/inputs.ts'
import { exportSession, type SessionArchive } from '../src/recovery/sessions.ts'
import { inputMessage, inputTicket, inputTime } from './fixtures/recovery-inputs.ts'

const consume = (session: Session, message: UserMessage) => session.append('user/message', message, { surfaceOp: 'append' })
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-recovery-inputs-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Jsonl, { root: join(directory, 'sessions'), compression: 'none' })
  const store = new Store(join(directory, 'state.sqlite')); cleanup.push(() => store.close())
  const archives: SessionArchive[] = [], abort = new AbortController()
  const save = (ticket: Ticket) => store.db.prepare('INSERT INTO ticket(id,value) VALUES (?,?)').run(ticket.id, JSON.stringify(ticket))
  const read = (id = 'ticket'): Ticket => JSON.parse(String(store.db.prepare('SELECT value FROM ticket WHERE id=?').get(id)!.value))
  const archive = async (id: string, populate: (value: Session) => void, inherited = 0) => {
    const session = Session.create(SessionId(id)); populate(session)
    const writer = await ctx.sessionPersistence.create({ ...session.header, ...(inherited ? { parentSession: SessionId('ancestor'), isSeeded: true } : {}) },
      { inheritedEventCount: SessionLogOffset(inherited) })
    try {
      await writer.append(session.snapshotEvents())
      archives.push(await exportSession(writer, join(directory, id + '.jsonl'), id + '.jsonl', abort.signal))
    } finally { await writer.close() }
  }
  const run = () => reconcileConsumedInputs(store.db, directory, archives, abort.signal)
  return { ctx, directory, store, archives, abort, save, read, archive, run }
}

it('repairs only missing live acknowledgements from fully authenticated history, preserving authority and assignment state', async () => {
  const f = await fixture(), original = inputTicket(); f.save(original)
  const messages = [inputMessage('input')]
  await f.archive('worker-ticket', session => consume(session, messages[0]!))
  expect(await f.run()).toEqual({ tickets: 1, inputs: 1, consumed: 1, readMarkers: 1, undelivered: 1 })
  const repaired = f.read(), { inputs } = repaired
  expect(repaired).toEqual({ ...original, inputs: [{ ...original.inputs[0], readAt: expect.any(String) }], undelivered: [] })
  expect(inputs[0]).toMatchObject({ deliveredTo: 'assignment' })
  expect(await f.run()).toEqual({ tickets: 1, inputs: 1, consumed: 1, readMarkers: 0, undelivered: 0 })
})

it.each(['queued', 'claimed', 'canceled'] as const)('does not count %s inbox work as a consumed user message', async kind => {
  const f = await fixture(), original = inputTicket(); f.save(original)
  await f.archive('worker-ticket', session => {
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [inputMessage('input')] })
    if (kind !== 'queued') session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], ...(kind === 'canceled' ? { outcome: 'canceled' as const } : {}) })
  })
  expect(await f.run()).toMatchObject({ consumed: 0, readMarkers: 0, undelivered: 0 }); expect(f.read()).toEqual(original)
})
it('ignores an ordinary user message even if its ID matches the orchestrator receipt', async () => {
  const f = await fixture(), original = inputTicket(); f.save(original)
  await f.archive('worker-ticket', session => consume(session, { ...inputMessage('input'), source: { kind: 'user' } }))
  expect((await f.run()).consumed).toBe(0); expect(f.read()).toEqual(original)
})
it('recognizes the legacy RPC delivery identity without altering Session history', async () => {
  const f = await fixture(); f.save(inputTicket())
  const old = createUserMessage({ source: { kind: 'user', rpcId: key('input') }, content: [] })
  await f.archive('worker-ticket', session => consume(session, old))
  expect((await f.run()).readMarkers).toBe(1)
})
it('does not attribute inherited messages to the worker; scans beyond the first page', async () => {
  const f = await fixture(), original = inputTicket(); f.save(original)
  await f.archive('worker-ticket', session => {
    for (let index = 0; index < 130; index++) consume(session, inputMessage(index === 0 ? 'input' : 'unrelated-' + index))
    session.append('session/end-seed', { inherited: true })
  }, 130)
  expect((await f.run()).consumed).toBe(0); expect(f.read()).toEqual(original)
  const own = await fixture(); own.save(original)
  await own.archive('worker-ticket', session => {
    for (let index = 0; index < 130; index++) consume(session, inputMessage('unrelated-' + index))
    session.append('session/end-seed', { inherited: true })
    consume(session, inputMessage('input'))
  }, 130)
  expect((await own.run()).readMarkers).toBe(1)
})
it('rejects duplicate consumed receipts rather than choosing one', async () => {
  const f = await fixture(), original = inputTicket(); f.save(original)
  await f.archive('worker-ticket', session => { consume(session, inputMessage('input')); consume(session, inputMessage('input')) })
  await expect(f.run()).rejects.toMatchObject({ code: 'input_delivery_duplicate' }); expect(f.read()).toEqual(original)
})
it('keeps never-created pending Sessions and legacy unknown acknowledgements unchanged', async () => {
  const f = await fixture(), original = inputTicket(); delete (original.inputs[0] as { readAt?: string | null }).readAt; f.save(original)
  expect(await f.run()).toMatchObject({ consumed: 0, readMarkers: 0, undelivered: 0 }); expect(f.read()).toEqual(original)
})
it.each([false, true])('rejects a modern read marker without consumed evidence (ended=%s)', async ended => {
  const f = await fixture(), original = inputTicket(); (original.inputs[0] as { readAt: string }).readAt = inputTime
  if (ended) original.ended = { at: inputTime, by: 'executor', outcome: 'completed' }
  f.save(original); await expect(f.run()).rejects.toMatchObject({ code: 'input_read_missing' }); expect(f.read()).toEqual(original)
})
it('preserves ended ticket outcomes and acknowledgements even with missing acknowledgements', async () => {
  const f = await fixture(), original = inputTicket(); original.ended = { at: inputTime, by: 'human', outcome: 'stopped' }; f.save(original)
  await f.archive('worker-ticket', session => consume(session, inputMessage('input')))
  expect(await f.run()).toMatchObject({ consumed: 1, readMarkers: 0, undelivered: 0 }); expect(f.read()).toEqual(original)
})
it('reconciles all input kinds, including legacy reopen, without adding read fields to non-triggers', async () => {
  const f = await fixture(), original = inputTicket('ticket', [
    { id: 'policy', kind: 'policy-changed', from: 'a', to: 'b', at: inputTime },
    { id: 'reopen', kind: 'reopen', decisionId: 'decision', at: inputTime },
    { id: 'resume', kind: 'resumed', triggerId: 'trigger', at: inputTime },
    { id: 'text', kind: 'text', text: 'Task input', at: inputTime }, { id: 'note', kind: 'note', text: 'Context only', at: inputTime },
  ]); f.save(original)
  await f.archive('worker-ticket', session => { for (const input of original.inputs) consume(session, inputMessage(input.id)) })
  expect(await f.run()).toMatchObject({ consumed: 5, readMarkers: 0, undelivered: 5 })
  expect(f.read()).toEqual({ ...original, undelivered: [] })
})
it.each(['tamper', 'contradiction', 'cancel'] as const)('rolls back earlier ticket repairs on a later %s', async failure => {
  const f = await fixture(), first = inputTicket('a'), second = inputTicket('z'); f.save(first)
  await f.archive('worker-a', session => consume(session, inputMessage('input')))
  if (failure === 'contradiction') (second.inputs[0] as { readAt: string }).readAt = inputTime
  f.save(second)
  if (failure === 'tamper') {
    await f.archive('worker-z', session => consume(session, inputMessage('input')))
    await appendFile(join(f.directory, 'worker-z.jsonl'), '\n')
  }
  if (failure === 'cancel') {
    const original = f.abort.signal.throwIfAborted.bind(f.abort.signal), check = vi.spyOn(f.abort.signal, 'throwIfAborted')
    check.mockImplementation(() => { if (f.read('a').undelivered.length === 0) f.abort.abort(new Error('Maintenance canceled')); original() })
  }
  await expect(f.run()).rejects.toThrow(failure === 'cancel' ? 'Maintenance canceled' : undefined)
  expect(f.read('a')).toEqual(first); expect(f.read('z')).toEqual(second)
})
it.each(['duplicate-input', 'duplicate-queue', 'unknown-queue', 'bad-kind', 'bad-time', 'null'] as const)('rejects malformed %s with a safe code', async kind => {
  const f = await fixture(), ticket = inputTicket()
  if (kind === 'duplicate-input') ticket.inputs.push(ticket.inputs[0]!)
  if (kind === 'duplicate-queue') ticket.undelivered.push('input')
  if (kind === 'unknown-queue') ticket.undelivered.push('absent')
  if (kind === 'bad-kind') Object.assign(ticket.inputs[0]!, { kind: 'unknown' })
  if (kind === 'bad-time') Object.assign(ticket.inputs[0]!, { readAt: 'synthetic-private-input' })
  f.save(ticket)
  if (kind === 'null') f.store.db.prepare('UPDATE ticket SET value=?').run('null')
  await expect(f.run()).rejects.toMatchObject({ code: 'input_state_invalid', message: 'input_state_invalid' })
})
