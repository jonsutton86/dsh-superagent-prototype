import { useState, type FormEvent } from 'react'
import type { EndpointAction, EndpointCatalog, EndpointRegistration, OperatorCommand, RemoteProfileView } from '../environments/endpoint-model.ts'
import type { EndpointCredential, RemoteGrant } from '../remote/protocol.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { useOperatorCommand } from './operator-command.ts'
import { When } from './widgets.tsx'
import { ActivateWorldForm } from './worlds.tsx'

type Action = EndpointAction extends infer A ? A extends EndpointAction ? Omit<A, 'requestId'> : never : never
type Submit = (action: Action) => void
const form = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); return new FormData(event.currentTarget) }
const field = (data: FormData, key: string) => String(data.get(key) ?? '')
const bindings = (data: FormData) => data.getAll('credentials').map(value => { const [id, version] = String(value).split(':'); return { id: id!, version: version! } })

function Pages({ offset, next, change }: { offset: number; next: number | null | undefined; change: (offset: number) => void }) {
  const { t } = usePanel()
  return <div className="dt-mission-buttons"><Button disabled={!offset} onClick={() => change(Math.max(0, offset - 100))}>{t('mission.previous')}</Button>
    <Button disabled={next == null} onClick={() => next != null && change(next)}>{t('mission.next')}</Button></div>
}
function CommandError({ command }: { command: ReturnType<typeof useOperatorCommand> }) {
  const { t } = usePanel()
  return command.error ? <p role="alert" className="dt-error">{command.error}
    {command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('environment.retry')}</Button>}</p> : null
}
function RegistrationForm({ record, changed }: { record?: EndpointRegistration; changed: () => void }) {
  const { call, t } = usePanel(), command = useOperatorCommand(changed)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event), body = { name: field(data, 'name'), url: field(data, 'url'), endpointId: record?.id ?? field(data, 'endpointId'),
      credentialFile: field(data, 'credentialFile'), revision: record?.revision ?? 0 }
    void command.run(body, requestId => call('POST endpoints', { body: { ...body, requestId } }))
  }
  return <details><summary>{t(record ? 'endpoint.edit' : 'endpoint.register')}</summary>
    <form className="dt-mission-form" onSubmit={submit}>
      <label>{t('endpoint.name')}<input name="name" defaultValue={record?.name} required maxLength={160} /></label>
      {!record && <label>{t('endpoint.identity')}<input name="endpointId" required /></label>}
      <label>{t('endpoint.url')}<input name="url" defaultValue={record?.url} type="url" required /></label>
      <label>{t('endpoint.adminFile')}<input name="credentialFile" defaultValue={record?.credentialFile} required /></label>
      <p className="dt-hint">{t('endpoint.privateFile')}</p>
      <Button type="submit" disabled={command.busy}>{t(record ? 'endpoint.save' : 'endpoint.register')}</Button>
      <CommandError command={command} />
    </form>
  </details>
}

