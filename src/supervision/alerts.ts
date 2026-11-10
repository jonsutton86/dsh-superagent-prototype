/** Opt-in, independent webhook routing. The model never configures destinations or chooses a delivery operation. */
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import type { WatchdogJournal } from './journal.ts'
import { AlertReceiverReceiptSchema, AlertRoutesSchema, alertDestinationHash, alertHash, alertView,
  type AlertCandidate, type AlertList, type AlertRecord, type AlertRoute, type AlertView } from './alert-protocol.ts'
import { WatchdogOperatorError } from './protocol.ts'

/** Incident content is explicitly untrusted data; service errors use fixed text instead of leaking exception bodies. */
function candidates(journal: WatchdogJournal): AlertCandidate[] {
  const result: AlertCandidate[] = []
  for (const incident of journal.open()) {
    if (journal.view(incident).acknowledged) continue
    const observation = incident.observation
    const finding = observation.stage === 'person/answer' ? 'operator_answer_needed'
      : ['person/blocked', 'person/failed'].includes(observation.stage) ? observation.stage.slice(7)
        : incident.assessment && incident.assessment.finding !== 'progressing' ? incident.assessment.finding
          : !incident.assessment && incident.attempts >= 3 ? 'assessment_delivery_limit_reached' : undefined
    if (!finding) continue
    result.push({ subjectId: `incident:${incident.id}`, incidentId: incident.id, evidenceKey: journal.view(incident).viewRevision,
      title: observation.title.slice(0, 500), finding, observedAt: incident.updatedAt,
      evidence: (finding === 'assessment_delivery_limit_reached'
        ? 'Three assessment deliveries were reserved without a recorded assessment. An assessment may still be running; review current status.'
        : observation.question ?? incident.assessment?.evidence ?? observation.report?.summary ?? 'Operator review is required.').slice(0, 2000) })
  }
  const status = journal.status()
  if (status && !status.reachable && status.error !== 'Awaiting first observation') result.push({
    subjectId: 'service:main', title: 'Main Agentic OS service is unreachable', finding: 'service_unreachable',
    evidenceKey: alertHash([status.error, status.lastSuccess]), observedAt: status.at,
    evidence: 'The independent watchdog could not obtain a current main-service observation. Inspect its local console for details.',
  })
  if (status?.modelError) result.push({ subjectId: 'service:assessor', title: 'Watchdog assessment service needs attention',
    finding: 'assessment_unavailable', evidenceKey: alertHash(status.modelError), observedAt: status.at,
    evidence: 'The watchdog reported an assessment error. Monitoring continues independently; inspect its local console for details.',
  })
  return result
}

/** Reads only the configured owner-only regular credential file, without following a final symlink or printing its contents. */
function token(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Invalid credential file')
    const value = readFileSync(fd, 'utf8').trim()
    if (!/^[\x21-\x7e]{16,4096}$/.test(value)) throw new Error('Invalid credential value')
    return value
  } finally { closeSync(fd) }
}

