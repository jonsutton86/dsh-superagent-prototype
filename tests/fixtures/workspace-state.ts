import { Engine, type ChannelRef } from '../../src/core/index.ts'
import type { Store } from '../../src/app/store.ts'
import { settingsPolicy } from '../../src/policy.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { Workspace } from '../../src/workspace/service.ts'
import { Schedules } from '../../src/workspace/schedules.ts'
import { MissionPulls } from '../../src/workspace/pulls.ts'
import type { Publications } from '../../src/publication/runtime.ts'
import type { ScheduleDefinition } from '../../src/workspace/schedule-model.ts'
import type { Mission, MissionAction } from '../../src/workspace/model.ts'

export const workspaceTime = '2026-11-09T14:00:00.000Z'
export const scheduledPlan = { title: 'Scheduled review', objective: 'Review the recorded work', acceptance: 'Operator reviews the result',
  actions: [{ id: 'review', title: 'Review work', instructions: 'Report the recorded progress', owner: 'agent' as const, dependsOn: [] as string[] }] }
export const scheduleDefinition = (change: Partial<ScheduleDefinition> = {}): ScheduleDefinition => ({ title: 'Scheduled review',
  cadence: { kind: 'interval', start: workspaceTime, everyMinutes: 60 }, plan: structuredClone(scheduledPlan), missed: 'all',
  graceSeconds: 60, maxRuns: 10, maxOpen: 3, ...change })

/** Actual product/Engine transactions with no execution, publication or autonomous polling ports. */
export function workspaceStateFixture(store: Store, delivery?: (mission: Mission, action: MissionAction) => ChannelRef | undefined) {
  let engine: Engine, clock = Date.parse(workspaceTime), runnable = true
  const publication = new Proxy({} as Publications, { get: () => { throw new Error('This fixture must not contact a publication provider') } })
  const pulls = new MissionPulls(store, publication)
  const workspace = new Workspace(store, () => engine, () => runnable, undefined, undefined, undefined, undefined, delivery, undefined, pulls)
  const sources = new SourceRegistry(() => store.settings()); sources.register(workspace.source)
  engine = new Engine({ repo: store, scope: sources, policy: () => workspace.policy(settingsPolicy(store.settings(), sources)),
    now: () => new Date(clock).toISOString(), executor: { start: () => {}, deliver: () => {}, stop: () => {} }, assessor: { request: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const schedules = new Schedules(store, workspace, () => runnable, () => clock)
  return { store, workspace, schedules, engine, time: (value: string) => { clock = Date.parse(value) }, pause: (value: boolean) => { runnable = !value } }
}
