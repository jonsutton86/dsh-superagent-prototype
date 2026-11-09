import { useRef, useState, type FormEvent } from 'react'
import type { LibraryRead } from '../workspace/library-model.ts'
import type { CheckRecord, CheckRun, CreateCheckInput } from '../verification/contracts.ts'
import { CheckDefinition } from '../verification/contracts.ts'
import type { CheckSelection } from '../verification/review-model.ts'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Button } from './controls.tsx'
import { errorText } from './text.ts'

/** Keep original command IDs through response loss; every changed input is a separate intent. */
function useCommand() {
  const pending = useRef(new Map<string, string>())
  const get = (operation: string, input: unknown) => {
    const key = JSON.stringify([operation, input])
    if (!pending.current.has(key)) pending.current.set(key, crypto.randomUUID())
    return pending.current.get(key)!
  }
  return Object.assign(get, { complete: (operation: string, input: unknown) => pending.current.delete(JSON.stringify([operation, input])) })
}
function useOperation() {
  const lock = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  return { busy, error, run: async (operation: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(errorText(failure)) }
    finally { lock.current = false; setBusy(false) }
  } }
}

export function CheckRegistry() {
  const { call, t } = usePanel(), [offset, setOffset] = useState(0), [create, setCreate] = useState(false)
  const catalog = usePoll(() => call('GET checks', { query: { offset } }), [call, offset])
  return <section className="dt-publications" aria-label={t('verification.registry')}>
    <h3>{t('verification.registry')}</h3><p>{t('verification.registryHint')}</p>
    {catalog.error && <p role="alert">{catalog.error.message}</p>}
    <Button onClick={() => setCreate(!create)}>{t(create ? 'cancel' : 'verification.new')}</Button>
    {create && <CheckEditor onSaved={async () => { setCreate(false); await catalog.reload() }} />}
    {catalog.data?.items.map(check => <details key={check.id} className="dt-mission-card">
      <summary>{check.definition.name} · v{check.version} · {t(check.enabled ? 'verification.enabled' : 'verification.disabled')}</summary>
      <p>{check.definition.description}</p><p>{check.definition.scope} · {check.definition.confinement}</p>
      <CheckAuthority key={`authority:${check.id}:${check.revision}`} check={check} onSaved={catalog.reload} />
      <details><summary>{t('verification.edit')}</summary><CheckEditor key={`editor:${check.id}:${check.revision}`} check={check} onSaved={catalog.reload} /></details>
    </details>)}
    <div className="dt-mission-buttons">
      <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>{t('mission.previous')}</Button>
      <Button disabled={catalog.data?.nextOffset == null} onClick={() => setOffset(catalog.data!.nextOffset!)}>{t('mission.next')}</Button>
    </div>
  </section>
}
function CheckEditor({ check, onSaved }: { check?: CheckRecord; onSaved(): Promise<unknown> }) {
  const { call, t } = usePanel(), operation = useOperation(), command = useCommand()
  const [confinement, setConfinement] = useState(check?.definition.confinement ?? 'linux-bubblewrap')
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    void operation.run(async () => {
      const definition = CheckDefinition.parse({ name: form.get('name'), description: form.get('description'), scope: form.get('scope'), artifactPath: form.get('path'),
        argv: JSON.parse(String(form.get('argv'))), confinement, timeoutSeconds: Number(form.get('timeout')),
        maxConcurrent: Number(form.get('concurrency')), maxRunsPerDay: Number(form.get('daily')),
        env: JSON.parse(String(form.get('env'))), snapshot: JSON.parse(String(form.get('snapshot'))), stdin: String(form.get('stdin') ?? '') || undefined })
      const body = { definition, ...check ? { revision: check.revision } : {} }, requestId = command(check?.id ?? 'create', body)
      if (check) await call('PUT checks/:id', { id: check.id, body: { definition, revision: check.revision, requestId } })
      else await call('POST checks', { body: { definition, requestId } satisfies CreateCheckInput })
      await onSaved()
      command.complete(check?.id ?? 'create', body)
    })
  }
  return <form className="dt-mission-form" onSubmit={save}>
    {operation.error && <p role="alert">{operation.error}</p>}
    <label>{t('verification.name')}<input name="name" required maxLength={160} defaultValue={check?.definition.name} /></label>
    <label>{t('verification.description')}<textarea name="description" required maxLength={2000} defaultValue={check?.definition.description} /></label>
    <label>{t('library.scope')}<input name="scope" required defaultValue={check?.definition.scope ?? 'workspace'} /></label>
    <label>{t('verification.path')}<input name="path" required defaultValue={check?.definition.artifactPath ?? 'artifact.txt'} /></label>
    <label>{t('verification.argv')}<textarea name="argv" rows={3} required defaultValue={JSON.stringify(check?.definition.argv ?? ['/bin/sh', '-c', 'test -s artifact.txt'], null, 2)} /></label>
    <label>{t('verification.confinement')}<select value={confinement} onChange={event => setConfinement(event.target.value as typeof confinement)}>
      <option value="linux-bubblewrap">{t('verification.linux')}</option><option value="host-process">{t('verification.host')}</option>
    </select></label>
    <p>{t(confinement === 'host-process' ? 'verification.hostHint' : 'verification.linuxHint')}</p>
    <label>{t('verification.timeout')}<input type="number" name="timeout" min={1} max={3600} required defaultValue={check?.definition.timeoutSeconds ?? 300} /></label>
    <label>{t('verification.concurrency')}<input type="number" name="concurrency" min={1} max={8} required defaultValue={check?.definition.maxConcurrent ?? 1} /></label>
    <label>{t('verification.daily')}<input type="number" name="daily" min={1} max={1000} required defaultValue={check?.definition.maxRunsPerDay ?? 20} /></label>
    <details><summary>{t('verification.advanced')}</summary>
      <label>{t('verification.environment')}<textarea name="env" defaultValue={JSON.stringify(check?.definition.env ?? {}, null, 2)} /></label>
      <label>{t('verification.snapshotSettings')}<textarea name="snapshot" rows={6} defaultValue={JSON.stringify(check?.definition.snapshot ?? { repository: 'if-present', exclude: [], maxFiles: 10000, maxBytes: 268435456, timeoutSeconds: 120 }, null, 2)} /></label>
      <label>{t('verification.stdin')}<textarea name="stdin" maxLength={32000} defaultValue={check?.definition.stdin} /></label>
    </details>
    <Button type="submit" disabled={operation.busy}>{t('verification.save')}</Button>
  </form>
}
function CheckAuthority({ check, onSaved }: { check: CheckRecord; onSaved(): Promise<unknown> }) {
  const { call, t } = usePanel(), operation = useOperation(), command = useCommand()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const body = { revision: check.revision, enabled: form.has('enabled'), workers: form.has('workers'), reason: String(form.get('reason')) }
    void operation.run(async () => { await call('POST checks/:id/authority', { id: check.id, body: { ...body, requestId: command(check.id, body) } }); await onSaved() })
  }
  return <form className="dt-mission-form" onSubmit={submit}>
    <p>{t('verification.authorityHint')}</p>
    <label><input name="enabled" type="checkbox" defaultChecked={check.enabled} />{t('verification.enable')}</label>
    <label><input name="workers" type="checkbox" defaultChecked={check.workers} />{t('verification.workers')}</label>
    <label>{t('verification.reason')}<input name="reason" required maxLength={2000} /></label>
    {operation.error && <p role="alert">{operation.error}</p>}
    <Button disabled={operation.busy} type="submit">{t('verification.authority')}</Button>
  </form>
}