/** Operator endpoint controls are independent of model tools and the currently running Session's execution grant. */
export function EndpointManagement() {
  const { call, t } = usePanel(), [offset, setOffset] = useState(0)
  const { data, error, reload } = usePoll(() => call('GET endpoints', { query: { offset } }), [call, offset])
  return <section>
    <h3>{t('endpoint.title')}</h3><p>{t('endpoint.intro')}</p>
    <RegistrationForm changed={() => { void reload() }} />
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {data?.items.map(record => <EndpointCard key={`${record.id}:${record.revision}`} record={record} changed={() => { void reload() }} />)}
    {!!(offset || data?.nextOffset) && <Pages offset={offset} next={data?.nextOffset} change={setOffset} />}
  </section>
}
function EndpointCard({ record, changed }: { record: EndpointRegistration; changed: () => void }) {
  const { t } = usePanel(), [open, setOpen] = useState(false)
  return <article className="dt-mission-card">
    <h4>{record.name}</h4><p><code>{record.url}</code> · <code>{record.id}</code></p>
    <p>{record.identity.confinement} · {t('endpoint.revision', { revision: record.revision })}</p>
    <RegistrationForm record={record} changed={changed} />
    <Button aria-expanded={open} onClick={() => setOpen(!open)}>{t(open ? 'endpoint.close' : 'endpoint.manage')}</Button>
    {open && <EndpointDetails record={record} />}
  </article>
}
function CredentialSelection({ credentials }: { credentials: EndpointCredential[] }) {
  const { t } = usePanel()
  return <fieldset><legend>{t('environment.credentials')}</legend><p className="dt-hint">{t('environment.credentialBoundary')}</p>
    {credentials.filter(item => item.enabled).map(item => <label key={item.id}><input type="checkbox" name="credentials" value={`${item.id}:${item.version}`} />
      {item.id} · {item.variable} · <code>{item.version}</code></label>)}
  </fieldset>
}
function GrantForm({ grant, credentials, submit, busy }: { grant?: RemoteGrant; credentials: EndpointCredential[]; submit: Submit; busy: boolean }) {
  const { t } = usePanel(), [replace, setReplace] = useState(false)
  const send = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event), leaseMs = Number(data.get('leaseMs')), credentials = bindings(data)
    const enabled = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'enable'
    if (grant) submit({ op: 'grant.change', id: grant.id, revision: grant.revision, enabled,
      leaseMs, reason: field(data, 'reason'), ...(replace && enabled ? { credentials } : {}) })
    else submit({ op: 'grant.create', owner: field(data, 'owner'), workspace: field(data, 'workspace'), leaseMs, credentials,
      operations: data.getAll('operations') as RemoteGrant['operations'] })
  }
  return <details><summary>{t(grant ? 'endpoint.changeGrant' : 'endpoint.createGrant')}</summary><form className="dt-mission-form" onSubmit={send}>
    {!grant && <><label>{t('endpoint.owner')}<input name="owner" defaultValue="coordinator" required pattern="[a-zA-Z0-9_-]{1,100}" /></label>
      <label>{t('endpoint.workspace')}<input name="workspace" required pattern="[a-zA-Z0-9_-]{1,100}" /></label>
      <fieldset><legend>{t('endpoint.permissions')}</legend>{(['fs.read', 'fs.write', 'process.spawn', 'network'] as const).map(op =>
        <label key={op}><input type="checkbox" name="operations" value={op} defaultChecked={op !== 'network'} />{op}</label>)}</fieldset></>}
    <label>{t('endpoint.lease')}<input type="number" name="leaseMs" min={1000} max={300000} defaultValue={300000} required /></label>
    {grant && <><p>{t('endpoint.generationHint')}</p>
      <label>{t('environment.reason')}<textarea name="reason" required maxLength={2000} rows={2} /></label>
      <label><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />{t('endpoint.replaceBindings')}</label></>}
    {(!grant || replace) && <CredentialSelection credentials={credentials} />}
    <Button type="submit" value="enable" disabled={busy}>{t(grant ? 'endpoint.authorize' : 'endpoint.createGrant')}</Button>
    {grant?.enabled && <Button type="submit" value="revoke" disabled={busy}>{t('endpoint.revokeGrant')}</Button>}
  </form></details>
}
function CredentialForm({ credential, submit, busy }: { credential?: EndpointCredential; submit: Submit; busy: boolean }) {
  const { t } = usePanel()
  const send = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event), reason = field(data, 'reason')
    if ((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'revoke' && credential)
      submit({ op: 'credential.revoke', id: credential.id, revision: credential.revision, reason })
    else submit({ op: 'credential.import', id: credential?.id ?? field(data, 'id'), revision: credential?.revision ?? 0, reason,
      file: field(data, 'file'), variable: field(data, 'variable'), mode: field(data, 'mode') as 'env' | 'file' })
  }
  return <details><summary>{t(credential ? 'endpoint.changeCredential' : 'endpoint.importCredential')}</summary>
    <form className="dt-mission-form" onSubmit={send}>
      {!credential && <label>{t('endpoint.credentialId')}<input name="id" required pattern="[a-zA-Z0-9_-]{1,100}" /></label>}
      <label>{t('endpoint.importFile')}<input name="file" pattern="[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}" /></label>
      <label>{t('endpoint.variable')}<input name="variable" defaultValue={credential?.variable} pattern="[A-Z][A-Z0-9_]{0,99}" /></label>
      <label>{t('endpoint.mode')}<select name="mode" defaultValue={credential?.mode ?? 'env'}><option value="env">{t('environment.credentialEnv')}</option>
        <option value="file">{t('environment.credentialFile')}</option></select></label>
      <label>{t('environment.reason')}<textarea name="reason" required maxLength={2000} rows={2} /></label>
      <p className="dt-hint">{t('endpoint.importHint')}</p>
      <Button type="submit" value="import" disabled={busy}>{t(credential ? 'endpoint.rotateCredential' : 'endpoint.importCredential')}</Button>
      {credential?.enabled && <Button type="submit" value="revoke" disabled={busy}>{t('endpoint.revokeCredential')}</Button>}
    </form>
  </details>
}
function Reconcile({ id, kind, submit, busy }: { id: string; kind: 'job' | 'operation'; submit: Submit; busy: boolean }) {
  const { t } = usePanel(), [confirmed, setConfirmed] = useState(false)
  const send = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event); if (!confirmed) return
    submit(kind === 'job' ? { op: 'job.reconcile', id, note: field(data, 'note'), quiescent: true } : { op: 'operation.reconcile', id, note: field(data, 'note') })
  }
  return <details><summary>{t('endpoint.reconcile')}</summary><form className="dt-mission-form" onSubmit={send}>
    <p>{t('endpoint.reconcileHint')}</p><label>{t('endpoint.evidence')}<textarea name="note" required maxLength={2000} rows={2} /></label>
    <label><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('endpoint.quiescence')}</label>
    <Button type="submit" disabled={busy || !confirmed}>{t('endpoint.reconcile')}</Button>
  </form></details>
}
function Catalog({ data, submit, busy }: { data: EndpointCatalog; submit: Submit; busy: boolean }) {
  const { t } = usePanel()
  return <>
    <h4>{t('endpoint.grants')}</h4><GrantForm credentials={data.credentials.items} submit={submit} busy={busy} />
    {data.grants.items.map(grant => <article className="dt-mission-card" key={`${grant.id}:${grant.revision}`}>
      <h4>{grant.workspace} · {grant.owner}</h4><p><code>{grant.id}</code> · {t('environment.grant', { revision: grant.revision, epoch: grant.epoch })}</p>
      <p>{t(grant.enabled ? 'environment.enabled' : 'environment.revoked')} · {t('endpoint.expires')}: <When at={new Date(grant.leaseUntil).toISOString()} /></p>
      <p><code>{grant.root}</code> · {grant.operations.join(', ')}</p>
      {!!grant.credentials?.length && <ul>{grant.credentials.map(binding => <li key={binding.id}>{binding.id} · {binding.variable} · <code>{binding.version}</code></li>)}</ul>}
      <GrantForm grant={grant} credentials={data.credentials.items} submit={submit} busy={busy} />
    </article>)}
    <h4>{t('environment.credentials')}</h4><CredentialForm submit={submit} busy={busy} />
    {data.credentials.items.map(credential => <article className="dt-mission-card" key={`${credential.id}:${credential.revision}`}>
      <p>{credential.id} · {credential.variable} · <code>{credential.version}</code> · {t(credential.enabled ? 'environment.enabled' : 'environment.revoked')}</p>
      <CredentialForm credential={credential} submit={submit} busy={busy} />
    </article>)}
    <h4>{t('endpoint.effects')}</h4>
    {data.jobs.items.map(job => <article className="dt-mission-card" key={job.id}><p><code>{job.id}</code> · {job.phase} · {job.grantId} / {job.epoch}</p>
      <p>{t(job.quiescent ? 'execution.stopped' : 'execution.active')}</p>
      {!job.quiescent && <Button disabled={busy} onClick={() => submit({ op: 'job.cancel', id: job.id })}>{t('execution.cancel')}</Button>}
      {job.phase === 'unknown' && !job.reconciled && <Reconcile kind="job" id={job.id} submit={submit} busy={busy} />}
      {job.reconciled && <p>{job.reconciled.note}</p>}
    </article>)}
    {data.operations.items.map(operation => <article className="dt-mission-card" key={operation.id}><p><code>{operation.id}</code> · {operation.kind} · {operation.phase}</p>
      {operation.phase === 'unknown' && !operation.reconciled && <Reconcile kind="operation" id={operation.id} submit={submit} busy={busy} />}
      {operation.reconciled && <p>{operation.reconciled.note}</p>}
    </article>)}
  </>
}
function AdministrationReceipt({ record, endpoint, changed }: { record: OperatorCommand; endpoint: string; changed: () => void }) {
  const { call, t } = usePanel(), command = useOperatorCommand(changed), [profile, setProfile] = useState<RemoteProfileView>()
  const generate = (event: FormEvent<HTMLFormElement>) => {
    const data = form(event), port = Number(data.get('port'))
    void command.run({ profile: record.id, port }, async () => setProfile(await call('POST endpoints/:id/commands/:command/profile', { id: endpoint, command: record.id, body: { port } })))
  }
  return <article className="dt-mission-card">
    <p>{record.request.op} · <code>{record.id}</code> · {t(`endpoint.phase.${record.phase}`)}</p>
    <details><summary>{t('endpoint.inspectRequest')}</summary><pre>{JSON.stringify(record.request, null, 2)}</pre></details>
    {record.result?.grant && <p>{t('execution.grant')}: <code>{record.result.grant.id}</code> / {record.result.grant.epoch}</p>}
    {record.problem && <p role="status">{record.problem}</p>}
    {(record.phase === 'pending' || record.phase === 'unknown') && <Button disabled={command.busy} onClick={() => {
      void command.run(record.id, () => call('POST endpoints/:id/commands/:command/retry', { id: endpoint, command: record.id }))
    }}>{t('endpoint.retry')}</Button>}
    {record.phase === 'done' && record.result?.grant?.enabled && <form className="dt-mission-form" onSubmit={generate}>
      <label>{t('endpoint.port')}<input type="number" name="port" defaultValue={3084} required min={1024} max={65535} /></label>
      <Button type="submit" disabled={command.busy}>{t('endpoint.profile')}</Button>
    </form>}
    {record.phase === 'done' && record.result?.grant?.enabled && <ActivateWorldForm endpointId={endpoint} commandId={record.id} name={record.result.grant.workspace} />}
    <CommandError command={command} />
    {profile && <div role="status"><p>{t('endpoint.profileHint')}</p><p><code>{profile.patchFile}</code></p>
      <p>{t('endpoint.profileStart')}</p><pre>{`dsh --profile YOUR_DEDICATED_PROFILE --patch '${profile.patchFile.replaceAll("'", "'\\''")}' --no-open`}</pre>
      <details><summary>{t('endpoint.profileInspect')}</summary><pre>{JSON.stringify(profile.patch, null, 2)}</pre></details>
    </div>}
  </article>
}
function EndpointDetails({ record }: { record: EndpointRegistration }) {
  const { call, t } = usePanel(), [offset, setOffset] = useState(0), [commandOffset, setCommandOffset] = useState(0)
  const catalog = usePoll(() => call('GET endpoints/:id/catalog', { id: record.id, query: { offset } }), [call, record.id, offset])
  const receipts = usePoll(() => call('GET endpoints/:id/commands', { id: record.id, query: { offset: commandOffset } }), [call, record.id, commandOffset])
  const changed = () => { void catalog.reload(); void receipts.reload() }, command = useOperatorCommand(changed)
  const submit: Submit = action => { void command.run(action, requestId => call('POST endpoints/:id/commands', {
    id: record.id, body: { revision: record.revision, request: { ...action, requestId } } })) }
  const next = catalog.data && Object.values(catalog.data).some(page => page.nextOffset !== null) ? offset + 100 : null
  return <div>
    <Button onClick={changed}>{t('mission.refresh')}</Button>
    {(catalog.error || receipts.error) && <p role="alert" className="dt-error">{catalog.error?.message || receipts.error?.message}</p>}
    <CommandError command={command} />
    {catalog.data && <Catalog data={catalog.data} submit={submit} busy={command.busy} />}
    {!!(offset || next) && <Pages offset={offset} next={next} change={setOffset} />}
    <h4>{t('endpoint.requests')}</h4><p className="dt-hint">{t('endpoint.requestsHint')}</p>
    {receipts.data?.items.map(item => <AdministrationReceipt key={item.id} record={item} endpoint={record.id} changed={changed} />)}
    {!!(commandOffset || receipts.data?.nextOffset) && <Pages offset={commandOffset} next={receipts.data?.nextOffset} change={setCommandOffset} />}
  </div>
}