/** Independent alert coordinator: durable intent before dispatch, bounded I/O, and observation without replay. */
export class WatchdogAlerts {
  private readonly routes: AlertRoute[]
  private readonly active = new Map<string, Promise<AlertView>>()
  private polling?: Promise<void>
  constructor(private readonly journal: WatchdogJournal, routes: unknown = [], private readonly signal = new AbortController().signal,
    private readonly now = Date.now, private readonly request: typeof fetch = fetch) {
    this.routes = AlertRoutesSchema.parse(routes)
  }
  list(cursor?: string): AlertList { return this.journal.alerts.list(this.routes, cursor) }
  get(id: string): AlertView { return alertView(this.journal.alerts.require(id)) }
  poll(): Promise<void> { return this.polling ??= this.run().finally(() => { this.polling = undefined }) }
  private async run(): Promise<void> {
    if (this.signal.aborted) return
    this.journal.alerts.sync(candidates(this.journal), this.routes, this.now())
    // One bounded operation at a time: one slow destination cannot occupy the entire poll indefinitely.
    for (const receipt of this.journal.alerts.pending().slice(0, 4)) {
      if (this.signal.aborted) break
      await this.retry(receipt.id)
    }
  }
  private route(receipt: AlertRecord): AlertRoute {
    const route = this.routes.find(route => route.id === receipt.routeId)
    if (!route || alertDestinationHash(route) !== receipt.destinationHash) throw new WatchdogOperatorError(409, 'alert_destination_changed')
    return route
  }
  private operation(id: string, work: () => Promise<AlertView>): Promise<AlertView> {
    const current = this.active.get(id)
    if (current) return current
    const task = work().finally(() => { this.active.delete(id) })
    this.active.set(id, task)
    return task
  }
  retry(id: string): Promise<AlertView> {
    return this.operation(id, async () => {
      let receipt = this.journal.alerts.require(id)
      if (receipt.phase !== 'prepared') return alertView(receipt)
      this.signal.throwIfAborted()
      // Recheck acknowledgement, evidence, closure and configuration immediately before any retry.
      this.journal.alerts.sync(candidates(this.journal), this.routes, this.now())
      receipt = this.journal.alerts.require(id)
      if (receipt.phase !== 'prepared') return alertView(receipt)
      const route = this.route(receipt)
      let credential: string
      try { credential = token(route.tokenFile) }
      catch { return alertView(this.journal.alerts.preparedError(id, 'credential_unavailable_before_dispatch', this.now())) }
      receipt = this.journal.alerts.dispatch(id, alertDestinationHash(route), this.now())
      try {
        const response = await this.request(route.url, { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(5000)]), headers: {
            authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'idempotency-key': receipt.id,
          }, body: JSON.stringify({ version: 1, id: receipt.id, payloadHash: receipt.payloadHash, payload: receipt.payload }) })
        return await this.receive(receipt, response)
      } catch { return alertView(this.journal.alerts.outcome(id, 'unknown', 'dispatch_response_unconfirmed', this.now())) }
    })
  }
  observe(id: string): Promise<AlertView> {
    return this.operation(id, async () => {
      const receipt = this.journal.alerts.require(id)
      if (!['unknown', 'sending'].includes(receipt.phase)) return alertView(receipt)
      this.signal.throwIfAborted()
      const route = this.route(receipt)
      let credential: string
      try { credential = token(route.tokenFile) }
      catch { throw new WatchdogOperatorError(409, 'alert_credential_unavailable') }
      const url = new URL(route.url); url.searchParams.set('alertId', receipt.id)
      try {
        const response = await this.request(url, { method: 'GET', redirect: 'error',
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(5000)]), headers: { authorization: `Bearer ${credential}` } })
        return await this.receive(receipt, response)
      } catch { return alertView(this.journal.alerts.outcome(id, 'unknown', 'observation_response_unconfirmed', this.now())) }
    })
  }
  private async receive(original: AlertRecord, response: Response): Promise<AlertView> {
    // Even a 2xx response needs the exact identity/hash. A receiver's error page is never evidence of rejection or acceptance.
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0
    if (!reader) throw new Error('Missing receipt')
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 8192) throw new Error('Receipt too large')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const receipt = AlertReceiverReceiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (!response.ok || receipt.id !== original.id || receipt.payloadHash !== original.payloadHash) throw new Error('Receipt does not match')
    const phase = receipt.status === 'pending' ? 'unknown' : receipt.status
    return alertView(this.journal.alerts.outcome(original.id, phase,
      receipt.status === 'accepted' ? 'receiver_accepted' : receipt.status === 'rejected' ? 'receiver_rejected' : 'receiver_pending', this.now()))
  }
  cancel(id: string): AlertView { return this.journal.alerts.cancel(id, this.now()) }
  async idle(): Promise<void> { await this.polling; await Promise.allSettled([...this.active.values()]) }
}
