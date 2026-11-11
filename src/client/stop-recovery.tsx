/** Original-stop recovery. Reads never issue a cancellation or an attestation automatically. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { StopAttestationRequest, StopAttestationReceiptSchema, type StopAttestationReceipt, type StopDetail } from '../executor/stop-model.ts'
import type { StopHoldView } from '../executor/stop-view-model.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { SessionButton, When } from './widgets.tsx'

const identity = z.string().min(1).max(200)
const PendingSchema = z.object({ schema: z.literal(1), origin: z.string().max(2048), ticketId: identity,
  assignmentId: identity, stopId: identity, request: StopAttestationRequest }).strict()
export type PendingStopAttestation = z.infer<typeof PendingSchema>
const storageKey = (ticketId: string) => `dsh.stop-attestation.v1:${location.origin}:${ticketId}`
export function readStopAttestation(ticketId: string): { pending?: PendingStopAttestation; unavailable?: true } {
  try {
    const text = sessionStorage.getItem(storageKey(ticketId))
    if (!text) return {}
    if (text.length > 16384) return { unavailable: true }
    const pending = PendingSchema.parse(JSON.parse(text))
    if (pending.origin !== location.origin || pending.ticketId !== ticketId) return { unavailable: true }
    return { pending }
  } catch { return { unavailable: true } }
}
export function saveStopAttestation(pending: PendingStopAttestation): void {
  const value = PendingSchema.parse(pending), text = JSON.stringify(value), key = storageKey(value.ticketId)
  const current = readStopAttestation(value.ticketId)
  if (current.unavailable || current.pending && JSON.stringify(current.pending) !== text)
    throw new Error('A different original confirmation request must be recovered first')
  sessionStorage.setItem(key, text)
  if (sessionStorage.getItem(key) !== text) throw new Error('The original confirmation request could not be saved')
}
export function matchingStopReceipt(pending: PendingStopAttestation, value: unknown): StopAttestationReceipt {
  const receipt = StopAttestationReceiptSchema.parse(value)
  if (receipt.requestId !== pending.request.requestId || receipt.stopId !== pending.stopId || receipt.ticketId !== pending.ticketId
    || receipt.assignmentId !== pending.assignmentId || JSON.stringify(receipt.request) !== JSON.stringify(pending.request))
    throw new Error('The confirmation receipt does not match the original request')
  return receipt
}
const target = (value: PendingStopAttestation) => ({ id: value.ticketId, assignment: value.assignmentId, stop: value.stopId })

export function StopHoldNotice({ hold, ticketId, link = false }: { hold?: StopHoldView; ticketId: string; link?: boolean }) {
  const { t, navigate } = usePanel()
  if (!hold) return null
  return <section className="dt-banner" role="status" aria-label={t('stopHold.title')}>
    <strong>{t('stopHold.title')}</strong><p>{t('stopHold.summary', { count: hold.count })}</p>
    {hold.pendingAssignmentId && <p>{t('stopHold.replacement')}: <code>{hold.pendingAssignmentId}</code></p>}
    {!!hold.pendingInputs && <p>{t('stopHold.inputs', { count: hold.pendingInputs })}</p>}
    {link && <Button onClick={() => navigate({ page: 'execution', id: ticketId })}>{t('stopHold.details')}</Button>}
  </section>
}

export function TaskStops({ ticketId }: { ticketId: string }) {
  const { call, t } = usePanel()
  const [saved] = useState(() => readStopAttestation(ticketId))
  const [cursor, setCursor] = useState<string>(), [previous, setPrevious] = useState<(string | undefined)[]>([])
  const [selected, setSelected] = useState<{ id: string; assignmentId: string } | undefined>(() => saved.pending
    ? { id: saved.pending.stopId, assignmentId: saved.pending.assignmentId } : undefined)
  const page = usePoll(() => call('GET tickets/:id/stops', { id: ticketId, query: { cursor, limit: 20 } }), [call, ticketId, cursor])
  const chosen = selected ?? page.data?.items[0]
  if (!page.error && page.data?.items.length === 0 && !chosen && !saved.unavailable) return null
  return <section aria-label={t('stopHold.history')}><h3>{t('stopHold.history')}</h3>
    {page.error && <p role="alert">{errorText(page.error)}<Button onClick={() => { void page.reload() }}>{t('mission.refresh')}</Button></p>}
    {saved.unavailable && <p role="alert">{t('stopHold.storageUnavailable')}</p>}
    {!page.data && !page.error && <p role="status">{t('loading')}</p>}
    <ul className="dt-list">{page.data?.items.map(stop => <li key={stop.id}><Button onClick={() => setSelected({ id: stop.id, assignmentId: stop.assignmentId })}>
      {t(`stopHold.state.${stop.state}`)} · {stop.assignmentId}</Button></li>)}</ul>
    <div className="dt-row-actions">{previous.length > 0 && <Button onClick={() => { setCursor(previous.at(-1)); setPrevious(value => value.slice(0, -1)); setSelected(undefined) }}>{t('execution.previous')}</Button>}
      {page.data?.nextCursor && <Button onClick={() => { setPrevious(value => [...value, cursor]); setCursor(page.data!.nextCursor!); setSelected(undefined) }}>{t('execution.next')}</Button>}</div>
    {chosen && <StopRecovery key={`${ticketId}:${chosen.id}`} ticketId={ticketId} assignmentId={chosen.assignmentId} stopId={chosen.id}
      changed={() => { void page.reload() }} />}
  </section>
}

/** Receipt state is stored before sending and recovered by GET after a remount, never by an automatic POST. */
export function StopRecovery({ ticketId, assignmentId, stopId, changed }: {
  ticketId: string; assignmentId: string; stopId: string; changed(): void
}) {
  const { call, t } = usePanel(), params = { id: ticketId, assignment: assignmentId, stop: stopId }
  const detail = usePoll(() => call('GET tickets/:id/assignments/:assignment/stops/:stop', params), [call, ticketId, assignmentId, stopId])
  const [saved] = useState(() => readStopAttestation(ticketId)), [pending, setPending] = useState(saved.pending)
  const [problem, setProblem] = useState(''), [notice, setNotice] = useState(''), [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [absent, setAbsent] = useState(false)
  const lock = useRef(false), mounted = useRef(true), pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setConfirmed(false) }, [detail.data?.revision, detail.data?.executionBindingHash, detail.data?.scopeHash])
  const isCurrent = (original: PendingStopAttestation) => mounted.current && pendingRef.current?.request.requestId === original.request.requestId
  const finish = (original: PendingStopAttestation, value: unknown) => {
    const receipt = matchingStopReceipt(original, value)
    if (!isCurrent(original)) return
    if (receipt.phase === 'pending') { setNotice(t('stopHold.recorded')); return }
    // A failed browser cleanup must leave the same recoverable request, not authorize a replacement request.
    const stored = readStopAttestation(ticketId)
    if (stored.unavailable || !stored.pending || JSON.stringify(stored.pending) !== JSON.stringify(original))
      throw new Error('The saved original confirmation request changed; recover it before continuing')
    sessionStorage.removeItem(storageKey(ticketId))
    pendingRef.current = undefined
    setPending(undefined); setConfirmed(false); setNote(''); setAbsent(false)
    setNotice(t(receipt.phase === 'accepted' ? 'stopHold.attested' : 'stopHold.refused') + ' ' + receipt.reason)
    void detail.reload(); changed()
  }
  const lookup = async (original: PendingStopAttestation) => {
    const result = await call('GET tickets/:id/assignments/:assignment/stops/:stop/attestations/:request',
      { ...target(original), request: original.request.requestId })
    if (!isCurrent(original)) return
    if (result.current.id !== original.stopId || result.current.ticketId !== original.ticketId || result.current.assignmentId !== original.assignmentId)
      throw new Error(t('stopHold.receiptMismatch'))
    if (result.receipt) { setAbsent(false); finish(original, result.receipt) }
    else { setAbsent(true); setNotice(t('stopHold.notObserved')) }
  }
  useEffect(() => {
    if (!pending) return
    let active = true, checking = false
    const inspect = async () => {
      if (!active || checking) return
      checking = true
      try { await lookup(pending) } catch (error) { if (active && isCurrent(pending)) setProblem(errorText(error)) }
      finally { checking = false }
    }
    void inspect()
    const timer = setInterval(() => { void inspect() }, 5000)
    return () => { active = false; clearInterval(timer) }
  // Polling always uses the frozen target/body; fresh task evidence must not retarget recovery.
  }, [pending?.request.requestId, call])
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setProblem('')
    try { await operation() } catch (error) { if (mounted.current) setProblem(errorText(error)) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const send = async (original: PendingStopAttestation) => {
    saveStopAttestation(original); pendingRef.current = original; setPending(original); setAbsent(false)
    const result = await call('POST tickets/:id/assignments/:assignment/stops/:stop/attest', { ...target(original), body: original.request })
    finish(original, result.receipt)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault(); const current = detail.data
    if (!current?.canAttest || pending || saved.unavailable || !confirmed || !note.trim()) return
    const original: PendingStopAttestation = { schema: 1, origin: location.origin, ticketId, assignmentId, stopId,
      request: { schema: 1, requestId: `stopc-${crypto.randomUUID()}`, expectedRevision: current.revision,
        executionBindingHash: current.executionBindingHash, scopeHash: current.scopeHash, confirmed: true, note: note.trim() } }
    void run(() => send(original))
  }
  const observe = () => run(async () => {
    const current = detail.data; if (!current?.canRecheck) return
    await call('POST tickets/:id/assignments/:assignment/stops/:stop/recheck', { ...params, body: {
      expectedRevision: current.revision, executionBindingHash: current.executionBindingHash, scopeHash: current.scopeHash } })
    if (!mounted.current) return
    setNotice(t('stopHold.observed')); await detail.reload(); if (mounted.current) changed()
  })
  return <article className="dt-card" aria-label={t('stopHold.details')}>
    {(problem || detail.error) && <p role="alert">{problem || errorText(detail.error)}</p>}
    {notice && <p role="status">{notice}</p>}
    {saved.unavailable && <p role="alert">{t('stopHold.storageUnavailable')}</p>}
    {pending && <section className="dt-banner" aria-label={t('stopHold.pendingRequest')}><p>{t('stopHold.uncertain')}</p>
      <p>{t('stopHold.originalRequest')}: <code>{pending.request.requestId}</code></p>
      <p>{t('term.assignment')}: <code>{pending.assignmentId}</code></p>
      <Button disabled={busy} onClick={() => { void run(() => lookup(pending)) }}>{t('stopHold.checkReceipt')}</Button>
      {absent && <Button disabled={busy} onClick={() => { void run(() => send(pending)) }}>{t('stopHold.resubmit')}</Button>}
    </section>}
    {detail.data && <><StopFacts stop={detail.data} />
      <Button disabled={busy || !!pending || !detail.data.canRecheck} onClick={() => { void observe() }}>{t('stopHold.recheck')}</Button>
      {detail.data.canAttest && <form className="dt-mission-form" onSubmit={submit}>
        <p>{t('stopHold.attestHint')}</p>
        <label>{t('stopHold.evidenceNote')}<textarea required maxLength={2000} value={note} disabled={busy || !!pending || saved.unavailable}
          onChange={event => setNote(event.target.value)} /></label>
        <label className="dt-mission-check"><input type="checkbox" checked={confirmed} disabled={busy || !!pending || saved.unavailable}
          onChange={event => setConfirmed(event.target.checked)} />{t('stopHold.confirm')}</label>
        <Button type="submit" disabled={busy || !!pending || saved.unavailable || !confirmed || !note.trim()}>{t('stopHold.attest')}</Button>
      </form>}
      <StopReceipts stop={detail.data} />
    </>}
  </article>
}

