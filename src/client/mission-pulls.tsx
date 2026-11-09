import { useRef, useState } from 'react'
import type { ActionView, MissionView } from '../workspace/model.ts'
import type { ConfigureMissionPull } from '../workspace/pull-model.ts'
import type { PullObservation } from '../publication/pull-model.ts'
import { usePanel } from './provider.tsx'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { destinationLabel } from './destinations.ts'
import { errorText } from './text.ts'

export function MissionPullCard({ mission, action, changed }: { mission: MissionView; action: ActionView; changed(value: MissionView): void }) {
  const { call, t } = usePanel(), [editing, setEditing] = useState(false), [destinationId, setDestination] = useState('')
  const [observation, setObservation] = useState<PullObservation>(), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), pending = useRef<{ key: string; body: ConfigureMissionPull }>()
  const catalog = usePoll(() => editing ? call('GET publication/destinations') : Promise.resolve({ configured: false, items: [] }), [call, editing])
  const destination = catalog.data?.items.find(item => item.id === destinationId && item.kind === 'github-pr-review'), state = action.pullState
  const mutable = mission.status === 'active' && !action.ticket?.stoppable
  const run = async (operation: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(errorText(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const configure = (enabled: boolean) => run(async () => {
    if (enabled && pending.current?.body.enabled && action.pull === pending.current.body.requestId) { pending.current = undefined; setEditing(false); setConsent(false); return }
    if (enabled && (!destination || !observation || !consent || observation.destinationHash !== destination.hash)) return
    const fields = { revision: mission.revision, ...(enabled ? { enabled: true as const, destination: destination!.id, destinationHash: destination!.hash, pullHash: observation!.hash } : { enabled: false as const }) }
    const key = JSON.stringify(fields)
    if (pending.current?.key !== key) pending.current = { key, body: { ...fields, requestId: crypto.randomUUID() } }
    changed(await call('PUT missions/:id/actions/:action/pull', { id: mission.id, action: action.id, body: pending.current.body }))
    pending.current = undefined; setEditing(false); setConsent(false)
  })
  if (action.owner !== 'agent') return null
  return <section aria-label={t('missionPull.title')}>
    {(error || catalog.error) && <p role="alert">{error || catalog.error?.message}</p>}
    {state && <><h4>{t('missionPull.title')}</h4><p>{state.target.name} · {state.target.initial.binding.base.repository.name} #{state.target.initial.binding.number}</p>
      <p>{t('missionPull.required')}</p>{state.observation && <MissionPullObservation observation={state.observation} />}
      {state.problem && <p role="status">{state.problem}</p>}
      <Button disabled={busy} onClick={() => { void run(async () => { await call('POST missions/:id/actions/:action/pull/inspect', { id: mission.id, action: action.id }); changed(await call('GET missions/:id', { id: mission.id })) }) }}>{t('missionPull.refresh')}</Button></>}
    {mutable && <Button disabled={busy} onClick={() => setEditing(!editing)}>{t('missionPull.configure')}</Button>}
    {editing && mutable && <><p>{t('missionPull.configureHint')}</p>
      <label>{t('publication.destination')}<select value={destinationId} disabled={busy} onChange={event => { setDestination(event.target.value); setConsent(false); setObservation(undefined) }}>
        <option value="">{t('publication.select')}</option>{catalog.data?.items.filter(item => item.kind === 'github-pr-review').map(item =>
          <option key={item.id} value={item.id}>{item.name} — {destinationLabel(item)}</option>)}
      </select></label>
      <Button disabled={busy || !destination} onClick={() => { void run(async () => { setConsent(false); setObservation(undefined)
        setObservation(await call('GET publication/destinations/:id/pull', { id: destination!.id, query: { hash: destination!.hash } })) }) }}>{t('publication.inspectPull')}</Button>
      {observation && <MissionPullObservation observation={observation} />}
      <label><input type="checkbox" checked={consent} disabled={busy || !observation || !destination || observation.destinationHash !== destination.hash}
        onChange={event => setConsent(event.target.checked)} />{t('missionPull.consent')}</label>
      <Button disabled={busy || !consent || !observation || !destination} onClick={() => { void configure(true) }}>{t('missionPull.bind')}</Button>
      {state && <Button disabled={busy} onClick={() => { void configure(false) }}>{t('missionPull.remove')}</Button>}
    </>}
  </section>
}

export function MissionPullObservation({ observation }: { observation: PullObservation }) {
  const { t } = usePanel(), { head, base } = observation.binding
  return <dl><dt>{t('publication.pullHead')}</dt><dd>{head.repository.name}:{head.ref}<code>{head.sha}</code></dd>
    <dt>{t('publication.pullTree')}</dt><dd>{head.tree}</dd><dt>{t('publication.pullBase')}</dt><dd>{base.repository.name}:{base.ref}<code>{base.sha}</code></dd>
    <dt>{t('publication.pullObserved')}</dt><dd>{new Date(observation.observedAt).toLocaleString()} · {observation.binding.state}{observation.binding.merged ? ' · merged' : ''}</dd></dl>
}

export function MissionPullReference({ id }: { id: string }) {
  const { call, t } = usePanel(), state = usePoll(() => call('GET mission-pull-targets/:id', { id }), [call, id])
  const target = state.data?.target, pull = target?.initial.binding
  return <div><strong>{t('missionPull.title')}</strong>{state.error && <p role="alert">{state.error.message}</p>}
    {pull && <p>{target!.name} · {pull.base.repository.name} #{pull.number} · {pull.head.repository.name}:{pull.head.ref} → {pull.base.ref}</p>}
    <code>{id}</code><p>{t('missionPull.required')}</p></div>
}
