/** Read-only operator briefing composed from the existing overview and schedule state. */
import type { Schedules } from '../../workspace/schedules.ts'
import type { OverviewView } from './overview.ts'

export interface BriefingView {
  at: string
  overview: OverviewView
  /** The next scheduled runs, as the schedule service reports them; never a prediction. */
  upcoming: { id: string; title: string; nextAt: string | null; enabled: boolean; open: number }[]
}

/** Compose a briefing without adding a source, a scheduler or any external call. */
export function briefing(overview: OverviewView, schedules: Pick<Schedules, 'list'> | undefined, now = new Date()): BriefingView {
  return {
    at: now.toISOString(),
    overview,
    upcoming: schedules?.list(0, 5).items.map(item => ({ id: item.id, title: item.title, nextAt: item.nextAt ?? null, enabled: item.enabled, open: item.open })) ?? []
  }
}
