/** Operator-reviewed repository publication; retained intents are never replaced to recover an uncertain outcome. */
import { useEffect, useState, type FormEvent } from 'react'
import type { RepositoryExportView } from '../publication/repository-export-model.ts'
import type { RepositoryPublicationView } from '../publication/repository-runtime-model.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { useOperatorCommand } from './operator-command.ts'
import { usePanel } from './provider.tsx'
import { EvidenceReviewStatus } from './verification.tsx'

export function RepositoryPublicationCard({ exported, current }: { exported: RepositoryExportView; current: boolean }) {
  const { call, t } = usePanel()
  const catalog = usePoll(() => call('GET repository-publication/destinations'), [call])
  const history = usePoll(() => call('GET repository-exports/:id/publications', { id: exported.id }), [call, exported.id])
  const command = useOperatorCommand(() => { void history.reload() })
  const [destinationId, setDestination] = useState(''), [title, setTitle] = useState(''), [body, setBody] = useState(''), [draft, setDraft] = useState(true)
  const destination = catalog.data?.items.find(item => item.id === destinationId)
  const duplicate = history.data?.items.some(item => item.destination.hash === destination?.hash
    && (item.phase !== 'cancelled' || !!item.receipt?.attempts.length))
  const blocked = command.busy || !!command.retry
  const prepare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (blocked || !destination || !current || exported.phase !== 'ready' || duplicate || !title.trim()) return
    const request = { destination: destination.id, destinationHash: destination.hash, title: title.trim(), body, draft }
    void command.run({ exportId: exported.id, ...request }, requestId => call('POST repository-exports/:id/publications', {
      id: exported.id, body: { ...request, requestId },
    }))
  }
  if (catalog.data?.configured === false && !history.data?.items.length && !history.error && !command.retry) return null
  return <section className="dt-publications" aria-label={t('repositoryPublication.title')}>
    <h4>{t('repositoryPublication.title')}</h4><p>{t('repositoryPublication.intro')}</p>
    {(catalog.error || history.error || command.error) && <p role="alert" className="dt-error">{command.error || catalog.error?.message || history.error?.message}</p>}
    {command.retry && <><p>{t('repositoryPublication.pendingRequest')}</p>
      <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('repositoryPublication.recoverRequest')}</Button></>}
    {catalog.data?.configured && exported.phase === 'ready' && <details><summary>{t('repositoryPublication.prepare')}</summary>
      <form className="dt-mission-form" onSubmit={prepare}>
        <fieldset disabled={blocked || !current}>
          <label>{t('publication.destination')}<select required value={destinationId} onChange={event => setDestination(event.target.value)}>
            <option value="">{t('publication.select')}</option>
            {catalog.data.items.map(item => <option key={item.id} value={item.id}>{item.name} — {item.repository} / {item.baseRef}</option>)}
          </select></label>
          {destination && <dl><dt>{t('repositoryPublication.repository')}</dt><dd>{destination.repository} · #{destination.repositoryId}</dd>
            <dt>{t('publication.pullBase')}</dt><dd>{destination.baseRef}</dd><dt>{t('repositoryPublication.account')}</dt><dd>{destination.login}</dd>
            <dt>{t('repositoryPublication.destinationHash')}</dt><dd><code>{destination.hash}</code></dd></dl>}
          <dl><dt>{t('repositoryExport.base')}</dt><dd><code>{exported.source.commit}</code></dd>
            <dt>{t('repositoryExport.head')}</dt><dd><code>{exported.head}</code></dd></dl>
          <label>{t('repositoryPublication.pullTitle')}<input required maxLength={240} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label>{t('repositoryPublication.pullBody')}<textarea rows={6} maxLength={30000} value={body} onChange={event => setBody(event.target.value)} /></label>
          <label><input type="checkbox" checked={draft} onChange={event => setDraft(event.target.checked)} />{t('repositoryPublication.draft')}</label>
          {duplicate && <p>{t('repositoryPublication.existing')}</p>}
          <Button type="submit" disabled={!destination || !title.trim() || duplicate}>{t('repositoryPublication.prepare')}</Button>
        </fieldset>
      </form>
    </details>}
    {!current && <p>{t('repositoryPublication.notCurrent')}</p>}
    {history.data?.items.map(item => <RepositoryPublicationIntent key={item.id} item={item} current={current && exported.phase === 'ready'} onChanged={history.reload} />)}
  </section>
}

