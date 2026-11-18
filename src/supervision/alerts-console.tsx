import { useEffect, useRef, useState } from 'react'
import type { AlertList, AlertView } from './alert-protocol.ts'

type Action = 'observe' | 'retry' | 'cancel'
const phaseLabels: Record<AlertView['phase'], string> = {
  prepared: 'Not dispatched', sending: 'Dispatch in progress', accepted: 'Receiver accepted',
  rejected: 'Receiver rejected', unknown: 'Outcome unknown', cancelled: 'Cancelled before dispatch',
}
const reasons: Record<string, string> = {
  credential_unavailable_before_dispatch: 'The receiver credential could not be read. Correct it on the watchdog host before retrying.',
  destination_configuration_changed: 'The configured destination changed before this alert was sent.',
  evidence_changed_or_acknowledged: 'The evidence changed, closed, or was acknowledged before this alert was sent.',
  watchdog_restarted_after_dispatch: 'The watchdog restarted before it could confirm the receiver outcome.',
  dispatch_response_unconfirmed: 'The delivery response was not confirmed.',
  observation_response_unconfirmed: 'The receiver has not supplied a confirmed receipt.',
  receiver_pending: 'The receiver is still processing this alert.',
  receiver_rejected: 'The receiver explicitly rejected this alert.',
  operator_cancelled_before_dispatch: 'An operator cancelled this alert before it was sent.',
}

async function readAlerts(cursor: string | undefined, signal: AbortSignal): Promise<AlertList> {
  const response = await fetch('/watchdog/api/alerts' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: 'error',
    headers: { 'x-orchestrator-request': '1' },
  })
  if (!response.ok) throw new Error('Alert receipts could not be loaded. Refresh to try again.')
  return response.json() as Promise<AlertList>
}

