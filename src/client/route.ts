/** Typed panel routes, route parser, and sessionStorage location history. */
import { THREAD_FILTERS, TICKET_FILTERS, INBOX_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
import type { InboxFilter } from '../workspace/inbox-model.ts'
import type { SetupPlace } from '../setup.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { T } from './text.ts'

export const TABS = ['inbox', 'missions', 'schedules', 'reflections', 'speculation', 'library', 'personas', 'usage', 'environments', 'overview', 'source', 'trigger', 'eval', 'execution', 'settings'] as const
export type Tab = typeof TABS[number]
export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'prompts', 'deployment'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
export type Route = { page: 'overview' | 'source' | 'environments' | 'personas'; id?: undefined; query?: undefined }
  | { page: 'inbox'; id?: string; query?: { filter?: InboxFilter } }
  | { page: 'missions'; id?: string; query?: undefined }
  | { page: 'reflections' | 'speculation'; id?: string; query?: undefined }
  | { page: 'schedules'; id?: string; query?: { mission?: string } }
  | { page: 'usage'; id?: undefined; query?: { scope?: 'workspace' | 'mission' | 'schedule' | 'persona'; subject?: string } }
  | { page: 'library'; id?: string; query?: { scope?: string } }
  | { page: 'trigger'; id?: undefined; query?: { filter?: ThreadFilter } }
  | { page: 'trigger'; id: string; query?: { trigger?: string } }
  | { page: 'eval'; id?: undefined; query?: { filter?: DecisionFilter; window?: '24h' } }
  | { page: 'execution'; id?: undefined; query?: { filter?: TicketFilter } }
  | { page: 'execution'; id: string; query?: undefined }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } }
export const HOME: Route = { page: 'overview' }
export const settingsRoute = (group: SettingsGroup, query: { source?: string; version?: string } = {}): Route =>
  ({ page: 'settings', query: { group, ...query } })
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : settingsRoute('source', { source: place })
export const routeLabel = (t: T, route: Route): string =>
  route.id ? t(route.page === 'speculation' ? 'tab.speculation' : route.page === 'reflections' ? 'tab.reflections' : route.page === 'schedules' ? 'tab.schedules' : route.page === 'inbox' ? 'tab.inbox' : route.page === 'missions' ? 'tab.missions' : route.page === 'library' ? 'tab.library' : route.page === 'trigger' ? 'term.thread' : 'term.ticket') : t(`tab.${route.page}`)

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/** Validate and normalize a stored route, dropping unrecognized query filters or removed tabs (such as the legacy `policy` tab). */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  switch (page) {
    case 'inbox': return record ? { page, id: record } : { page, query: compact({ filter: pick(INBOX_FILTERS, query?.filter) }) }
    case 'library': return { page, ...(record ? { id: record } : {}), query: compact({ scope: text('scope') }) }
    case 'missions': case 'reflections': case 'speculation': return record ? { page, id: record } : { page }
    case 'usage': {
      const scope = pick(['workspace', 'mission', 'schedule', 'persona'] as const, query?.scope)
      const subject = text('subject')
      return scope && scope !== 'workspace' && subject && /^[a-zA-Z0-9_-]{1,100}$/.test(subject) ? { page, query: { scope, subject } } : { page }
    }
    case 'schedules': return record ? { page, id: record } : { page, query: compact({ mission: text('mission') }) }
    case 'overview': case 'source': case 'environments': case 'personas': return { page }
    case 'trigger': return record ? { page, id: record, query: compact({ trigger: text('trigger') }) }
      : { page, query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) }
    case 'eval': return { page, query: compact({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) }
    case 'execution': return record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter) }) }
    case 'settings': return { page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'source',
      ...compact({ source: text('source'), version: text('version') }) } }
    default: return undefined
  }
}

const ROUTE_KEY = 'dsh-superagent/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'source'
export function initialLocation(): Location {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    const route = parseRoute(stored?.route)
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
  } catch (error) {
    // Route memory is a convenience; an unreadable value falls back to HOME.
    void error
  }
  return { route: HOME, stack: [] }
}
export function remember(location: Location): void {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch (failure) { void failure /* Route memory is a convenience. */ }
}
