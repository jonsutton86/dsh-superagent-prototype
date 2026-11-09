/** Exact occurrence calculation with explicit wall-clock DST disambiguation. */
import { Temporal } from '@js-temporal/polyfill'
import type { Cadence } from './schedule-model.ts'

const iso = (ms: number): string => new Date(ms).toISOString()
/** Validate calendar zone names independently of the machine's local timezone. */
export function validateCadence(cadence: Cadence): void {
  if (cadence.kind === 'calendar') {
    if (/^[+-]/.test(cadence.timeZone)) throw new RangeError('Choose a named time zone')
    Temporal.PlainDate.from(cadence.startDate).toZonedDateTime(cadence.timeZone)
  }
}
/** The first authorized time, including an intentionally historical start for a bounded catch-up policy. */
export function firstOccurrence(cadence: Cadence): string {
  if (cadence.kind === 'once') return cadence.at
  if (cadence.kind === 'interval') return cadence.start
  return occurrenceAt(cadence, Temporal.PlainDate.from(cadence.startDate).toZonedDateTime(cadence.timeZone).epochMilliseconds, 1)!
}
/** Find the first occurrence at/after, or last at/before, an instant without scanning an unbounded missed interval. */
export function occurrenceAt(cadence: Cadence, instant: number, direction: 1 | -1): string | undefined {
  if (cadence.kind === 'once') return direction * (Date.parse(cadence.at) - instant) >= 0 ? cadence.at : undefined
  if (cadence.kind === 'interval') {
    const start = Date.parse(cadence.start), period = cadence.everyMinutes * 60000
    const step = direction === 1 ? Math.max(0, Math.ceil((instant - start) / period)) : Math.floor((instant - start) / period)
    return step < 0 ? undefined : iso(start + step * period)
  }
  const start = Temporal.PlainDate.from(cadence.startDate)
  let date = Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(cadence.timeZone).toPlainDate()
  if (Temporal.PlainDate.compare(date, start) < 0) { if (direction < 0) return; date = start }
  for (let i = 0; i < 9; i++, date = date.add({ days: direction })) {
    if (Temporal.PlainDate.compare(date, start) < 0) return
    if (!cadence.weekdays.includes(date.dayOfWeek)) continue
    // compatible: shift a nonexistent time forward by the gap; choose the first of a repeated time, once per date.
    const value = date.toPlainDateTime(cadence.time).toZonedDateTime(cadence.timeZone, { disambiguation: 'compatible' }).epochMilliseconds
    if (direction * (value - instant) >= 0) return iso(value)
  }
  throw new RangeError('No occurrence within the calendar window')
}