function RepositoryPublicationIntent({ item, current, onChanged }: { item: RepositoryPublicationView; current: boolean; onChanged(): Promise<unknown> }) {
  const { call, t } = usePanel(), [approvedReview, setApprovedReview] = useState('')
  const command = useOperatorCommand(() => { setApprovedReview(''); void onChanged() })
  useEffect(() => { if (!current) setApprovedReview('') }, [current])
  const receipt = item.receipt, pull = receipt?.pullResult, branch = receipt?.branchResult
  const settled = ['published', 'cancelled', 'reconciled'].includes(item.phase)
  const unknown = item.phase === 'unknown' || !!receipt && ['unknown', 'branch_started', 'pull_started'].includes(receipt.phase)
  const blocked = command.busy || !!command.retry
  // Approval expires when the prepared target or observed external progress changes; polling alone does not reapprove it.
  const review = JSON.stringify([item.id, item.publication, item.destination, item.transfer, item.phase, item.cancelRequested, receipt, item.approvals])
  const canApprove = current && item.phase === 'ready' && !!receipt && !unknown && !item.cancelRequested && !blocked
  const approved = canApprove && approvedReview === review
  const publish = () => {
    if (!approved) return
    setApprovedReview('')
    void command.run({ publish: item.id, review }, requestId => call('POST repository-publications/:id/publish', { id: item.id, body: { requestId } }))
  }
  return <article className="dt-mission-card">
    <strong>{item.destination.name}</strong><p role="status">{t(`repositoryPublication.phase.${item.phase}`)}</p>
    <dl><dt>{t('repositoryPublication.intent')}</dt><dd><code>{item.id}</code></dd>
      <dt>{t('repositoryPublication.repository')}</dt><dd>{item.destination.repository} · #{item.destination.repositoryId}</dd>
      <dt>{t('publication.pullBase')}</dt><dd>{item.destination.baseRef}</dd>
      <dt>{t('repositoryPublication.account')}</dt><dd>{item.destination.login}</dd>
      <dt>{t('repositoryPublication.destinationHash')}</dt><dd><code>{item.destination.hash}</code></dd>
      <dt>{t('repositoryExport.base')}</dt><dd><code>{item.transfer.bundle.base}</code></dd>
      <dt>{t('repositoryExport.head')}</dt><dd><code>{item.transfer.bundle.head}</code></dd>
      <dt>{t('repositoryPublication.branch')}</dt><dd>{receipt?.branch ?? t('repositoryPublication.awaitingBranch')}</dd>
      <dt>{t('repositoryPublication.pullTitle')}</dt><dd>{item.publication.title}</dd>
      <dt>{t('repositoryPublication.pullMode')}</dt><dd>{t(item.publication.draft ? 'repositoryPublication.draft' : 'repositoryPublication.readyPull')}</dd>
      <dt>{t('repositoryPublication.transfer')}</dt><dd>{item.received.toLocaleString()} / {item.transfer.bundle.bytes.toLocaleString()} {t('repositoryExport.bytes')}</dd>
      <dt>{t('repositoryPublication.bundleHash')}</dt><dd><code>{item.transfer.bundle.sha256}</code></dd>
    </dl>
    <p>{t('repositoryPublication.pullBody')}</p><pre className="dt-library-excerpt">{item.publication.body || t('repositoryPublication.emptyBody')}</pre>
    {item.problem && <p>{item.problem}</p>}{receipt?.problem && receipt.problem !== item.problem && <p>{receipt.problem}</p>}
    {receipt && <p>{t('repositoryPublication.publisherState')} {t(`repositoryPublication.receipt.${receipt.phase}`)}</p>}
    {branch && <p>{t('repositoryPublication.branchResult')} {branch.repository} / {branch.ref} <code>{branch.sha}</code></p>}
    {pull && <p><a href={pull.url} target="_blank" rel="noreferrer">{t('repositoryPublication.openPull', { number: pull.number })}</a>
      {' · '}{pull.state}{pull.merged ? ` · ${t('repositoryPublication.merged')}` : ''}<br />{pull.base.ref} <code>{pull.base.sha}</code></p>}
    {unknown && <p>{t('repositoryPublication.unknownHint')}</p>}
    {item.cancelRequested && <p>{t('repositoryPublication.cancelRequested')}</p>}
    {command.error && <p role="alert" className="dt-error">{command.error}</p>}
    {command.retry && <><p>{t('repositoryPublication.pendingRequest')}</p>
      <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('repositoryPublication.recoverRequest')}</Button></>}
    {item.phase === 'ready' && !unknown && !item.cancelRequested && <>
      <p>{t('repositoryPublication.approvalHint')}</p>
      <label><input type="checkbox" checked={approved} disabled={!canApprove} onChange={event => setApprovedReview(event.target.checked ? review : '')} />{t('repositoryPublication.approve')}</label>
      <Button variant="primary" disabled={!approved} onClick={publish}>{t('repositoryPublication.publish')}</Button>
    </>}
    <div className="dt-mission-buttons">
      <Button disabled={blocked} onClick={() => { setApprovedReview(''); void command.run({ observe: item.id }, () => call('POST repository-publications/:id/refresh', { id: item.id })) }}>{t('repositoryPublication.observe')}</Button>
      {!settled && !unknown && !item.cancelRequested && item.phase !== 'ready' && <Button disabled={blocked || !current} onClick={() => { setApprovedReview(''); void command.run({ prepare: item.id }, () => call('POST repository-publications/:id/retry', { id: item.id })) }}>{t('repositoryPublication.resume')}</Button>}
      {!settled && !unknown && <Button disabled={blocked} onClick={() => { setApprovedReview(''); void command.run({ cancel: item.id }, () => call('POST repository-publications/:id/cancel', { id: item.id })) }}>{t(item.cancelRequested ? 'repositoryPublication.retryCancel' : 'repositoryPublication.cancel')}</Button>}
    </div>
    {item.approvals.map(approval => <RepositoryApproval key={approval.id} approval={approval} />)}
  </article>
}

function RepositoryApproval({ approval }: { approval: RepositoryPublicationView['approvals'][number] }) {
  const { t } = usePanel(), [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{t('verification.approvalEvidence')} · {new Date(approval.at).toLocaleString()}</summary>
    <p><code>{approval.id}</code></p><p>{t(approval.dispatched ? 'repositoryPublication.approvalDispatched' : 'repositoryPublication.approvalHeld')}</p>
    {open && <EvidenceReviewStatus id={approval.id} />}
  </details>
}
