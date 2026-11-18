/** Read-only local iCalendar (ICS) ingestion. No network, no account, no write, no execution authority. */
export interface CalendarEvent {
  uid: string
  summary: string
  description?: string
  start: string
  end: string
  allDay: boolean
}

export interface CalendarQuery {
  now?: Date
  days?: number
  limit?: number
}

const MAX_ICS_BYTES = 5 * 1024 * 1024
const DAY = 86_400_000

const unescape = (value: string): string => value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')

/** Folded lines are joined without losing the continuation's leading text. */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), out: string[] = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1)
    else out.push(line)
  }
  return out
}

function property(line: string): { name: string; params: string[]; value: string } {
  const colon = line.indexOf(':')
  if (colon < 0) return { name: line.toUpperCase(), params: [], value: '' }
  const left = line.slice(0, colon), parts = left.split(';')
  return { name: (parts[0] ?? '').toUpperCase(), params: parts.slice(1), value: line.slice(colon + 1) }
}

function instant(value: string): { date: Date; allDay: boolean } | undefined {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim())
  if (date) return { date: new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))), allDay: true }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value.trim())
  if (!time) return undefined
  const stamp = Date.UTC(Number(time[1]), Number(time[2]) - 1, Number(time[3]), Number(time[4]), Number(time[5]), Number(time[6]))
  return { date: new Date(stamp), allDay: false }
}

/** Parse VEVENTs from bounded ICS text and return the next calendar window, deterministically sorted. */
export function calendarEvents(text: string, query: CalendarQuery = {}): CalendarEvent[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_ICS_BYTES) throw new Error('Calendar file exceeds 5 MB')
  const now = query.now ?? new Date(), days = Math.max(1, Math.min(31, query.days ?? 7)), limit = Math.max(1, Math.min(50, query.limit ?? 20))
  const until = now.getTime() + days * DAY, events: CalendarEvent[] = []
  let inEvent = false
  let event: { uid?: string; summary?: string; description?: string; start?: { date: Date; allDay: boolean }; end?: { date: Date; allDay: boolean }; cancelled?: boolean } = {}
  for (const line of unfold(text)) {
    const upper = line.trim().toUpperCase()
    if (upper === 'BEGIN:VEVENT') { inEvent = true; event = {}; continue }
    if (upper === 'END:VEVENT') {
      inEvent = false
      if (event.cancelled || !event.start) continue
      const start = event.start.date, end = event.end?.date ?? new Date(start.getTime() + (event.start.allDay ? DAY : 3_600_000))
      if (end.getTime() < now.getTime() || start.getTime() > until) continue
      events.push({ uid: event.uid ?? '', summary: event.summary ?? '', ...(event.description ? { description: event.description } : {}),
        start: start.toISOString(), end: end.toISOString(), allDay: event.start.allDay })
      continue
    }
    if (!inEvent) continue
    const item = property(line)
    if (item.name === 'UID') event.uid = item.value.trim()
    else if (item.name === 'SUMMARY') event.summary = unescape(item.value)
    else if (item.name === 'DESCRIPTION') event.description = unescape(item.value)
    else if (item.name === 'STATUS') event.cancelled = item.value.trim().toUpperCase() === 'CANCELLED'
    else if (item.name === 'DTSTART') event.start = instant(item.value)
    else if (item.name === 'DTEND') event.end = instant(item.value)
  }
  return events.sort((a, b) => a.start.localeCompare(b.start)).slice(0, limit)
}