export function VerificationCard({ record }: { record: LibraryRead }) {
  const { call, t } = usePanel(), [offset, setOffset] = useState(0), [checkOffset, setCheckOffset] = useState(0), [selected, setSelected] = useState(''), [runId, setRunId] = useState('')
  const operation = useOperation(), command = useCommand()
  const current = !!record.execution && !record.archived && !record.expired && !record.superseded && !record.conflicted && record.freshness?.status === 'current'
  const choices = usePoll(() => current ? call('GET library/:id/checks', { id: record.id, query: { offset: checkOffset } }) : Promise.resolve({ items: [], nextOffset: null }), [call, record.id, current, checkOffset])
  const history = usePoll(() => call('GET library/:id/verification', { id: record.id, query: { offset } }), [call, record.id, offset])
  const check = choices.data?.items.find(item => `${item.id}:${item.version}` === selected)
  const request = () => operation.run(async () => {
    if (!check || !current || !check.enabled) return
    const body = { check: { id: check.id, version: check.version }, artifactRevision: record.revision, artifactHash: record.hash }
    const run = await call('POST library/:id/verification', { id: record.id, body: { ...body, requestId: command('request', body) } })
    setRunId(run.id); await history.reload(); command.complete('request', body)
  })
  return <section className="dt-publications" aria-label={t('verification.title')}>
    <h3>{t('verification.title')}</h3><p>{t('verification.evidenceHint')}</p>
    {!current && <p>{t(record.execution ? 'verification.notCurrent' : 'verification.unbound')}</p>}
    {(operation.error || choices.error || history.error) && <p role="alert">{operation.error || choices.error?.message || history.error?.message}</p>}
    {current && <><label>{t('verification.select')}<select value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">{t('verification.select')}</option>{choices.data?.items.filter(item => item.enabled).map(item => <option key={item.id} value={`${item.id}:${item.version}`}>{item.definition.name} · v{item.version}</option>)}
    </select></label>
      {check && <><p>{check.definition.description} · {check.definition.confinement}</p><pre>{JSON.stringify(check.definition.argv)}</pre><p>{check.definition.artifactPath}</p>
        <p>{t(check.definition.confinement === 'host-process' ? 'verification.hostHint' : 'verification.linuxHint')}</p></>}
      <Button disabled={!checkOffset} onClick={() => { setCheckOffset(Math.max(0, checkOffset - 30)); setSelected('') }}>{t('verification.previousChecks')}</Button>
      <Button disabled={choices.data?.nextOffset == null} onClick={() => { setCheckOffset(choices.data!.nextOffset!); setSelected('') }}>{t('verification.moreChecks')}</Button>
      <Button disabled={operation.busy || !check?.enabled} onClick={() => { void request() }}>{t('verification.run')}</Button></>}
    {history.data?.items.map(item => <article key={item.id} className="dt-mission-card">
      <strong>{item.check.name} · v{item.check.version}</strong><p role="status">{t(`verification.status.${item.status}`)} · {new Date(item.createdAt).toLocaleString()}</p>
      {item.purpose === 'freshness' && <p>{t('verification.captureOnly')}</p>}
      {item.problem && <p>{item.problem}</p>}<Button onClick={() => setRunId(item.id)}>{t('verification.details')}</Button>
    </article>)}
    <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>{t('mission.previous')}</Button>
    <Button disabled={history.data?.nextOffset == null} onClick={() => setOffset(history.data!.nextOffset!)}>{t('mission.next')}</Button>
    {runId && <VerificationRun key={runId} id={runId} onChanged={history.reload} onSelect={setRunId} />}
  </section>
}
function VerificationRun({ id, onChanged, onSelect }: { id: string; onChanged(): Promise<unknown>; onSelect(id: string): void }) {
  const { call, t } = usePanel(), operation = useOperation(), command = useCommand(), [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false)
  const detail = usePoll(() => call('GET verification/:id', { id }), [call, id]), run = detail.data
  const action = (kind: 'refresh' | 'cancel' | 'reconcile' | 'freshness') => operation.run(async () => {
    if (!run) return
    if (kind === 'refresh') await call('POST verification/:id/refresh', { id })
    else if (kind === 'cancel') { const body = run.cancel ?? { requestId: command(kind, { id, reason }), reason }; await call('POST verification/:id/cancel', { id, body: { requestId: body.requestId, reason: body.reason } }) }
    else if (kind === 'reconcile') await call('POST verification/:id/reconcile', { id, body: { requestId: command(kind, { id, reason }), reason, quiescent: true } })
    else { const capture = await call('POST verification/:id/freshness', { id, body: { requestId: command(kind, id) } }); onSelect(capture.id) }
    await detail.reload(); await onChanged()
  })
  const evidence = run?.evidence, snapshot = evidence?.snapshot
  return <article className="dt-mission-card" aria-label={t('verification.details')}>
    {(operation.error || detail.error) && <p role="alert">{operation.error || detail.error?.message}</p>}
    {run && <><h4>{run.check.definition.name} · v{run.check.version}</h4><p role="status">{t(`verification.status.${run.status}`)}</p>
      <p>{t(run.quiescent ? 'verification.stopped' : 'verification.active')}</p>{run.problem && <p>{run.problem}</p>}
      <dl><dt>{t('verification.confinement')}</dt><dd>{evidence?.confinement ?? run.backend.confinement}</dd>
        <dt>{t('verification.source')}</dt><dd>{run.backend.source}</dd><dt>{t('verification.assignment')}</dt><dd>{run.artifact.assignmentId}</dd>
        <dt>{t('verification.environmentId')}</dt><dd>{run.backend.binding}</dd><dt>{t('verification.artifactHash')}</dt><dd>{run.artifact.hash}</dd>
        {snapshot && <><dt>{t('verification.snapshotHash')}</dt><dd>{snapshot.hash}</dd><dt>{t('verification.capturedAt')}</dt><dd>{snapshot.capturedAt}</dd>
          <dt>{t('verification.inputs')}</dt><dd>{snapshot.files} / {snapshot.bytes} bytes</dd>
          {snapshot.repository && <><dt>Git commit / tree</dt><dd>{snapshot.repository.commit} / {snapshot.repository.tree}</dd></>}</>}
        {run.outcome && <><dt>{t('verification.exit')}</dt><dd>{String(run.outcome.exitCode)} / {run.outcome.signal ?? '—'}</dd></>}
        {evidence?.output && <><dt>stdout / stderr SHA-256</dt><dd>{evidence.output.stdout.hash} / {evidence.output.stderr.hash}</dd></>}
      </dl>
      <p>{t((evidence?.confinement ?? run.backend.confinement) === 'host-process' ? 'verification.hostHint' : 'verification.evidenceHint')}</p>
      {run.purpose === 'freshness' && <p>{t('verification.captureOnly')}</p>}
      <Button disabled={operation.busy} onClick={() => { void action('refresh') }}>{t('verification.observe')}</Button>
      {run.status === 'passed' && <Button disabled={operation.busy} onClick={() => { void action('freshness') }}>{t('verification.freshness')}</Button>}
      {!run.quiescent && <><label>{t('verification.reason')}<input value={run.cancel?.reason ?? reason} disabled={!!run.cancel} maxLength={2000} onChange={event => setReason(event.target.value)} /></label>
        <Button disabled={operation.busy || !(run.cancel?.reason ?? reason).trim()} onClick={() => { void action('cancel') }}>{t('verification.cancel')}</Button>
        {run.status === 'unknown' && run.backend.kind === 'local' && <><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('verification.confirmStopped')}</label>
          <Button disabled={operation.busy || !reason.trim() || !confirmed} onClick={() => { void action('reconcile') }}>{t('verification.reconcile')}</Button></>}
      </>}
      <CheckOutput run={run} />
    </>}
  </article>
}
function CheckOutput({ run }: { run: CheckRun }) {
  const { t } = usePanel(), [stream, setStream] = useState<'stdout' | 'stderr'>('stdout')
  return <details><summary>{t('verification.output')}</summary>
    <label>{t('verification.stream')}<select value={stream} onChange={event => setStream(event.target.value as typeof stream)}><option>stdout</option><option>stderr</option></select></label>
    <OutputWindow key={`${run.id}:${stream}`} id={run.id} stream={stream} />
  </details>
}
function OutputWindow({ id, stream }: { id: string; stream: 'stdout' | 'stderr' }) {
  const { call, t } = usePanel(), [offset, setOffset] = useState(0)
  const output = usePoll(() => call('GET verification/:id/output', { id, query: { stream, offset, limit: 16000 } }), [call, id, stream, offset])
  const value = output.data
  return <>{output.error && <p role="alert">{output.error.message}</p>}{value && <>
    {value.gap && <p>{t('verification.gap')}</p>}<p>{value.offset}–{value.nextOffset} / {value.totalBytes} bytes</p>
    <pre className="dt-library-excerpt">{new TextDecoder().decode(Uint8Array.from(atob(value.data), char => char.charCodeAt(0)))}</pre>
    <Button disabled={!offset} onClick={() => setOffset(0)}>{t('verification.startOutput')}</Button>
    <Button disabled={value.nextOffset >= value.totalBytes || value.nextOffset <= offset} onClick={() => setOffset(value.nextOffset)}>{t('mission.next')}</Button>
  </>}</>
}

