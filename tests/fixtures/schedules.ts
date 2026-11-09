import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'

/** Real scheduled Harness work, with a persisted disabled definition, operator enable, artifact checks and restart deduplication. */
export async function qualifySchedules(api: (path: string, body?: unknown, method?: string) => Promise<any>, environment: string, restart: () => Promise<void>): Promise<void> {
  const proof = `scheduled-${randomUUID()}`
  const request = { requestId: 'scheduled-qualification', enabled: false, definition: { title: 'Scheduled Harness proof',
    cadence: { kind: 'once', at: new Date().toISOString() }, missed: 'latest', graceSeconds: 60, maxRuns: 1, maxOpen: 1,
    plan: { title: 'Scheduled proof', objective: 'Produce an artifact from a persisted schedule', acceptance: 'Exact artifact and file bytes independently verified',
      actions: [{ id: 'proof', title: 'Produce scheduled proof', owner: 'agent', environment, dependsOn: [],
        instructions: `In your assigned directory, use bash to write exactly ${proof} to scheduled.txt with no newline. Read it back, publish that exact content with workspace_publish, then report ready. Do not call external services or delegate. If any tool fails, report failed immediately.` }] } } }
  const saved = await api('schedules', request)
  expect(saved.runs).toBe(0)
  await restart()
  expect(await api('schedules', request)).toMatchObject({ id: saved.id, revision: 1, runs: 0, enabled: false })
  const enable = { requestId: 'scheduled-enable', revision: 1, enabled: true }
  await api(`schedules/${saved.id}/enabled`, enable); await api(`schedules/${saved.id}/enabled`, enable)
  let mission: any
  await vi.waitFor(async () => {
    const schedule = await api(`schedules/${saved.id}`)
    expect(schedule.runs).toBe(1); expect(schedule.occurrences).toHaveLength(1)
    expect(schedule.occurrences[0].state, schedule.occurrences[0].error).toBe('active')
    mission = await api(`missions/${schedule.occurrences[0].missionId}`)
    expect(mission.actions[0].status).toBe('review')
  }, { timeout: 120_000, interval: 1000 })
  const task = mission.actions[0].runs[0], ticket = await api(`tickets/${task}`)
  expect(ticket.executionEnvironment.world).toBe(environment)
  expect(await readFile(join(ticket.directory, 'scheduled.txt'), 'utf8')).toBe(proof)
  const conversation = await api(`inbox/${task}`)
  const artifacts = await Promise.all(conversation.artifacts.map((item: { id: string }) => api(`library/${item.id}`)))
  expect(artifacts.some(item => item.provenance.ticketId === task && item.content === proof)).toBe(true)
  const usage = await api(`usage?scope=schedule&subject=${saved.id}`)
  expect(usage.totals.calls).toBeGreaterThan(0); expect(usage.totals.tokens).toBeGreaterThan(0)
  expect(usage.calls.some((call: any) => call.phase === 'reported' && call.owner.ticketId === task && call.owner.missionId === mission.id && call.owner.scheduleId === saved.id)).toBe(true)
  await restart()
  const restored = await api(`schedules/${saved.id}`)
  expect(restored).toMatchObject({ runs: 1, enabled: true, open: 1 })
  expect(restored.occurrences).toHaveLength(1)
  expect((await api(`missions/${mission.id}`)).actions[0].runs).toEqual([task])
  expect((await api(`tickets/${task}`)).assignments).toHaveLength(1)
  expect((await api(`usage?scope=schedule&subject=${saved.id}`)).totals).toEqual(usage.totals)
  await qualifyUsageLimit(api, environment, restart)
}

/** A real worker is refused before inference, then resumes on operator retry after its scoped allowance changes. */
async function qualifyUsageLimit(api: (path: string, body?: unknown, method?: string) => Promise<any>, environment: string, restart: () => Promise<void>): Promise<void> {
  const proof = `recalled-${randomUUID()}`
  const leaf = await api('library', { requestId: 'recall-leaf', kind: 'memory', title: 'Qualification source', summary: 'Original evidence', content: `The source verification code is ${proof}.` })
  const middle = await api('library', { requestId: 'recall-middle', kind: 'memory', title: 'Qualification summary', summary: 'Derived source', content: 'Use the original evidence for the verification code.', sources: [{ id: leaf.id, relation: 'derived_from' }] })
  const root = await api('library', { requestId: 'recall-root', kind: 'memory', title: 'Qualification brief', summary: 'Evidence chain', content: 'The linked source chain contains the required verification code.', sources: [{ id: middle.id, relation: 'derived_from' }] })
  let mission = await api('missions', { requestId: 'usage-mission', title: 'Usage limit proof', objective: 'Verify admission limits', acceptance: 'Worker resumes after allowance change' })
  mission = await api(`missions/${mission.id}/actions`, { requestId: 'usage-action', revision: mission.revision, title: 'Budgeted response', owner: 'agent', environment,
    instructions: `Use workspace_read on ${root.id} with depth 2. Read the source verification code from the oldest linked source. Report ready using your reporting tool with that exact code in the summary. Do not run commands, call external services or delegate.` })
  const config = (await api('usage')).configuration
  const budget = { id: 'qualification-mission', title: 'Qualification token allowance', scope: { kind: 'mission', id: mission.id }, period: 'lifetime', enabled: true, tokens: 1 }
  await api('usage', { requestId: 'usage-limit', revision: config.revision, prices: config.prices, budgets: [...config.budgets, budget] }, 'PUT')
  mission = await api(`missions/${mission.id}/actions/${mission.actions[0].id}`, { requestId: 'usage-start', revision: mission.revision, command: 'run' })
  await vi.waitFor(async () => {
    mission = await api(`missions/${mission.id}`)
    expect(mission.actions[0].ticket.retryable).toBe(true)
  }, { timeout: 30_000, interval: 500 })
  expect((await api(`usage?scope=mission&subject=${mission.id}`)).totals.calls).toBe(0)
  const current = (await api('usage')).configuration
  await api('usage', { requestId: 'usage-restore', revision: current.revision, prices: current.prices,
    budgets: current.budgets.map((item: any) => item.id === budget.id ? { ...item, enabled: false } : item) }, 'PUT')
  await api(`missions/${mission.id}/actions/${mission.actions[0].id}`, { requestId: 'usage-retry', revision: mission.revision, command: 'retry' })
  await vi.waitFor(async () => {
    const done = await api(`missions/${mission.id}`)
    expect(done.actions[0].status).toBe('review'); expect(done.actions[0].ticket.summary).toContain(proof)
    expect((await api(`usage?scope=mission&subject=${mission.id}`)).totals.tokens).toBeGreaterThan(0)
  }, { timeout: 60_000, interval: 500 })
  const task = (await api(`missions/${mission.id}`)).actions[0].runs[0]
  const attempts = (await api('recall')).attempts.filter((attempt: any) => attempt.owner.ticketId === task)
  expect(attempts.some((attempt: any) => attempt.operation === 'read' && attempt.phase === 'complete' && attempt.charged.pages >= 3 && attempt.charged.nodes >= 3)).toBe(true)
  await restart()
  expect((await api('recall')).attempts.filter((attempt: any) => attempt.owner.ticketId === task)).toEqual(attempts)
}
