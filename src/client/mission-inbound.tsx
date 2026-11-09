import { useRef, useState } from 'react'
import type { MissionView } from '../workspace/model.ts'
import type { ConfigureInbound } from '../publication/inbound.ts'
import type { Api } from '../app/api.ts'
import { ApiError, usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'

/** Explicit participant and task selection, with durable-intent retry after an ambiguous listener save. */
export function MissionInboundCard({ mission, delivery }: { mission: MissionView; delivery?: Api['GET missions/:id/delivery']['response'] }) {
  const { call, t } = usePanel()
  const inbound = usePoll(() => call('GET missions/:id/inbound', { id: mission.id }), [call, mission.id])
  const [ticketId, setTicket] = useState(''), [participants, setParticipants] = useState(''), [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), pending = useRef<{ key: string; body: ConfigureInbound }>()
  const binding = inbound.data?.binding, grant = delivery?.grant
  const choices = mission.actions.filter(action => action.ticket?.currentDefinition && action.status !== 'stopped')
  const senders = [...new Set(participants.split(/[\s,]+/).filter(Boolean))]
  const eligible = delivery?.current && grant && choices.some(action => action.ticket?.id === ticketId) && senders.length > 0
  const run = async (operation: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await operation() } catch (failure) { setError(errorText(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const configure = (enabled: boolean) => run(async () => {
    if (!inbound.data || enabled && (!eligible || !consent)) return
    const identity = { enabled, ...(enabled ? { ticketId, senders, grantId: grant!.id } : { senders: [] }) }, key = JSON.stringify(identity)
    if (pending.current?.key !== key) pending.current = { key, body: { ...identity, requestId: crypto.randomUUID(), revision: binding?.revision ?? 0 } }
    try { await call('PUT missions/:id/inbound', { id: mission.id, body: pending.current.body }) }
    catch (failure) {
      if (failure instanceof ApiError && !failure.details.unreachable && failure.status >= 400 && failure.status < 500) {
        pending.current = undefined; setConsent(false); await inbound.reload()
      }
      throw failure
    }
    pending.current = undefined; setConsent(false); await inbound.reload()
  })
  if (inbound.data?.configured === false && !binding) return null
  return <section aria-label={t('inbound.title')}>
    <h4>{t('inbound.title')}</h4>
    {(error || inbound.error) && <p role="alert" className="dt-error">{error || inbound.error?.message}</p>}
    {binding && <>
      <p role="status">{t(inbound.data?.active ? 'inbound.active' : 'inbound.off')}</p>
      {binding.ticketId && <p>{t('inbound.task')}: {mission.actions.find(action => action.ticket?.id === binding.ticketId)?.title ?? binding.ticketId} · {binding.senders.join(', ')}</p>}
      <p>{t('inbound.starts')}: <time dateTime={binding.startsAt}>{new Date(binding.startsAt).toLocaleString()}</time></p>
      {binding.lastPoll && <p>{t('inbound.lastPoll')}: <time dateTime={binding.lastPoll}>{new Date(binding.lastPoll).toLocaleString()}</time></p>}
      {binding.problem && <p role="alert">{t('inbound.readProblem')}</p>}
    </>}
    {delivery?.current && <details>
      <summary>{t('inbound.configure')}</summary><p>{t('inbound.hint')}</p>
      <label>{t('inbound.task')}<select value={ticketId} disabled={busy} onChange={event => { setTicket(event.target.value); setConsent(false) }}>
        <option value="">{t('inbound.select')}</option>
        {choices.map(action => <option key={action.ticket!.id} value={action.ticket!.id}>{action.title}</option>)}
      </select></label>
      <label>{t('inbound.participants')}<textarea value={participants} disabled={busy} onChange={event => { setParticipants(event.target.value); setConsent(false) }} /></label>
      <p>{t(grant?.destination?.kind === 'feishu-reply' ? 'inbound.feishuIds' : 'inbound.githubIds')}</p>
      <label><input type="checkbox" checked={consent} disabled={busy || !eligible} onChange={event => setConsent(event.target.checked)} />{t('inbound.consent')}</label>
      <Button disabled={busy || !consent || !eligible} onClick={() => { void configure(true) }}>{t('inbound.enable')}</Button>
    </details>}
    {binding?.enabled && !binding.revokedAt && <Button disabled={busy} onClick={() => { void configure(false) }}>{t('inbound.disable')}</Button>}
    {inbound.data?.active && <div className="dt-mission-buttons">
      <Button disabled={busy} onClick={() => { void run(async () => { await call('POST missions/:id/inbound/poll', { id: mission.id, body: {} }); await inbound.reload() }) }}>{t('inbound.poll')}</Button>
      <Button disabled={busy} onClick={() => { void run(async () => { await call('POST missions/:id/inbound/poll', { id: mission.id, body: { rescan: true } }); await inbound.reload() }) }}>{t('inbound.rescan')}</Button>
    </div>}
    {inbound.data?.items.map(item => <article key={item.id} className="dt-mission-card">
      <strong>{item.sender}</strong><p>{t(item.status === 'received' ? 'inbound.received' : 'inbound.unsupported')}</p>
      <a href={item.url} target="_blank" rel="noreferrer">{t('inbound.open')}</a>
    </article>)}
  </section>
}
