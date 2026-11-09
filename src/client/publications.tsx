import { useRef, useState } from 'react'
import type { LibraryRead } from '../workspace/library-model.ts'
import type { ApprovePublication, PublicationRecord } from '../publication/runtime.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { destinationLabel } from './destinations.ts'

/** Exact artifact/destination review, durable publication receipts and same-intent recovery. */
export function PublicationCard({ record }: { record: LibraryRead }) {
  const { call, t } = usePanel()
  const catalog = usePoll(() => call('GET publication/destinations'), [call])
  const receipts = usePoll(() => call('GET library/:id/publications', { id: record.id }), [call, record.id])
  const [destinationId, setDestination] = useState(''), [review, setReview] = useState<{ hash: string; text: string }>()
  const [approved, setApproved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), pending = useRef<{ fingerprint: string; body: ApprovePublication }>()
  const destination = catalog.data?.items.find(item => item.id === destinationId)
  const current = !record.archived && !record.expired && !record.superseded && !record.conflicted && !record.staleSources.length && record.text && record.freshness?.status === 'current'
  const duplicate = receipts.data?.items.some(item => item.hash === record.hash && item.destinationHash === destination?.hash
    && !['failed', 'cancelled', 'not_delivered'].includes(item.receipt?.phase ?? 'unknown'))
  const run = async (operation: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(errorText(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const preview = () => run(async () => {
    const content = await call('GET library/:id/content', { id: record.id })
    if (content.hash !== record.hash) throw new Error(t('publication.changed'))
    const text = new TextDecoder().decode(Uint8Array.from(atob(content.data), char => char.charCodeAt(0)))
    setReview({ hash: content.hash, text }); setApproved(false)
  })
  const publish = () => run(async () => {
    if (!destination || !approved || review?.hash !== record.hash || !current || duplicate) return
    const body = { revision: record.revision, hash: record.hash, destination: destination.id, destinationHash: destination.hash }, fingerprint = JSON.stringify(body)
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, body: { ...body, requestId: crypto.randomUUID() } }
    await call('POST library/:id/publications', { id: record.id, body: pending.current.body })
    pending.current = undefined; setApproved(false); await receipts.reload()
  })
  const recover = (item: PublicationRecord, retry: boolean) => run(async () => {
    await call(retry ? 'POST publications/:id/retry' : 'POST publications/:id/refresh', { id: item.id }); await receipts.reload()
  })
  if (catalog.data?.configured === false && !receipts.data?.items.length) return null
  return <section className="dt-publications" aria-label={t('publication.title')}>
    <h3>{t('publication.title')}</h3>
    {(error || catalog.error || receipts.error) && <p role="alert" className="dt-error">{error || catalog.error?.message || receipts.error?.message}</p>}
    {catalog.data?.configured && <details>
      <summary>{t('publication.review')}</summary>
      <p>{t('publication.intro')}</p>
      <label>{t('publication.destination')}<select value={destinationId} disabled={busy} onChange={event => { setDestination(event.target.value); setApproved(false) }}>
        <option value="">{t('publication.select')}</option>
        {catalog.data.items.map(item => <option key={item.id} value={item.id}>{item.name} — {destinationLabel(item)}</option>)}
      </select></label>
      {destination && <p>{destinationLabel(destination)}</p>}
      {!current && <p>{t('publication.changed')}</p>}
      {duplicate && <p>{t('publication.existing')}</p>}
      {record.bytes > (destination?.maxBytes ?? Infinity) && <p>{t('publication.tooLarge')}</p>}
      <Button disabled={busy || !current} onClick={() => { void preview() }}>{t('publication.preview')}</Button>
      {review?.hash === record.hash && <pre className="dt-library-excerpt">{review.text}</pre>}
      <label><input type="checkbox" checked={approved} disabled={busy || !destination || review?.hash !== record.hash || !current || duplicate}
        onChange={event => setApproved(event.target.checked)} />{t('publication.approve')}</label>
      <Button variant="primary" disabled={busy || !approved || !destination || !current || duplicate || record.bytes > destination.maxBytes}
        onClick={() => { void publish() }}>{t('publication.send')}</Button>
    </details>}
    {receipts.data?.items.map(item => <article key={item.id} className="dt-mission-card">
      <strong>{catalog.data?.items.find(value => value.id === item.destination)?.name ?? item.destination}</strong>
      <p role="status">{t(`publication.phase.${item.receipt?.phase ?? item.phase}`)}</p>
      {item.problem && <p>{item.problem}</p>}{item.receipt?.problem && <p>{item.receipt.problem}</p>}
      {item.receipt?.external && <a href={item.receipt.external.url} target="_blank" rel="noreferrer">{t('publication.open')}</a>}
      {!['sent', 'failed', 'cancelled', 'not_delivered'].includes(item.receipt?.phase ?? '') && <div className="dt-mission-buttons">
        <Button disabled={busy} onClick={() => { void recover(item, false) }}>{t('publication.observe')}</Button>
        <Button disabled={busy || !current} onClick={() => { void recover(item, true) }}>{t('publication.retry')}</Button>
      </div>}
    </article>)}
  </section>
}
