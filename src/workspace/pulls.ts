import type { Store } from '../app/store.ts'
import type { Publications } from '../publication/runtime.ts'
import { fingerprint, timestamp } from '../remote/journal.ts'
import { WorkspaceError } from './model.ts'
import { ConfigureMissionPull, PullTarget, pullIdentity, type MissionPullAcceptance, type MissionPullState } from './pull-model.ts'
import type { PullObservation } from '../publication/pull-model.ts'
import { FRESHNESS_WINDOW_MS } from '../verification/review-model.ts'

/** Durable, immutable operator-selected targets; failed reads invalidate claims of a currently observed PR head. */
export class MissionPulls {
  private readonly pending = new Set<Promise<unknown>>()
  private stopped = false
  constructor(private readonly store: Store, private readonly publications: Publications) {
    store.db.exec('CREATE TABLE IF NOT EXISTS mission_pull_target (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }
  state(id: string): MissionPullState {
    const row = this.store.db.prepare('SELECT value FROM mission_pull_target WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Mission PR target not found')
    return JSON.parse(String(row.value))
  }
  private save(state: MissionPullState): void {
    this.store.db.prepare('INSERT INTO mission_pull_target VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(state.target.id, JSON.stringify(state))
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new WorkspaceError(409, 'Mission PR inspection is stopping'))
    const pending = operation().finally(() => this.pending.delete(pending))
    this.pending.add(pending); return pending
  }
  prepare(input: Extract<ConfigureMissionPull, { enabled: true }>): Promise<PullTarget> {
    return this.track(() => this.prepareTarget(input))
  }
  private async prepareTarget(input: Extract<ConfigureMissionPull, { enabled: true }>): Promise<PullTarget> {
    const destination = (await this.publications.destinations()).items.find(item => item.id === input.destination && item.hash === input.destinationHash && item.kind === 'github-pr-review')
    if (!destination) throw new WorkspaceError(409, 'Select a configured PR review destination')
    const initial = await this.publications.inspectPull(destination.id, destination.hash)
    if (initial.hash !== input.pullHash) throw new WorkspaceError(409, 'The PR changed since inspection; inspect and approve its current identity')
    return PullTarget.parse({ id: input.requestId, name: destination.name, destination: destination.id, destinationHash: destination.hash,
      identity: fingerprint(pullIdentity(initial.binding)), initial, createdAt: timestamp() })
  }
  /** Called inside the mission command transaction, so a failed plan revision leaves no orphan binding. */
  install(input: PullTarget): void {
    const target = PullTarget.parse(input)
    if (this.store.db.prepare('SELECT 1 FROM mission_pull_target WHERE id=?').get(target.id)) throw new WorkspaceError(409, 'PR target ID already exists')
    this.save({ target, observation: target.initial, attemptedAt: target.createdAt, observationRevision: 1 })
    const size = this.store.db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM mission_pull_target').get()!
    if (Number(size.n) > 10000 || Number(size.bytes) > 64 * 1024 * 1024) throw new WorkspaceError(409, 'Mission PR target journal capacity reached')
  }
  private matches(target: PullTarget, observation: PullObservation): boolean {
    return observation.destination === target.destination && observation.destinationHash === target.destinationHash
      && observation.hash === fingerprint(observation.binding) && target.identity === fingerprint(pullIdentity(observation.binding))
  }
  inspect(id: string, expected?: string): Promise<PullObservation> {
    return this.track(() => this.inspectTarget(id, expected))
  }
  private async inspectTarget(id: string, expected?: string): Promise<PullObservation> {
    const state = this.state(id)
    state.observationRevision++; state.attemptedAt = timestamp(); state.problem = 'PR observation is pending'; this.save(state)
    let observation: PullObservation
    try {
      observation = await this.publications.inspectPull(state.target.destination, state.target.destinationHash)
      if (this.state(id).observationRevision !== state.observationRevision) throw new WorkspaceError(409, 'A newer PR inspection superseded this observation')
      state.attemptedAt = timestamp(); state.observation = observation; delete state.problem; this.save(state)
      if (!this.matches(state.target, observation)) throw new WorkspaceError(409, 'PR identity or branches changed; explicitly bind the intended target again')
    } catch (error) {
      if (this.state(id).observationRevision === state.observationRevision) {
        state.attemptedAt = timestamp(); state.problem = 'PR observation failed or changed; inspect the target again before accepting or closing this mission'; this.save(state)
      }
      throw error
    }
    if (expected && observation.hash !== expected) throw new WorkspaceError(409, 'The PR changed since result review; inspect the current head')
    return observation
  }
  assert(id: string, observation: PullObservation): MissionPullAcceptance {
    const state = this.state(id), now = Date.now(), at = Date.parse(observation.observedAt)
    if (state.problem || !this.matches(state.target, observation) || state.observation?.hash !== observation.hash || at > now + 5000 || at + FRESHNESS_WINDOW_MS <= now)
      throw new WorkspaceError(409, 'Mission PR observation is stale or changed; inspect the current head')
    if (observation.binding.state !== 'open' && !observation.binding.merged) throw new WorkspaceError(409, 'The mission PR was closed without merging')
    return { target: id, observation }
  }
  current(id: string, accepted?: MissionPullAcceptance): boolean {
    try {
      const state = this.state(id)
      return !!accepted && accepted.target === id && !state.problem && !!state.observation && this.matches(state.target, accepted.observation)
        && state.observation.hash === accepted.observation.hash && (state.observation.binding.state === 'open' || state.observation.binding.merged)
    } catch { return false }
  }
  describe(id: string): string {
    const { target } = this.state(id), pull = target.initial.binding
    return `Repository target: ${pull.base.repository.name} PR #${pull.number}; head ${pull.head.repository.name}:${pull.head.ref}; base ${pull.base.ref}. Target binding ${id}. Acceptance requires host checks of the provider-observed head and captured Git tree. This binding does not grant credentials or authorize external publication or merging.`
  }
  async stop(): Promise<void> { this.stopped = true; await Promise.allSettled([...this.pending]) }
}
