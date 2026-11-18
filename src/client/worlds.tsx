import { useState, type FormEvent } from 'react'
import type { WorldView } from '../environments/pool-model.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { useOperatorCommand } from './operator-command.ts'
import { ExecutionReceipts } from './execution-receipts.tsx'

function CommandError({ command }: { command: ReturnType<typeof useOperatorCommand> }) {
  const { t } = usePanel()
  return command.error ? <p role="alert" className="dt-error">{command.error}{command.retry && <Button disabled={command.busy}
    onClick={() => { void command.retry?.() }}>{t('environment.retry')}</Button>}</p> : null
}
function Pages({ offset, next, change }: { offset: number; next?: number | null; change(value: number): void }) {
  const { t } = usePanel()
  return <div className="dt-mission-buttons"><Button disabled={!offset} onClick={() => change(Math.max(0, offset - 100))}>{t('mission.previous')}</Button>
    <Button disabled={next == null} onClick={() => next != null && change(next)}>{t('mission.next')}</Button></div>
}
/** Select the exact activated authority; edits and catalog refreshes cannot migrate an action to a new grant generation. */
export function WorldSelector({ value, change }: { value?: string; change(value: string | undefined): void }) {
  const { call, t } = usePanel(), [offset, setOffset] = useState(0)
  const { data, error } = usePoll(() => call('GET worlds', { query: { offset } }), [call, offset])
  return <div><label>{t('world.select')}<select value={value ?? ''} onChange={event => change(event.target.value || undefined)}>
    <option value="">{t('world.default')}</option>
    {value && !data?.items.some(item => item.id === value) && <option value={value}>{value}</option>}
    {data?.items.map(item => <option key={item.id} value={item.id} disabled={!item.ready}>{item.name} · {item.epoch} · {t(item.ready ? 'world.ready' : 'world.unavailable')}</option>)}
  </select></label><p className="dt-hint">{t('world.pinHint')}</p>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {!!(offset || data?.nextOffset) && <Pages offset={offset} next={data?.nextOffset} change={setOffset} />}
  </div>
}
export function ActivateWorldForm({ endpointId, commandId, name }: { endpointId: string; commandId: string; name: string }) {
  const { call, t } = usePanel(), [activated, setActivated] = useState<WorldView>()
  const [repositoryEnabled, setRepositoryEnabled] = useState(false)
  const command = useOperatorCommand(() => {})
  const activate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget), name = String(form.get('name'))
    const credentialId = String(form.get('repositoryCredential') ?? '').trim()
    const repository = repositoryEnabled ? { url: String(form.get('repositoryUrl')).trim(), commit: String(form.get('repositoryCommit')).trim(),
      username: String(form.get('repositoryUsername') || 'x-access-token').trim(), ...(credentialId ? { credentialId } : {}) } : undefined
    const body = { endpointId, commandId, name, ...(repository ? { repository } : {}) }
    void command.run(body, async requestId => setActivated(await call('POST worlds', { body: { requestId, ...body } })))
  }
  return <form className="dt-mission-form" onSubmit={activate}><p className="dt-hint">{t('world.activateHint')}</p>
    <label>{t('world.name')}<input name="name" required maxLength={160} defaultValue={name} /></label>
    <label><input type="checkbox" checked={repositoryEnabled} onChange={event => setRepositoryEnabled(event.target.checked)} />{t('world.repository')}</label>
    {repositoryEnabled && <fieldset><legend>{t('world.repository')}</legend><p className="dt-hint">{t('world.repositoryHint')}</p>
      <label>{t('world.repositoryUrl')}<input name="repositoryUrl" type="url" required maxLength={2048} /></label>
      <label>{t('world.repositoryCommit')}<input name="repositoryCommit" required pattern="([a-f0-9]{40}|[a-f0-9]{64})" maxLength={64} /></label>
      <label>{t('world.repositoryCredential')}<input name="repositoryCredential" maxLength={100} /></label>
      <label>{t('world.repositoryUsername')}<input name="repositoryUsername" defaultValue="x-access-token" maxLength={100} /></label>
    </fieldset>}
    <Button type="submit" disabled={command.busy}>{t('world.activate')}</Button><CommandError command={command} />
    {activated && <p role="status">{t(activated.ready ? 'world.ready' : 'world.unavailable')} · <code>{activated.id}</code>{activated.problem && ` · ${activated.problem}`}</p>}
  </form>
}
function WorldCard({ world, changed }: { world: WorldView; changed(): void }) {
  const { call, t } = usePanel(), command = useOperatorCommand(changed), [reason, setReason] = useState(''), [receipts, setReceipts] = useState(false)
  const revoke = (event: FormEvent) => {
    event.preventDefault(); const body = { revision: world.revision, reason }
    void command.run(body, requestId => call('POST worlds/:id/revoke', { id: world.id, body: { ...body, requestId } }))
  }
  return <article className="dt-mission-card"><h4>{world.name}</h4><p>{t(world.ready ? 'world.ready' : world.enabled ? 'world.unavailable' : 'environment.revoked')}</p>
    <p><code>{world.root}</code> · {t('environment.grant', { revision: world.revision, epoch: world.epoch })}</p><p><code>{world.id}</code></p>
    {world.repository && <p>{t('world.repository')} · <code>{world.repository.url}</code><br /><code>{world.repository.commit}</code></p>}
    {world.problem && <p role="status" className="dt-error">{world.problem}</p>}
    {world.status?.revocation && <p>{t(world.status.revocation.quiescent ? 'execution.stopped' : 'world.revocationPending')}</p>}
    <Button disabled={command.busy} onClick={() => { void command.run({ refresh: world.id }, () => call('POST worlds/:id/refresh', { id: world.id })) }}>{t('world.refresh')}</Button>
    {world.enabled && <form className="dt-mission-form" onSubmit={revoke}><p className="dt-hint">{t('world.revokeHint')}</p>
      <label>{t('environment.reason')}<textarea rows={2} required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <Button type="submit" disabled={command.busy || !reason.trim()}>{t('world.revoke')}</Button></form>}
    <CommandError command={command} /><Button aria-expanded={receipts} onClick={() => setReceipts(!receipts)}>{t('execution.title')}</Button>
    {receipts && <ExecutionReceipts worldId={world.id} />}
  </article>
}
/** Lifecycle and owned-receipt controls for all managed worlds under this coordinator. */
export function WorldPoolPanel() {
  const { call, t } = usePanel(), [offset, setOffset] = useState(0)
  const { data, error, reload } = usePoll(() => call('GET worlds', { query: { offset } }), [call, offset])
  return <section><h3>{t('world.title')}</h3><p>{t('world.intro')}</p>
    <Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {data?.items.map(world => <WorldCard key={world.id} world={world} changed={() => { void reload() }} />)}
    {!!(offset || data?.nextOffset) && <Pages offset={offset} next={data?.nextOffset} change={setOffset} />}
  </section>
}
