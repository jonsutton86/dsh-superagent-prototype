import { useRef, useState } from 'react'
import type { MissionView } from '../workspace/model.ts'
import type { ConfigureDelivery } from '../publication/channels.ts'
import { ApiError, usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { destinationLabel } from './destinations.ts'
import { errorText } from './text.ts'

/** Operator consent for future task replies under the current mission plan, with original-intent recovery after ambiguity. */
export function MissionDeliveryCard({ mission }: { mission: MissionView }) {
  const { call, t } = usePanel()
  const catalog = usePoll(() => call('GET publication/destinations'), [call])
  const delivery = usePoll(() => call('GET missions/:id/delivery', { id: mission.id }), [call, mission.id])
  const [destinationId, setDestination] = useState(''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), pending = useRef<{ key: string; body: ConfigureDelivery }>()
  const destination = catalog.data?.items.find(item => item.id === destinationId), grant = delivery.data?.grant
  const activeWork = mission.actions.some(action => action.ticket?.stoppable)
  const run = async (operation: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(errorText(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const configure = (enabled: boolean) => run(async () => {
    if (!delivery.data || enabled && (!destination || !consent || activeWork || mission.status !== 'active')) return
    const identity = { enabled, destination: enabled ? destination!.id : undefined, destinationHash: enabled ? destination!.hash : undefined }, key = JSON.stringify(identity)
    if (pending.current?.key !== key) pending.current = { key, body: { ...identity, requestId: crypto.randomUUID(), revision: grant?.revision ?? 0, missionRevision: mission.revision } }
    try { await call('PUT missions/:id/delivery', { id: mission.id, body: pending.current.body }) }
    catch (failure) {
      if (failure instanceof ApiError && !failure.details.unreachable && failure.status >= 400 && failure.status < 500) {
        pending.current = undefined; setConsent(false); await delivery.reload()
      }
      throw failure
    }
    pending.current = undefined; setConsent(false); await delivery.reload()
  })
  if (catalog.data?.configured === false && !grant && !delivery.data?.items.length) return null
  return <section aria-label={t('delivery.title')} className="dt-mission-criteria">
    <h3>{t('delivery.title')}</h3>
    {(error || delivery.error || catalog.error) && <p role="alert" className="dt-error">{error || delivery.error?.message || catalog.error?.message}</p>}
    {grant && <p role="status">{t(delivery.data?.current ? 'delivery.active' : grant.enabled && !grant.revokedAt ? 'delivery.stale' : 'delivery.off')}
      {grant.destination && <> · {grant.destination.name} · {destinationLabel(grant.destination)}</>}</p>}
    {catalog.data?.configured && <details>
      <summary>{t('delivery.configure')}</summary>
      <p>{t('delivery.consentHint')}</p>
      {activeWork && <p>{t('delivery.activeWork')}</p>}
      <label>{t('publication.destination')}<select value={destinationId} disabled={busy || activeWork} onChange={event => { setDestination(event.target.value); setConsent(false) }}>
        <option value="">{t('publication.select')}</option>
        {catalog.data.items.map(item => <option key={item.id} value={item.id}>{item.name} — {destinationLabel(item)}</option>)}
      </select></label>
      <label><input type="checkbox" checked={consent} disabled={busy || !destination || activeWork || mission.status !== 'active'}
        onChange={event => setConsent(event.target.checked)} />{t('delivery.consent')}</label>
      <Button disabled={busy || !consent || !destination || activeWork || mission.status !== 'active'} onClick={() => { void configure(true) }}>{t('delivery.enable')}</Button>
    </details>}
    {grant?.enabled && !grant.revokedAt && <Button disabled={busy} onClick={() => { void configure(false) }}>{t('delivery.disable')}</Button>}
    {delivery.data?.items.map(item => <article key={item.id} className="dt-mission-card">
      <strong>{item.destination}</strong><p role="status">{t(`publication.phase.${item.receipt?.phase ?? item.phase}`)}</p>
      {item.withdrawn && <p>{t('delivery.withdrawn')}</p>}{item.problem && <p>{item.problem}</p>}
      {item.receipt?.external && <a href={item.receipt.external.url} target="_blank" rel="noreferrer">{t('publication.open')}</a>}
      {!['sent', 'failed', 'cancelled', 'not_delivered'].includes(item.receipt?.phase ?? '') && <div className="dt-mission-buttons">
        <Button disabled={busy} onClick={() => { void run(async () => { await call('POST deliveries/:id/refresh', { id: item.id }); await delivery.reload() }) }}>{t('publication.observe')}</Button>
        <Button disabled={busy || item.withdrawn || !delivery.data?.current || item.grantId !== grant?.id}
          onClick={() => { void run(async () => { await call('POST deliveries/:id/retry', { id: item.id }); await delivery.reload() }) }}>{t('publication.retry')}</Button>
      </div>}
    </article>)}
  </section>
}