/** Operator view of original alert receipts; observation never reissues an external notification. */
export function WatchdogAlertsConsole({ revision }: { revision: number }) {
  const [cursor, setCursor] = useState<string>(), [pages, setPages] = useState<string[]>([])
  const [refresh, setRefresh] = useState(0), [data, setData] = useState<AlertList>()
  const [loading, setLoading] = useState(true), [readError, setReadError] = useState('')
  const [commandError, setCommandError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<string>(), lock = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setReadError('')
    void readAlerts(cursor, controller.signal).then(value => {
      if (!controller.signal.aborted) { setData(value); setLoading(false) }
    }).catch(error => {
      if (!controller.signal.aborted) { setReadError(error instanceof Error ? error.message : 'Alert receipts unavailable.'); setLoading(false) }
    })
    return () => controller.abort()
  }, [cursor, revision, refresh])
  const act = async (item: AlertView, action: Action) => {
    if (lock.current) return
    lock.current = true; setBusy(item.id); setCommandError(''); setNotice('')
    try {
      // The original ID is already durable on the server; all three operations reuse it, including after response loss.
      const response = await fetch(`/watchdog/api/alerts/${encodeURIComponent(item.id)}/${action}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: '{}',
      })
      if (!response.ok) throw new Error(response.status >= 400 && response.status < 500
        ? 'The alert changed or the operation was refused. Review its current receipt.' : 'Unconfirmed server response')
      if (mounted.current) setNotice(action === 'observe' ? 'Original receipt checked. An unknown outcome stays unknown until the receiver confirms it.'
        : action === 'cancel' ? 'Cancellation checked against the original alert. A dispatched alert cannot be cancelled.'
          : 'Original unsent alert checked for dispatch. Review its receipt below.')
    } catch (error) {
      if (mounted.current) setCommandError(error instanceof Error && error.message.startsWith('The alert changed') ? error.message
        : 'The response was not confirmed. Refresh the original receipt; no replacement alert has been created.')
    } finally {
      lock.current = false
      if (mounted.current) { setBusy(undefined); setRefresh(value => value + 1) }
    }
  }
  return <section className="wd-panel wd-alerts" aria-labelledby="alerts-title"><div className="wd-section-title">
    <h2 id="alerts-title">Operator alerts</h2><button onClick={() => { setCursor(undefined); setPages([]); setRefresh(value => value + 1) }}>Refresh alerts</button></div>
    <p>Alerts use destinations configured on the watchdog host. Receiver acceptance does not mean a person has read the alert.</p>
    {loading && !data && <p role="status">Loading alert receipts…</p>}
    {readError && <p role="alert">{readError}</p>}{commandError && <p role="alert">{commandError}</p>}{notice && <p role="status">{notice}</p>}
    {data && <><p>{data.routes.length ? 'Configured destinations: ' + data.routes.map(route => route.name).join(', ') : 'No alert destinations configured.'}</p>
      <p className="wd-muted">Retained alert records: {data.capacity.used} / {data.capacity.limit}. Unknown outcomes are retained and are never resent automatically.</p>
      {data.capacity.sourcesUsed !== undefined && <p className="wd-muted">Tracked alert subjects: {data.capacity.sourcesUsed} / {data.capacity.sourcesLimit};
        {' '}deduplication reservations: {data.capacity.reservationsUsed} / {data.capacity.reservationsLimit}.</p>}
      {(data.capacity.used >= data.capacity.limit || (data.capacity.sourcesUsed ?? 0) >= (data.capacity.sourcesLimit ?? Infinity)
        || (data.capacity.reservationsUsed ?? 0) >= (data.capacity.reservationsLimit ?? Infinity))
        && <p role="status" className="wd-warning">Alert capacity reached. New admissions may be held; retained unknown outcomes and deduplication records are preserved.</p>}
      {data.items.length === 0 && <p>No retained alert receipts.</p>}
      <ol className="wd-history">{data.items.map(item => <li key={item.id}><div><strong>{item.title}</strong><span>{phaseLabels[item.phase]}</span></div>
        <p>{item.routeName} · {item.finding.replaceAll('_', ' ')} · {new Date(item.createdAt).toLocaleString()}</p>
        {item.reason && reasons[item.reason] && <p className="wd-prewrap">{reasons[item.reason]}</p>}
        {item.phase === 'unknown' && <p>The receiver may have accepted this alert. Check its original receipt; sending another copy is unavailable.</p>}
        <details><summary>Alert identity and evidence</summary><dl className="wd-facts">
          <div><dt>Original alert</dt><dd>{item.id}</dd></div><div><dt>Subject</dt><dd>{item.subjectId}</dd></div>
          <div><dt>Evidence revision</dt><dd>{item.evidenceRevision}</dd></div><div><dt>Payload digest</dt><dd>{item.payloadHash}</dd></div>
          <div><dt>Destination revision</dt><dd>{item.destinationHash}</dd></div>
          {item.reason && <div><dt>Recorded outcome detail</dt><dd>{item.reason}</dd></div>}
        </dl></details>
        <div className="wd-actions">{item.phase === 'unknown' && <button disabled={!!busy || loading || !!readError}
          onClick={() => void act(item, 'observe')}>{busy === item.id ? 'Checking…' : 'Check receipt'}</button>}
          {item.phase === 'prepared' && <><button disabled={!!busy || loading || !!readError} onClick={() => void act(item, 'retry')}>Retry unsent alert</button>
            <button disabled={!!busy || loading || !!readError} onClick={() => void act(item, 'cancel')}>Cancel unsent alert</button></>}
        </div></li>)}</ol>
      <div className="wd-actions">{pages.length > 0 && <button disabled={!!busy} onClick={() => { setCursor(pages.at(-1) || undefined); setPages(pages.slice(0, -1)) }}>Newer alerts</button>}
        {data.cursor && <button disabled={!!busy || loading || !!readError} onClick={() => { setPages([...pages, cursor ?? '']); setCursor(data.cursor!) }}>Older alerts</button>}</div></>}
  </section>
}
