import { useEffect, useRef, useState } from 'react'
import type { AuditEntry, IncidentView, MonitorStatus } from './journal.ts'
import { assessmentIsCurrent, type Acknowledge, type IncidentFilter, type Page, type RetentionPolicy } from './protocol.ts'
import { WatchdogAlertsConsole } from './alerts-console.tsx'
import { ExecutionEvidenceView } from './execution-evidence-view.tsx'

interface Status {
  now: number; mainUrl: string; pollMs: number; monitor: MonitorStatus | null; retention: RetentionPolicy;
  counts: { open: number; closed: number; unacknowledged: number; audit: number; prunedAt: number };
}
/** Only definitive HTTP refusals may discard an unconfirmed operator command. */
class ApiFailure extends Error { constructor(readonly status: number, message: string) { super(message) } }
const messages: Record<string, string> = {
  incidents_changed_refresh: 'Incidents changed while paging. Refresh the list to continue.',
  history_expired_refresh: 'Older history was removed by retention. Refresh the history to continue.',
  incident_changed_refresh: 'New evidence is available or the incident has closed. Review the refreshed incident before acknowledging.',
  acknowledgement_request_expired: 'This acknowledgement request expired. Review the current evidence and submit again.',
  incident_not_found: 'This incident is no longer retained.',
}
async function request<T>(path: string, signal?: AbortSignal, body?: Acknowledge): Promise<T> {
  const response = await fetch('/watchdog/api/' + path, { method: body ? 'POST' : 'GET', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    headers: { 'x-orchestrator-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new ApiFailure(response.status, messages[value.error ?? ''] ?? 'The watchdog request failed. Refresh or retry.')
  return value
}
function useRead<T>(path: string | undefined, revision: number) {
  const [state, setState] = useState<{ path?: string; data?: T; error?: string; loading: boolean }>({ loading: true })
  useEffect(() => {
    const controller = new AbortController()
    setState(previous => ({ path, ...(previous.path === path ? { data: previous.data } : {}), loading: !!path }))
    if (path) void request<T>(path, controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ path, data, loading: false })
    }).catch(error => { if (!controller.signal.aborted) setState(previous => ({ ...previous, error: String(error.message ?? error), loading: false })) })
    return () => controller.abort()
  }, [path, revision])
  return state.path === path ? state : { loading: !!path }
}
const date = (value?: number | string) => value === undefined ? 'Not yet' : new Date(value).toLocaleString()
const incidentStatus = (incident: IncidentView) => incident.closedAt !== undefined ? 'Closed' : !incident.assessment ? 'Awaiting assessment'
  : assessmentIsCurrent(incident) ? `Assessment: ${incident.assessment.finding}` : 'Evidence changed—assessment is historical'
const PENDING_KEY = 'dsh.watchdog.ack.v1'
function savedRequest(): Acknowledge | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null')
    if (!value || typeof value !== 'object') return
    const item = value as Acknowledge
    if (typeof item.requestId === 'string' && /^wd-[0-9]{13}-[a-f0-9-]{36}$/.test(item.requestId)
      && typeof item.incidentId === 'string' && item.incidentId.length <= 200
      && typeof item.revision === 'string' && item.revision.length <= 100
      && typeof item.note === 'string' && item.note.length <= 2000)
      return { requestId: item.requestId, incidentId: item.incidentId, revision: item.revision, note: item.note }
  } catch { /* An unavailable browser store must never trigger a mutation automatically. */ }
}
function History({ incident, revision }: { incident?: string; revision: number }) {
  const [cursor, setCursor] = useState<string>(), [pages, setPages] = useState<string[]>([])
  const params = new URLSearchParams({ ...(incident ? { incident } : {}), ...(cursor ? { cursor } : {}) })
  const state = useRead<Page<AuditEntry>>('history?' + params, revision)
  return <section aria-labelledby="history-title" className="wd-panel"><div className="wd-section-title"><h2 id="history-title">Audit history</h2>
    {cursor && <button onClick={() => { setCursor(undefined); setPages([]) }}>Newest history</button>}</div>
    {state.error && <p role="alert">{state.error}</p>}
    {state.loading && <p role="status">Loading history…</p>}
    {state.data?.items.length === 0 && <p>No retained events.</p>}
    <ol className="wd-history">{state.data?.items.map(event => <li key={event.seq}><div><strong>{event.kind.replaceAll('_', ' ')}</strong>
      <time>{date(event.at)}</time></div><details><summary>Evidence and receipt</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details></li>)}</ol>
    <div className="wd-actions">{pages.length > 0 && <button onClick={() => {
      setCursor(pages.at(-1) || undefined); setPages(pages.slice(0, -1))
    }}>Newer events</button>}{state.data?.cursor && <button onClick={() => {
      setPages([...pages, cursor ?? '']); setCursor(state.data!.cursor!)
    }}>Older events</button>}</div>
  </section>
}

