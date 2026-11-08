import { useRef, useState } from 'react'
import { ApiError, usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, Section, SessionButton, When } from './widgets.tsx'

/** Read durable remote receipts and cancel their original command IDs, including while execution admission is closed. */
export function ExecutionReceipts({ ticketId, worldId }: { ticketId?: string; worldId?: string }) {
  const { call, t, navigate } = usePanel(), [offset, setOffset] = useState(0), [busy, setBusy] = useState(false), [problem, setProblem] = useState('')
  const locked = useRef(false), cancellations = useRef(new Map<string, string>())
  const { data, error, reload } = usePoll(() => ticketId
    ? call('GET tickets/:id/execution', { id: ticketId, query: { offset, limit: 20 } })
    : worldId ? call('GET worlds/:id/execution', { id: worldId, query: { offset, limit: 20 } })
      : call('GET execution', { query: { offset, limit: 20 } }), [call, ticketId, worldId, offset])
  const run = async (operation: () => Promise<unknown>) => {
    if (locked.current) return
    locked.current = true; setBusy(true); setProblem('')
    try { await operation(); await reload() }
    catch (failure) { setProblem(errorText(failure)) }
    finally { locked.current = false; setBusy(false) }
  }
  const refresh = () => run(() => ticketId ? call('POST tickets/:id/execution/refresh', { id: ticketId })
    : worldId ? call('POST worlds/:id/execution/refresh', { id: worldId }) : call('POST execution/refresh'))
  const cancel = (effect: string) => run(async () => {
    const requestId = cancellations.current.get(effect) ?? crypto.randomUUID()
    cancellations.current.set(effect, requestId)
    try {
      if (ticketId) await call('POST tickets/:id/execution/:effect/cancel', { id: ticketId, effect, body: { requestId } })
      else if (worldId) await call('POST worlds/:id/execution/:effect/cancel', { id: worldId, effect, body: { requestId } })
      else await call('POST execution/:effect/cancel', { effect, body: { requestId } })
      cancellations.current.delete(effect)
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) cancellations.current.delete(effect)
      throw failure
    }
  })
  return <Section title={t('execution.title')} count={data?.total}>
    <Hint>{t('execution.intro')}</Hint>
    <Button disabled={busy} onClick={() => { void refresh() }}>{t('execution.refresh')}</Button>
    {(problem || error) && <p role="alert" className="dt-error">{problem || errorText(error)}</p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {!!data?.blocked && <p role="status" className="dt-banner">{t('execution.blocked', { count: data.blocked })}</p>}
    {data?.total === 0 && <Hint>{t('execution.empty')}</Hint>}
    <ul className="dt-list">{data?.items.map(receipt => <li key={receipt.id} className="dt-row">
      <div className="dt-row-main">
        <div className="dt-row-title">{t(`execution.${receipt.kind}`)}{receipt.program && <> · <code>{receipt.program}</code></>}</div>
        <p><code>{receipt.target}</code></p>
        <p><strong>{t(`execution.phase.${receipt.phase}`)}</strong>{' · '}{t(receipt.quiescent === true ? 'execution.stopped'
          : receipt.quiescent === false ? 'execution.active' : 'execution.unconfirmed')}</p>
        {receipt.problem && <p className="dt-error">{receipt.problem}</p>}
        {receipt.outcome && <p>{t('execution.outcome', { code: receipt.outcome.exitCode ?? t('empty'), signal: receipt.outcome.signal ?? t('empty') })}</p>}
        {receipt.owner.kind === 'assignment' ? <>
          <p>{t('execution.tool')}: <code>{receipt.owner.tool}</code></p>
          <div className="dt-row-actions"><SessionButton sessionId={receipt.owner.sessionId} />
            {!ticketId && <Button onClick={() => { if (receipt.owner.kind === 'assignment') navigate({ page: 'execution', id: receipt.owner.ticketId }) }}>{t('term.ticket')}</Button>}
          </div>
        </> : <p>{t('execution.host')}: <code>{receipt.owner.purpose}</code></p>}
        <details><summary>{t('execution.receipt')}: {receipt.id}</summary>
          <p>{t('execution.grant')}: <code>{receipt.grantId}</code> · {receipt.epoch}</p>
          <p>{t('execution.world')}: <code>{receipt.world}</code></p>
          {receipt.owner.kind === 'assignment' && <>
            <p>{t('term.assignment')}: <code>{receipt.owner.assignmentId}</code></p>
            <p>{t('execution.call')}: <code>{receipt.owner.callId}</code></p>
          </>}
          <p>{t('execution.updated')}: <When at={receipt.updatedAt} /></p>
          {receipt.reconciled && <p>{t('execution.reconciled')}: {receipt.reconciled.note} · <When at={receipt.reconciled.at} /></p>}
        </details>
        {receipt.kind === 'command' && receipt.quiescent !== true && <Button disabled={busy} aria-label={`${t('execution.cancel')}: ${receipt.id}`}
          onClick={() => { void cancel(receipt.id) }}>{t('execution.cancel')}</Button>}
      </div>
    </li>)}</ul>
    {data && <div className="dt-row-actions">
      {offset > 0 && <Button disabled={busy} onClick={() => setOffset(value => Math.max(0, value - 20))}>{t('execution.previous')}</Button>}
      {data.nextOffset !== null && <Button disabled={busy} onClick={() => setOffset(data.nextOffset!)}>{t('execution.next')}</Button>}
    </div>}
  </Section>
}
