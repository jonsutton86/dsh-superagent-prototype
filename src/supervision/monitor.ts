/** Independent monitoring loop, with semantic assessment delivery and bounded recovery. */
import { key } from '../core/index.ts'
import type { SupervisionClient } from './client.ts'
import { WatchdogJournal } from './journal.ts'
import type { InterventionResult } from './protocol.ts'
import { assessmentIsCurrent } from './protocol.ts'

export interface MonitorOptions { pollMs: number; staleMs: number; reviewEveryMs: number; retryMs: number; assessmentTimeoutMs: number }
export interface Assessor {
  busy(): boolean
  send(id: string, text: string): Promise<void>
  cancel(): void
}
export const ASSESSMENT_TIMEOUT_ERROR = 'Assessment timed out; a bounded retry is pending'

/** Polling proceeds while the assessor is busy; model failures never masquerade as service failures. */
export class WatchdogMonitor {
  private running?: Promise<void>
  private assessingSince?: number
  constructor(readonly journal: WatchdogJournal, private readonly client: Pick<SupervisionClient, 'observe' | 'intervene'>,
    private readonly assessor: Assessor, readonly options: MonitorOptions, private readonly now = Date.now) {}
  poll(): Promise<void> { return this.running ??= this.run().finally(() => { this.running = undefined }) }
  private async run(): Promise<void> {
    const now = this.now()
    // Check the watchdog's own deadline even when the monitored service is unavailable.
    if (this.assessor.busy()) {
      this.assessingSince ??= now
      if (now - this.assessingSince >= this.options.assessmentTimeoutMs) {
        this.assessor.cancel(); this.journal.modelError(ASSESSMENT_TIMEOUT_ERROR)
      }
    } else this.assessingSince = undefined
    let snapshot
    try { snapshot = await this.client.observe() }
    catch (error) { this.journal.unavailable(now, String(error)); return }
    this.journal.reconcile(snapshot, now, this.options.staleMs, this.options.reviewEveryMs)
    if (this.assessor.busy()) return
    for (const open of this.journal.open()) {
      const incident = this.journal.reserve(open.id, now, this.options.retryMs)
      if (!incident) continue
      try {
        this.assessingSince = now
        await this.assessor.send(incident.delivery!.id, incident.delivery!.text)
        // Queue/flush acknowledgement proves delivery, not inference or a recorded assessment.
        this.journal.delivered(incident.id, incident.delivery!.id)
      } catch { this.journal.modelError('Assessment delivery failed; a bounded retry is pending') }
      // One assessment per poll, at most three deliveries per task/review cycle; material activity never adds budget.
      break
    }
  }
  async requestStatus(id: string, revision: string): Promise<InterventionResult> {
    const incident = this.journal.get(id), status = this.journal.status()
    const refuse = (reason: string): InterventionResult => ({ accepted: false, reason })
    // An exact historical receipt is observation of an existing action, never permission for a new one.
    if (incident?.intervention && incident.interventionRevision === revision) return incident.intervention
    if (!incident || incident.closedAt !== undefined || incident.revision !== revision) return refuse('incident_changed')
    if (!status?.reachable || status.paused || !status.configured || this.now() - status.at > 2 * this.options.pollMs)
      return refuse('fresh_observation_required')
    if (!assessmentIsCurrent(incident) || incident.assessment?.finding !== 'stalled' || !incident.observation.canNudge) return refuse('intervention_not_allowed')
    const result = await this.client.intervene({ requestId: key(`watchdog-status:${incident.id}:${revision}`),
      instance: incident.instance, ticketId: incident.observation.id, revision: incident.observation.revision, action: 'request_status' })
    this.journal.intervention(id, revision, result, this.now())
    return result
  }
}
