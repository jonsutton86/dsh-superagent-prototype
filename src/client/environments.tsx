import { useRef, useState, type FormEvent } from 'react'
import type { EnvironmentList, EnvironmentView } from '../environments/model.ts'
import { ApiError, usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import { When } from './widgets.tsx'
import { ExecutionReceipts } from './execution-receipts.tsx'

/** Preserve the submitted revision and request ID when a response is lost after a commit. */
function useEnvironmentCommand(changed: () => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), pending = useRef<{ key: string; send: () => Promise<unknown> }>()
  const execute = async () => {
    if (lock.current) return
    if (!pending.current) return
    lock.current = true; setBusy(true); setError('')
    try { await pending.current.send(); pending.current = undefined; changed() }
    catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) pending.current = undefined
      setError(errorText(failure))
    } finally { lock.current = false; setBusy(false) }
  }
  const run = async (identity: unknown, send: (requestId: string) => Promise<unknown>) => {
    if (lock.current) return
    const key = JSON.stringify(identity)
    if (pending.current?.key !== key) { const id = crypto.randomUUID(); pending.current = { key, send: () => send(id) } }
    await execute()
  }
  return { busy, error, run, retry: pending.current ? execute : undefined }
}

/** Operator enrollment and grant controls for the current Harness execution world. */
export function EnvironmentsPage() {
  const { call, t } = usePanel(), { reload: refreshState } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET environments'), [call])
  const changed = () => { void reload(); void refreshState() }, command = useEnvironmentCommand(changed)
  const enroll = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!data) return
    const body = { name: String(new FormData(event.currentTarget).get('name') ?? ''), root: data.currentRoot, mode: data.currentMode }
    void command.run(body, requestId => call('POST environments', { body: { ...body, requestId } }))
  }
  return <section className="dt-missions">
    <div className="dt-mission-heading"><div><h2>{t('tab.environments')}</h2><p>{t('environment.intro')}</p></div>
      <Button onClick={() => { void reload(); void refreshState() }}>{t('mission.refresh')}</Button></div>
    <p className="dt-hint">{t(data?.currentKind === 'remote' ? 'environment.remoteBoundary' : 'environment.localBoundary')}</p>
    {(error || command.error) && <p role="alert" className="dt-error">{command.error || error?.message}
      {command.error && command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('environment.retry')}</Button>}</p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <><p>{t('environment.configuredRoot')}: <code>{data.currentRoot}</code></p>
      {data.needsEnrollment && <form className="dt-mission-form" onSubmit={enroll}>
        <p>{t('environment.enrollHint')}</p><label>{t('environment.name')}<input name="name" required maxLength={160} /></label>
        <Button type="submit" disabled={command.busy}>{t('environment.enroll')}</Button>
      </form>}
      {data.items.map(record => <EnvironmentCard key={record.id} record={record} listing={data} changed={changed} />)}
      {data.currentKind === 'remote' && <ExecutionReceipts />}
    </>}
  </section>
}

function EnvironmentCard({ record, listing, changed }: { record: EnvironmentView; listing: EnvironmentList; changed: () => void }) {
  const { call, t } = usePanel(), [reason, setReason] = useState(''), [replace, setReplace] = useState(false)
  const command = useEnvironmentCommand(changed)
  const verify = () => {
    const body = { name: record.name, root: listing.currentRoot, mode: listing.currentMode }
    void command.run({ verify: record.id }, requestId => call('POST environments', { body: { ...body, requestId } }))
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const enabled = !record.enabled
    void command.run({ id: record.id, enabled, reason }, requestId => call('PUT environments/:id', { id: record.id,
      body: { requestId, revision: record.revision, enabled, reason } }))
  }
  const replaceEnrollment = () => {
    const body = { name: record.name, root: listing.currentRoot, mode: listing.currentMode, replaceId: record.id, revision: record.revision }
    void command.run({ replace: record.id }, requestId => call('POST environments', { body: { ...body, requestId } }))
  }
  return <article className="dt-mission-card">
    <h3>{record.name} {record.current && <span className="dt-hint">· {t('environment.current')}</span>}</h3>
    <p><strong>{t(record.retired ? 'environment.retired' : record.enabled ? 'environment.enabled' : 'environment.revoked')}</strong>
      {' · '}{t('environment.grant', { revision: record.revision, epoch: record.epoch })}</p>
    <p><code>{record.root}</code></p><p className="dt-hint">{record.id}</p>
    <p>{t('environment.openTickets', { count: record.openTickets })}</p>
    {record.verifiedAt && <p>{t('environment.verified')}: <When at={record.verifiedAt} /></p>}
    {record.problem && <p role="status" className="dt-error">{record.problem}</p>}
    {record.remote && <p className="dt-hint">{t('environment.remoteEndpoint')}: <code>{record.remote.endpointId}</code></p>}
    {record.remoteStatus?.problem && <p role="status" className="dt-error">{record.remoteStatus.problem}</p>}
    {record.remoteStatus && record.remoteStatus.phase !== 'active' && <p role="status">{t(!record.remoteStatus.acknowledged
      ? 'environment.remotePending' : record.remoteStatus.quiescent ? 'environment.remoteStopped' : 'environment.remoteUncertain')}</p>}
    {command.error && <p role="alert" className="dt-error">{command.error}
      {command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('environment.retry')}</Button>}</p>}
    {!record.retired && <>
      {record.current && <div className="dt-mission-buttons">
        <Button disabled={command.busy} onClick={verify}>{t('environment.verify')}</Button>
        {record.kind === 'local' && <Button disabled={command.busy} onClick={() => setReplace(!replace)}>{t('environment.replace')}</Button>}
      </div>}
      {replace && <div className="dt-mission-form"><p>{t('environment.replaceHint')}</p>
        <Button disabled={command.busy} onClick={replaceEnrollment}>{t('environment.replaceConfirm')}</Button></div>}
      {record.kind === 'remote' && !record.enabled ? <p>{t('environment.remoteReauthorize')}</p> : <form className="dt-mission-form" onSubmit={submit}>
        <p className="dt-hint">{t(record.enabled ? 'environment.revokeHint' : 'environment.enableHint')}</p>
        <label>{t('environment.reason')}<textarea value={reason} onChange={event => setReason(event.target.value)} required maxLength={2000} rows={2} /></label>
        <Button type="submit" disabled={command.busy || !reason.trim()}>{t(record.enabled ? 'environment.revoke' : 'environment.enable')}</Button>
      </form>}
    </>}
  </article>
}