export function WatchdogConsole() {
  const [revision, setRevision] = useState(0), [tick, setTick] = useState(0)
  const [filter, setFilter] = useState<IncidentFilter>('unacknowledged'), [selected, setSelected] = useState<string>()
  const [cursor, setCursor] = useState<string>(), [pages, setPages] = useState<string[]>([]), [note, setNote] = useState('')
  const [pending, setPending] = useState<Acknowledge | undefined>(savedRequest), [sending, setSending] = useState(false)
  const [commandError, setCommandError] = useState(''), [notice, setNotice] = useState('')
  const commandLock = useRef(false), mounted = useRef(true)
  const status = useRead<Status>('status', revision + tick)
  const list = useRead<Page<IncidentView>>('incidents?' + new URLSearchParams({ state: filter, ...(cursor ? { cursor } : {}) }), revision + (cursor ? 0 : tick))
  const detail = useRead<IncidentView>(selected ? 'incidents/' + encodeURIComponent(selected) : undefined, revision + tick)
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), 10000); return () => clearInterval(timer) }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refresh = () => { setCursor(undefined); setPages([]); setRevision(value => value + 1) }
  const acknowledge = async (command: Acknowledge) => {
    if (commandLock.current) return
    commandLock.current = true; setSending(true); setCommandError(''); setNotice('')
    try {
      // Save before sending; an unavailable store is a visible refusal, never a mutation without its retry identity.
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(command)); setPending(command)
      await request('acknowledgements', undefined, command)
      sessionStorage.removeItem(PENDING_KEY)
      if (mounted.current) { setPending(undefined); setNote(''); setNotice('Evidence acknowledged. Monitoring continues.'); refresh() }
    } catch (error) {
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) {
        try { sessionStorage.removeItem(PENDING_KEY) } catch { /* Keep the original request recoverable if browser storage fails. */ }
        if (mounted.current) { setPending(undefined); refresh() }
      }
      if (mounted.current) setCommandError(error instanceof Error ? error.message : String(error))
    } finally { commandLock.current = false; if (mounted.current) setSending(false) }
  }
  const monitor = status.data?.monitor, incident = detail.data
  const stale = !!monitor && !!status.data && status.data.now - monitor.at > 2 * status.data.pollMs + 10000
  const select = (id: string) => { setSelected(id); setNote(''); setCommandError(''); setNotice('') }
  return <main className="wd-shell"><header className="wd-header"><div><p className="wd-eyebrow">Agentic OS / independent supervision</p>
    <h1>Watchdog console</h1><p>Review evidence, track incidents, and keep monitoring through main-service outages.</p></div>
    <div className="wd-actions"><button onClick={refresh}>Refresh</button>{status.data && <a href={status.data.mainUrl} target="_blank" rel="noreferrer">Open main app ↗</a>}</div></header>
    {status.error && <p role="alert">Watchdog connection unavailable. {status.error}</p>}
    {status.loading && !status.data && <p role="status">Checking watchdog…</p>}
    {status.data && <><section className="wd-summary" aria-label="Service health"><article><span>Main service</span>
      <strong data-tone={monitor?.reachable && !stale ? 'good' : 'bad'}>{!monitor ? 'Awaiting observation' : stale ? 'Observation overdue' : !monitor.reachable ? 'Unreachable' : monitor.paused ? 'Processing paused' : !monitor.configured ? 'Setup required' : 'Reachable'}</strong>
      <small>Last successful observation: {date(monitor?.lastSuccess)}</small></article><article><span>Needs acknowledgement</span>
      <strong>{status.data.counts.unacknowledged}</strong><small>{status.data.counts.open} open incidents · {status.data.counts.closed} retained closed</small></article>
      <article><span>Assessment service</span><strong data-tone={monitor?.modelError ? 'bad' : undefined}>{monitor?.modelError ? 'Needs attention' : 'No reported error'}</strong>
        <small>Last poll: {date(monitor?.at)}</small></article></section>
      {monitor?.error && <p className="wd-warning" role="status">Observation: {monitor.error}</p>}
      {monitor?.modelError && <p className="wd-warning" role="status">Assessment: {monitor.modelError}</p>}
      {monitor?.health && <details className="wd-health"><summary>Service observations</summary><dl>{Object.entries(monitor.health).map(([name, health]) =>
        <div key={name}><dt>{name}</dt><dd>{health.state}{health.detail ? ' — ' + health.detail : ''}</dd></div>)}</dl></details>}</>}
    {pending && <section className="wd-warning" aria-label="Pending acknowledgement"><p>An acknowledgement has an unconfirmed response. Retry preserves its original evidence and request identity.</p>
      <div className="wd-actions"><button disabled={sending} onClick={() => void acknowledge(pending)}>{sending ? 'Sending…' : 'Retry acknowledgement'}</button>
        <button onClick={() => select(pending.incidentId)}>Open pending incident</button></div></section>}
    {commandError && <p role="alert">{commandError}</p>}{notice && <p role="status">{notice}</p>}
    <div className="wd-workspace"><section className="wd-panel wd-list" aria-labelledby="incidents-title"><div className="wd-section-title"><h2 id="incidents-title">Incidents</h2>
      <label>Show <select value={filter} onChange={event => { setFilter(event.target.value as IncidentFilter); setCursor(undefined); setPages([]) }}>
        <option value="unacknowledged">Needs acknowledgement</option><option value="open">All open</option><option value="closed">Closed</option><option value="all">All retained</option></select></label></div>
      {list.loading && <p role="status">Loading incidents…</p>}{list.error && <p role="alert">{list.error}</p>}
      {list.data?.items.length === 0 && <p>No incidents in this view.</p>}
      <ul>{list.data?.items.map(item => <li key={item.id}><button aria-current={selected === item.id ? 'true' : undefined} onClick={() => select(item.id)}>
        <strong>{item.observation.title}</strong><span>{incidentStatus(item)} · {item.observation.stage}</span>
        <small>{item.closedAt !== undefined ? 'Retained history' : item.acknowledged ? 'Acknowledged' : 'Needs acknowledgement'} · {date(item.updatedAt)}</small></button></li>)}</ul>
      <div className="wd-actions">{pages.length > 0 && <button onClick={() => { setCursor(pages.at(-1) || undefined); setPages(pages.slice(0, -1)) }}>Previous incidents</button>}
        {list.data?.cursor && <button onClick={() => { setPages([...pages, cursor ?? '']); setCursor(list.data!.cursor!) }}>More incidents</button>}</div>
    </section><section className="wd-panel" aria-labelledby="detail-title"><h2 id="detail-title">{incident?.observation.title ?? 'Incident evidence'}</h2>
      {!selected && <p>Select an incident to review its evidence and history.</p>}{detail.loading && <p role="status">Loading incident…</p>}{detail.error && <p role="alert">{detail.error}</p>}
      {incident && <><p className="wd-badge">{incidentStatus(incident)}</p>
        <dl className="wd-facts"><div><dt>Task stage</dt><dd>{incident.observation.stage}</dd></div><div><dt>Opened</dt><dd>{date(incident.openedAt)}</dd></div>
          <div><dt>Evidence updated</dt><dd>{date(incident.updatedAt)}</dd></div><div><dt>Assessment deliveries</dt><dd>{incident.attempts} / 3{incident.attempts >= 3 && !assessmentIsCurrent(incident) ? ' · limit reached; operator review needed' : ''}</dd></div></dl>
        <h3>Task scope</h3><p className="wd-prewrap">{incident.observation.scope}</p><h3>Latest worker report</h3>
        <p className="wd-prewrap">{incident.observation.report?.summary ?? 'No report observed.'}</p>
        {incident.observation.question && <><h3>Operator answer needed</h3><p className="wd-prewrap">{incident.observation.question}</p></>}
        {incident.observation.stopHold && <section className="wd-warning" aria-label="Original work stop hold"><h3>Original work is not confirmed stopped</h3>
          <p>{incident.observation.stopHold.count} unresolved stop record(s). New execution and queued messages remain held. Acknowledgement does not release this hold.</p>
          <ul>{incident.observation.stopHold.originals.map(stop => <li key={stop.id}>Original assignment: <code>{stop.assignmentId}</code>
            {' · '}{stop.scope}{' · '}{stop.state}{stop.legacy ? ' · legacy attribution unknown' : ''}</li>)}</ul>
          {incident.observation.stopHold.truncated && <p>Additional original stop records are available in the main task details.</p>}
          {incident.observation.stopHold.pendingAssignmentId && <p>Pending replacement: <code>{incident.observation.stopHold.pendingAssignmentId}</code></p>}
        </section>}
        <ExecutionEvidenceView evidence={incident.observation.execution} />
        <h3>{incident.assessment && !assessmentIsCurrent(incident) ? 'Historical assessment' : 'Assessment evidence'}</h3>
        {incident.assessment && !assessmentIsCurrent(incident) && <p className="wd-warning">Previous finding: {incident.assessment.finding}. This assessment describes earlier evidence; it does not assess the current observations.</p>}
        <p className="wd-prewrap">{incident.assessment?.evidence ?? 'No recorded assessment. Quiet work alone does not prove a stall.'}</p>
        {incident.intervention && <p>Progress request{incident.interventionRevision !== incident.revision ? ' based on earlier evidence' : ''}: {incident.intervention.accepted ? 'accepted' : 'refused'} · {incident.intervention.reason}</p>}
        {incident.acknowledgement && <p className="wd-prewrap">{incident.acknowledged ? 'Acknowledged' : 'New evidence since acknowledgement'} at {date(incident.acknowledgement.at)}{incident.acknowledgement.note ? '\n' + incident.acknowledgement.note : ''}</p>}
        {incident.closedAt === undefined && !incident.acknowledged && <form onSubmit={event => { event.preventDefault(); void acknowledge({
          requestId: `wd-${Date.now()}-${crypto.randomUUID()}`, incidentId: incident.id, revision: incident.viewRevision, note: note.trim(),
        }) }}><label htmlFor="ack-note">Review note (optional)</label><textarea id="ack-note" value={note} maxLength={2000} disabled={!!pending || sending} onChange={event => setNote(event.target.value)} />
          <p className="wd-muted">Acknowledgement records review of this evidence. It does not resolve the incident, suppress monitoring, or retry work.</p>
          <button className="wd-primary" type="submit" disabled={!!pending || sending || !!detail.error || detail.loading}>Acknowledge evidence</button></form>}
      </>}
    </section></div>
    <WatchdogAlertsConsole revision={revision + tick} />
    <History key={`${selected ?? 'all'}:${revision}`} incident={selected} revision={revision} />
    {status.data && <footer>Retention: closed incidents {status.data.retention.closedDays} days / {status.data.retention.maxClosed.toLocaleString()} records;
      audit history {status.data.retention.auditDays} days / {status.data.retention.maxAudit.toLocaleString()} records. Open incidents are retained.
      Acknowledgement retries expire after 24 hours. History cleanup runs in bounded batches. Last sweep: {date(status.data.counts.prunedAt || undefined)}.</footer>}
  </main>
}
