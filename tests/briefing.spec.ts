import { afterEach, expect, it } from 'vitest'
import { briefing } from '../src/app/views/briefing.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('serves a read-only briefing composed from the overview and schedules', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const result = await host.api('GET', 'briefing')
  expect(result.status).toBe(200)
  expect(result.body.at).toEqual(expect.any(String))
  expect(result.body.overview).toMatchObject({ person: [], flow: expect.objectContaining({ received: expect.any(Number) }) })
  expect(result.body.upcoming).toEqual([])
})

it('maps schedule summaries without inventing a next run', () => {
  const view = briefing({ person: [], problems: [], flow: {} } as never, { list: () => ({ items: [
    { id: 'schedule-1', title: 'Morning briefing', nextAt: undefined, enabled: true, open: 2 }
  ], nextOffset: null }) } as never, new Date('2026-11-15T12:00:00.000Z'))
  expect(view).toEqual({ at: '2026-11-15T12:00:00.000Z', overview: { person: [], problems: [], flow: {} },
    upcoming: [{ id: 'schedule-1', title: 'Morning briefing', nextAt: null, enabled: true, open: 2 }] })
})
