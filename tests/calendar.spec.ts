import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { calendarEvents } from '../src/calendar/ics.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const DAY = 86_400_000
const now = new Date('2026-11-18T12:00:00.000Z')
const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:meeting-1\r\nSUMMARY:Design review\\, part 2\r\nDESCRIPTION:Review the \n folded brief\r\nDTSTART:20261119T090000Z\r\nDTEND:20261119T100000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:all-day\r\nSUMMARY:Offsite\r\nDTSTART;VALUE=DATE:20261120\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:cancelled\r\nSUMMARY:Cancelled sync\r\nDTSTART:20261119T110000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:past\r\nSUMMARY:Past sync\r\nDTSTART:20261110T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`

let host: Host | undefined
const files: string[] = []
afterEach(async () => { await host?.stop(); host = undefined; vi.unstubAllEnvs(); for (const file of files.splice(0)) rmSync(file, { force: true }) })

it('parses folded text, cancelled and past events, all-day dates and the requested window', () => {
  const items = calendarEvents(ics, { now, days: 7, limit: 20 })
  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({ uid: 'meeting-1', summary: 'Design review, part 2', start: '2026-11-19T09:00:00.000Z', allDay: false })
  expect(items[0]!.description).toContain('Review the folded brief')
  expect(items[1]).toMatchObject({ uid: 'all-day', summary: 'Offsite', start: '2026-11-20T00:00:00.000Z', allDay: true })
  expect(calendarEvents(ics, { now, days: 7, limit: 1 })).toHaveLength(1)
  expect(calendarEvents('BEGIN:VCALENDAR\nEND:VCALENDAR', { now })).toEqual([])
})

it('serves an unconfigured calendar and a configured local ICS file through the API', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  expect((await host.api('GET', 'calendar')).body).toMatchObject({ configured: false, items: [] })
  const directory = mkdtempSync(join(tmpdir(), 'dsh-calendar-')), file = join(directory, 'calendar.ics')
  writeFileSync(file, ics); files.push(file); vi.stubEnv('DSH_ORCHESTRATOR_CALENDAR_ICS', file)
  const configured = await host.api('GET', 'calendar?days=7&limit=5')
  expect(configured.status).toBe(200)
  expect(configured.body).toMatchObject({ configured: true, items: expect.arrayContaining([expect.objectContaining({ uid: 'meeting-1' })]) })
  vi.stubEnv('DSH_ORCHESTRATOR_CALENDAR_ICS', join(directory, 'missing.ics'))
  expect((await host.api('GET', 'calendar')).status).toBe(409)
})