function StopFacts({ stop }: { stop: StopDetail }) {
  const { t } = usePanel()
  return <><h4>{t(`stopHold.state.${stop.state}`)}</h4><p>{stop.reason}</p>
    <p>{t('stopHold.scope')}: {t(`stopHold.scope.${stop.scope}`)}</p>
    <p>{t('term.assignment')}: <code>{stop.assignmentId}</code> · <SessionButton sessionId={stop.sessionId} /></p>
    <p>{t('stopHold.proof')}: {t(`stopHold.proof.${stop.proof ?? 'none'}`)}</p>
    {stop.legacy && <p>{t('stopHold.legacy')}</p>}
    <p>{t('stopHold.originalLocation')}: <code>{stop.execution?.directory ?? t('stopHold.unknown')}</code></p>
    {stop.execution?.environment && <p>{t('execution.grant')}: <code>{stop.execution.environment.environmentId}</code> · {stop.execution.environment.epoch}</p>}
    {stop.world && <p>{t('execution.world')}: <code>{stop.world}</code></p>}
    <details><summary>{t('stopHold.identity')}</summary><p><code>{stop.id}</code> · {stop.revision}</p>
      <p>{t('stopHold.binding')}: <code>{stop.executionBindingHash}</code></p><p>{t('stopHold.scope')}: <code>{stop.scopeHash}</code></p>
      <p>{t('stopHold.targets')}: {stop.targets.jobIds.length} / {stop.targets.sessions.length}</p>
      <ul>{[...stop.targets.jobIds, ...stop.targets.sessions].map((id, index) => <li key={`${index}:${id}`}><code>{id}</code></li>)}</ul>
      <When at={stop.createdAt} />{stop.settledAt && <> · <When at={stop.settledAt} /></>}
    </details></>
}
function StopReceipts({ stop }: { stop: StopDetail }) {
  const { call, t } = usePanel(), [cursor, setCursor] = useState<string>()
  const page = usePoll(() => call('GET tickets/:id/assignments/:assignment/stops/:stop/attestations', {
    id: stop.ticketId, assignment: stop.assignmentId, stop: stop.id, query: { cursor, limit: 20 } }), [call, stop.id, cursor, stop.revision])
  return <details><summary>{t('stopHold.receipts')}</summary>
    {page.error && <p role="alert">{errorText(page.error)}</p>}
    <ul>{page.data?.items.map(receipt => <li key={receipt.requestId}><code>{receipt.requestId}</code> · {receipt.phase}
      <p>{receipt.reason}</p><p>{receipt.request.note}</p><When at={receipt.acceptedAt} /></li>)}</ul>
    {cursor && <Button onClick={() => setCursor(undefined)}>{t('execution.previous')}</Button>}
    {page.data?.nextCursor && <Button onClick={() => setCursor(page.data!.nextCursor!)}>{t('execution.next')}</Button>}
  </details>
}
