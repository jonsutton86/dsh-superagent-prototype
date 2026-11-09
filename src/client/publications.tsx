import { useRef, useState } from 'react'
import type { LibraryRead } from '../workspace/library-model.ts'
import type { ApprovePublication, PublicationRecord } from '../publication/runtime.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { destinationLabel } from './destinations.ts'
import { ArtifactCheckPicker, EvidenceReviewStatus } from './verification.tsx'
import type { CheckSelection } from '../verification/review-model.ts'
import type { PullObservation } from '../publication/pull-model.ts'

/** Exact artifact/destination review, durable publication receipts and same-intent recovery. */
export function PublicationCard({ record }: { record: LibraryRead }) {
  const { call, t } = usePanel()
  const catalog = usePoll(() => call('GET publication/destinations'), [call])
  const receipts = usePoll(() => call('GET library/:id/publications', { id: record.id }), [call, record.id])
  const [destinationId, setDestination] = useState(''), [review, setReview] = useState<{ hash: string; text: string }>()
  const [approved, setApproved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [checks, setChecks] = useState<CheckSelection[]>([])
  const [pull, setPull] = useState<PullObservation>()
  const lock = useRef(false), pending = useRef<{ fingerprint: string; body: ApprovePublication }>()
  const destination = catalog.data?.items.find(item => item.id === destinationId)
  const current = !record.archived && !record.expired && !record.superseded && !record.conflicted && !record.staleSources.length && record.text && record.freshness?.status === 'current'
  const isPull = destination?.kind === 'github-pr-review'
  const pullReady = !isPull || catalog.data?.pullReviews === true && pull?.destination === destination.id && pull.destinationHash === destination.hash
    && pull.binding.state === 'open' && !pull.binding.merged && !(pull.binding.draft && destination.event === 'APPROVE')
  const needsChecks = record.provenance.actor === 'worker' || isPull, checksReady = pullReady && (!needsChecks || !!checks.length && catalog.data?.artifactEvidence === true)
  const duplicate = receipts.data?.items.some(item => !(item.phase === 'held' && !item.receipt) && item.hash === record.hash && item.destinationHash === destination?.hash
    && !['failed', 'cancelled', 'not_delivered'].includes(item.receipt?.phase ?? 'unknown')
    && (item.receipt?.phase !== 'sent' || (item.pull?.binding.head.sha ?? '') === (isPull ? pull?.binding.head.sha ?? '' : '')))
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
    if (!destination || !approved || review?.hash !== record.hash || !current || duplicate || !checksReady) return
    const body = { revision: record.revision, hash: record.hash, destination: destination.id, destinationHash: destination.hash,
      ...(needsChecks ? { checks: [...checks].sort((a, b) => a.runId.localeCompare(b.runId)) } : {}), ...(isPull && pull ? { pullHash: pull.hash } : {}) }, fingerprint = JSON.stringify(body)
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, body: { ...body, requestId: crypto.randomUUID() } }
    await call('POST library/:id/publications', { id: record.id, body: pending.current.body })
    pending.current = undefined; setApproved(false); await receipts.reload()
  })
  const recover = (item: PublicationRecord, retry: boolean) => run(async () => {
    await call(retry ? 'POST publications/:id/retry' : 'POST publications/:id/refresh', { id: item.id }); await receipts.reload()
  })
  const inspectPull = () => run(async () => {
    setApproved(false); setChecks([]); setPull(undefined)
    if (destination?.kind === 'github-pr-review') setPull(await call('GET publication/destinations/:id/pull', { id: destination.id, query: { hash: destination.hash } }))
  })
  if (catalog.data?.configured === false && !receipts.data?.items.length) return null
  return <section className="dt-publications" aria-label={t('publication.title')}>
    <h3>{t('publication.title')}</h3>
    {(error || catalog.error || receipts.error) && <p role="alert" className="dt-error">{error || catalog.error?.message || receipts.error?.message}</p>}
    {catalog.data?.configured && <details>
      <summary>{t('publication.review')}</summary>
      <p>{t('publication.intro')}</p>
      <label>{t('publication.destination')}<select value={destinationId} disabled={busy} onChange={event => { setDestination(event.target.value); setApproved(false); setPull(undefined); setChecks([]) }}>
        <option value="">{t('publication.select')}</option>
        {catalog.data.items.map(item => <option key={item.id} value={item.id}>{item.name} — {destinationLabel(item)}</option>)}
      </select></label>
      {destination && <p>{destinationLabel(destination)}</p>}
      {isPull && <><Button disabled={busy || catalog.data.pullReviews !== true} onClick={() => { void inspectPull() }}>{t('publication.inspectPull')}</Button>
        <p>{t('publication.pullHint')}</p>{pull && <PullDetails pull={pull} />}
        {catalog.data.pullReviews !== true && <p>{t('verification.publisherUpdate')}</p>}</>}
      {!current && <p>{t('publication.changed')}</p>}
      {duplicate && <p>{t('publication.existing')}</p>}
      {record.bytes > (destination?.maxBytes ?? Infinity) && <p>{t('publication.tooLarge')}</p>}
      <Button disabled={busy || !current} onClick={() => { void preview() }}>{t('publication.preview')}</Button>
      {review?.hash === record.hash && <pre className="dt-library-excerpt">{review.text}</pre>}
      {needsChecks ? <><ArtifactCheckPicker artifactId={record.id} selected={checks} onChange={value => { setChecks(value); setApproved(false) }} disabled={busy || !pullReady} pull={isPull ? pull?.binding : undefined} />
        {catalog.data.artifactEvidence !== true && <p>{t('verification.publisherUpdate')}</p>}</> : <p>{t('verification.manualContent')}</p>}
      <label><input type="checkbox" checked={approved} disabled={busy || !destination || review?.hash !== record.hash || !current || duplicate || !checksReady}
        onChange={event => setApproved(event.target.checked)} />{t('publication.approve')}</label>
      <Button variant="primary" disabled={busy || !approved || !destination || !current || duplicate || !checksReady || record.bytes > destination.maxBytes}
        onClick={() => { void publish() }}>{t('publication.send')}</Button>
    </details>}
    {busy && needsChecks && <p role="status">{t('verification.preparing')}</p>}
    {receipts.data?.items.map(item => <article key={item.id} className="dt-mission-card">
      <strong>{catalog.data?.items.find(value => value.id === item.destination)?.name ?? item.destination}</strong>
      <p role="status">{t(`publication.phase.${item.receipt?.phase ?? item.phase}`)}</p>
      {item.problem && <p>{item.problem}</p>}{item.receipt?.problem && <p>{item.receipt.problem}</p>}
      {item.pull && <PullDetails pull={item.pull} />}
      {item.receipt?.external?.review && <p>{t('publication.reviewReceipt')} {item.receipt.external.review.state} · {item.receipt.external.review.commit}</p>}
      {item.verification && <PublicationEvidence id={item.verification.reviewId} />}
      {item.receipt?.external && <a href={item.receipt.external.url} target="_blank" rel="noreferrer">{t('publication.open')}</a>}
      {!['sent', 'failed', 'cancelled', 'not_delivered'].includes(item.receipt?.phase ?? '') && <div className="dt-mission-buttons">
        <Button disabled={busy} onClick={() => { void recover(item, false) }}>{t('publication.observe')}</Button>
        <Button disabled={busy} onClick={() => { void recover(item, true) }}>{t('publication.retry')}</Button>
      </div>}
    </article>)}
  </section>
}
function PullDetails({ pull }: { pull: PullObservation }) {
  const { t } = usePanel(), { head, base } = pull.binding
  return <dl><dt>{t('publication.pullHead')}</dt><dd>{head.repository.name} · {head.ref}<code>{head.sha}</code></dd>
    <dt>{t('publication.pullTree')}</dt><dd>{head.tree}</dd><dt>{t('publication.pullBase')}</dt><dd>{base.repository.name} · {base.ref}<code>{base.sha}</code></dd>
    <dt>{t('publication.pullObserved')}</dt><dd>{new Date(pull.observedAt).toLocaleString()} · {pull.binding.state}{pull.binding.draft ? ' · draft' : ''}{pull.binding.merged ? ' · merged' : ''}</dd></dl>
}
function PublicationEvidence({ id }: { id: string }) {
  const { t } = usePanel(), [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{t('verification.approvalEvidence')}</summary>
    {open && <EvidenceReviewStatus id={id} />}
  </details>
}
