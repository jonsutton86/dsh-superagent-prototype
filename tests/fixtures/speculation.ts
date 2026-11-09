import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import { Store } from '../../src/app/store.ts'
import { key, latestAssignment, type Ticket } from '../../src/core/index.ts'
import { Usage } from '../../src/usage/service.ts'
import { Speculation } from '../../src/speculation/service.ts'
import { defaultSpeculation, type SpeculationPolicy } from '../../src/speculation/model.ts'

export function speculationFixture(path?: string) {
  const directory = path ?? mkdtempSync(join(tmpdir(), 'agentic-speculation-')), store = new Store(join(directory, 'state.sqlite'))
  let at = Date.parse('2026-11-09T12:00:00Z'), authorized = true, quiet = true, closed = false, capacity = 10, evidence = 'initial', spec: Speculation
  const usage = new Usage(store, () => at, call => spec.admitCall(call))
  const halt: Mock<(ticketId: string, reason: string, assignmentId: string) => void> = vi.fn()
  const provider: Mock<(ticket: Ticket) => Promise<string>> = vi.fn(async () => 'fixture'), busy = new Set<string>()
  spec = new Speculation({ store, usage, clock: () => at, authorized: () => authorized, evidence: ticket => key(JSON.stringify(ticket) + evidence),
    paused: () => false, capacity: () => capacity, busy: id => busy.has(id), provider, halt,
    quiet: async run => quiet && (!run.recovered || !!run.attestation) ? 'Fixture execution quiescence confirmed' : undefined, requestPass: vi.fn() })
  const close = async () => { if (!closed) { closed = true; await spec.close(); store.close() } }
  const dispose = async () => { await close(); if (!path) rmSync(directory, { recursive: true, force: true }) }
  const policy = (edit?: (policy: SpeculationPolicy) => void) => {
    const next = structuredClone(defaultSpeculation)
    next.run = { calls: 3, tokens: 1000, seconds: 60 }
    for (const quota of Object.values(next.limits)) Object.assign(quota, { concurrent: 10, calls: 100, tokens: 100000, seconds: 10000 })
    edit?.(next)
    const revision = spec.configuration().revision
    spec.configure({ requestId: `config-${revision}`, revision, policy: next })
  }
  const ticket = (id = 'first', strength: 'inferred' | 'explicit' = 'inferred', owner = 'alice', environment = 'local'): Ticket => {
    const now = new Date(at).toISOString()
    const value: Ticket = { id, title: `Prepare ${id}`, decisionId: `decision-${id}`, channels: [], inputs: [], undelivered: [],
      mandate: { strength, policyVersion: 'v1', basis: { via: 'admission', cell: 'unlistedUnaddressed', observation: { mode: 'auto' } }, actor: { source: 'fixture', id: owner }, scope: 'prepare' },
      assignments: [{ id: `${id}-assignment`, state: 'pending', createdAt: now }], createdAt: now, updatedAt: now,
      origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] }, follows: [] }
    if (environment !== 'local') value.execution = { name: id, directory: `/fixture/${id}`, assignment: 'Prepare',
      environment: { environmentId: environment } as NonNullable<NonNullable<Ticket['execution']>['environment']> }
    store.tickets.save(value); spec.queued(value, latestAssignment(value)!); return value
  }
  const run = (ticket: Ticket) => spec.get(spec.page().items.find(run => run.assignmentId === latestAssignment(ticket)!.id)!.id)
  const admit = (ticket: Ticket) => spec.admit(ticket, latestAssignment(ticket)!)
  const call = (ticket: Ticket, provider = 'fixture', ceiling: number | undefined = 100) => usage.begin({ sessionId: ticket.id, root: ticket.id, role: 'worker',
    ticketId: ticket.id, assignmentId: latestAssignment(ticket)!.id }, provider, 'model', 'conversation', ceiling)
  const ready = async (ticket: Ticket) => {
    latestAssignment(ticket)!.report = { state: 'ready', summary: 'Prepared with evidence', at: new Date(at).toISOString() }; store.tickets.save(ticket)
    await spec.tick(); return run(ticket)
  }
  return { directory, store, spec, usage, close, dispose, policy, ticket, run, admit, call, ready, halt, provider, busy,
    clock: (value: string) => { at = Date.parse(value) }, advance: (ms: number) => { at += ms }, quiet: (value: boolean) => { quiet = value },
    authorize: (value: boolean) => { authorized = value }, evidence: (value: string) => { evidence = value }, capacity: (value: number) => { capacity = value } }
}