/** Approval selects an existing host receipt. Commands and success assertions cannot be entered here. */
export function ArtifactCheckPicker({ artifactId, selected, onChange, disabled = false }: {
  artifactId: string; selected: CheckSelection[]; onChange(value: CheckSelection[]): void; disabled?: boolean
}) {
  const { call, t, navigate } = usePanel(), [offset, setOffset] = useState(0)
  const catalog = usePoll(() => call('GET library/:id/review-checks', { id: artifactId, query: { offset } }), [call, artifactId, offset])
  return <fieldset disabled={disabled}>
    <legend>{t('verification.selectEvidence')}</legend><p>{t('verification.approvalHint')}</p>
    {catalog.error && <p role="alert">{catalog.error.message}</p>}
    {catalog.data?.items.length === 0 && <p>{t('verification.noPassed')}</p>}
    {catalog.data?.items.map(({ run, binding }) => <label key={run.id}>
      <input type="checkbox" checked={selected.some(item => item.runId === run.id && item.evidenceHash === binding.selection.evidenceHash)} disabled={!!catalog.error}
        onChange={event => onChange(event.target.checked ? [...selected.filter(item => item.runId !== run.id), binding.selection] : selected.filter(item => item.runId !== run.id))} />
      {run.check.name} · v{run.check.version} · {new Date(binding.checkedAt).toLocaleString()} · {binding.confinement}
      <code>{binding.snapshotHash}</code>
      {binding.repository && <span>Git {binding.repository.commit}</span>}
    </label>)}
    <p>{t('verification.selectedCount', { count: selected.length })}</p>
    <Button onClick={() => navigate({ page: 'library', id: artifactId })}>{t('verification.inspectArtifact')}</Button>
    <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>{t('mission.previous')}</Button>
    <Button disabled={catalog.data?.nextOffset == null} onClick={() => setOffset(catalog.data!.nextOffset!)}>{t('mission.next')}</Button>
  </fieldset>
}

export function EvidenceReviewStatus({ id }: { id: string }) {
  const { call, t } = usePanel(), [runId, setRunId] = useState('')
  const review = usePoll(() => call('GET evidence-reviews/:id', { id }), [call, id])
  return <>{review.error && <p role="alert">{review.error.message}</p>}{review.data && <>
    <p role="status">{t(`verification.review.${review.data.status}`)}</p>{review.data.problem && <p>{review.data.problem}</p>}
    <p>{t('verification.captureOnly')}</p>
    {review.data.attempts.map(attempt => <details key={attempt.id}><summary>{new Date(attempt.at).toLocaleString()}</summary>
      {attempt.captures.map(capture => <Button key={capture.id} onClick={() => setRunId(capture.id)}>{capture.id}</Button>)}
    </details>)}
    {runId && <VerificationRun key={runId} id={runId} onSelect={setRunId} onChanged={review.reload} />}
  </>}</>
}
