import { afterEach, expect, it } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'
import { stopRecord } from './fixtures/stop-record.ts'
import { saveStop } from '../src/executor/stop-store.ts'
import type { StopAttestationRequest } from '../src/executor/stop-model.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })
async function setup() {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const item = host.runtime.inbox.start({ requestId: 'operator-stop-contract', text: 'Prepare evidence' })
  await host.runtime.idle()
  const ticket = host.runtime.store.tickets.get(item.id)!, stop = stopRecord(ticket)
  saveStop(host.runtime.store.db, stop)
  const path = `tickets/${ticket.id}/assignments/${stop.assignmentId}/stops/${stop.id}`
  const request: StopAttestationRequest = { schema: 1, requestId: 'original-stop-confirmation', expectedRevision: stop.revision,
    executionBindingHash: stop.executionBindingHash, scopeHash: stop.scopeHash, confirmed: true,
    note: 'Independently inspected the original local process scope.' }
  return { host, ticket, stop, path, request }
}

it('binds operator routes to the original task and assignment and makes receipt reads observational', async () => {
  const { host, ticket, stop, path } = await setup(), before = host.runtime.store.tickets.get(ticket.id)
  const rows = () => host.runtime.store.db.prepare('SELECT value FROM executor_stop ORDER BY id').all()
  const originalRows = rows()
  expect(await host.api('GET', `tickets/${ticket.id}/stops?limit=1`)).toMatchObject({ status: 200, body: { items: [{ id: stop.id, assignmentId: stop.assignmentId }] } })
  expect(await host.api('GET', path + '/attestations/missing-original')).toMatchObject({ status: 200, body: { receipt: null, current: { id: stop.id } } })
  expect(await host.api('GET', path + '/attestations')).toMatchObject({ status: 200, body: { items: [], nextCursor: null } })
  expect(await host.api('GET', path.replace(stop.assignmentId, 'replacement-assignment'))).toMatchObject({ status: 404 })
  expect(await host.api('POST', path.replace(stop.assignmentId, 'replacement-assignment') + '/attest', {})).toMatchObject({ status: 404 })
  expect(rows()).toEqual(originalRows); expect(host.runtime.store.tickets.get(ticket.id)).toEqual(before)
})

it('durably refuses stale review and replays the exact receipt before current revision checks', async () => {
  const { host, stop, path, request } = await setup()
  saveStop(host.runtime.store.db, { ...stop, revision: 2 })
  const first = await host.api('POST', path + '/attest', request)
  expect(first).toMatchObject({ status: 200, body: { receipt: { phase: 'refused', request, observedRevision: 2 }, current: { state: 'unknown', revision: 2 } } })
  saveStop(host.runtime.store.db, { ...stop, revision: 3 })
  const recovered = await host.api('GET', path + '/attestations/' + request.requestId)
  expect(recovered.body.receipt).toEqual(first.body.receipt)
  const replay = await host.api('POST', path + '/attest', request)
  expect(replay.body.receipt).toEqual(first.body.receipt)
  expect(replay.body.current).toMatchObject({ revision: 3 })
  expect(await host.api('POST', path + '/attest', { ...request, expectedRevision: 3 })).toMatchObject({ status: 409 })
  expect(host.runtime.store.db.prepare('SELECT count(*) AS n FROM executor_stop_control').get()?.n).toBe(1)
})

it('rechecks original scope without scheduling cancellation, replacing assignments, or creating command receipts', async () => {
  const { host, ticket, stop, path } = await setup()
  const before = host.runtime.store.tickets.get(ticket.id), effects = host.runtime.store.db.prepare('SELECT * FROM effect ORDER BY kind,key').all()
  const result = await host.api('POST', path + '/recheck', { expectedRevision: stop.revision,
    executionBindingHash: stop.executionBindingHash, scopeHash: stop.scopeHash })
  expect(result).toMatchObject({ status: 200, body: { observationRequested: true, current: { id: stop.id, assignmentId: stop.assignmentId, state: 'unknown' } } })
  // Response loss may repeat the observation with its old revision; exact scope is still the same.
  expect(await host.api('POST', path + '/recheck', { expectedRevision: stop.revision,
    executionBindingHash: stop.executionBindingHash, scopeHash: stop.scopeHash })).toMatchObject({ status: 200,
      body: { observationRequested: true, current: { id: stop.id, assignmentId: stop.assignmentId } } })
  expect(host.runtime.store.tickets.get(ticket.id)).toEqual(before)
  expect(host.runtime.store.db.prepare('SELECT * FROM effect ORDER BY kind,key').all()).toEqual(effects)
  expect(host.runtime.store.db.prepare('SELECT count(*) AS n FROM executor_stop_control').get()?.n).toBe(0)
  expect(await host.api('POST', path + '/recheck', { expectedRevision: stop.revision,
    executionBindingHash: '0'.repeat(64), scopeHash: stop.scopeHash })).toMatchObject({ status: 409 })
})
