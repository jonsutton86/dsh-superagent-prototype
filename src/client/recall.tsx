import { useState, type FormEvent } from 'react'
import type { RecallConfiguration, RecallPolicy } from '../workspace/recall-model.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { useOperatorCommand } from './operator-command.ts'

/** Operator limits and persisted retrieval receipts use the same host service as the model's library tools. */
export function RecallControls() {
  const { call, t, navigate } = usePanel(), [offset, setOffset] = useState(0), [editing, setEditing] = useState<RecallConfiguration>()
  const { data, error, reload } = usePoll(() => call('GET recall', { query: { offset } }), [call, offset])
  return <section className="dt-missions"><h3>{t('recall.title')}</h3><p>{t('recall.intro')}</p>
    {error && <p role="alert">{error.message}</p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <><p>{t('recall.owner')}: {data.configuration.policy.owner.calls} {t('recall.calls')}, {data.configuration.policy.owner.pages} {t('recall.pages')}, {data.configuration.policy.owner.bytes.toLocaleString()} {t('recall.bytes')}</p>
      <p>{t('recall.run')}: {data.configuration.policy.run.pages} {t('recall.pages')}, {data.configuration.policy.run.depth} {t('recall.depth')}, {data.configuration.policy.run.bytes.toLocaleString()} {t('recall.bytes')}</p>
      <Button onClick={() => setEditing(data.configuration)}>{t('recall.edit')}</Button>
      {editing && <RecallForm key={editing.revision} configuration={editing} done={() => { setEditing(undefined); void reload() }} cancel={() => setEditing(undefined)} />}
      <h4>{t('recall.history')}</h4><p>{t('recall.reservationHint')}</p>
      <div className="dt-mission-grid">{data.attempts.map(attempt => <article className="dt-mission-card" key={attempt.id}>
        <p>{t(attempt.owner.role === 'router' ? 'recall.router' : 'recall.worker')} · {t(`recall.phase.${attempt.phase}`)} · <time dateTime={attempt.at}>{new Date(attempt.at).toLocaleString()}</time></p>
        <p>{attempt.charged.pages} {t('recall.pages')} · {attempt.charged.bytes.toLocaleString()} {t('recall.bytes')} · {attempt.charged.nodes} {t('recall.nodes')} · {attempt.charged.millis} {t('recall.millis')}</p>
        {attempt.truncated && <p>{t('recall.truncated')}</p>}
        {attempt.owner.ticketId && <Button onClick={() => navigate({ page: 'execution', id: attempt.owner.ticketId })}>{t('usage.openTask')}</Button>}
      </article>)}</div>
      <div className="dt-mission-buttons">{offset > 0 && <Button onClick={() => setOffset(offset - 30)}>{t('mission.previous')}</Button>}
        {data.nextOffset !== null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}</div></>}
  </section>
}
function RecallForm({ configuration, done, cancel }: { configuration: RecallConfiguration; done: () => void; cancel: () => void }) {
  const { call, t } = usePanel(), command = useOperatorCommand(done)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget), policy = structuredClone(configuration.policy)
    for (const group of ['owner', 'run'] as const) for (const name of Object.keys(policy[group])) (policy[group] as Record<string, number>)[name] = Number(form.get(`${group}.${name}`))
    const body = { revision: configuration.revision, policy }
    void command.run(body, requestId => call('PUT recall', { body: { ...body, requestId } }))
  }
  const maxima: Record<keyof RecallPolicy, Record<string, number>> = { owner: { calls: 10000, pages: 100000, bytes: 64 * 1024 * 1024, nodes: 1000000, millis: 600000 },
    run: { pages: 20, bytes: 256 * 1024, nodes: 4096, millis: 1000, depth: 8 } }
  return <form className="dt-mission-form" onSubmit={submit}>
    {(['owner', 'run'] as const).map(group => <fieldset key={group}><legend>{t(`recall.${group}`)}</legend>
      {Object.entries(configuration.policy[group]).map(([name, value]) => <label key={name}>{t(`recall.${name}` as 'recall.calls')}<input name={`${group}.${name}`} type="number" required
        min={name === 'depth' ? 0 : name === 'bytes' ? 4096 : 1} max={maxima[group][name]} defaultValue={value} /></label>)}</fieldset>)}
    <p>{t('recall.timeHint')}</p>
    {command.error && <p role="alert">{command.error}{command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('schedule.retryRequest')}</Button>}</p>}
    <div className="dt-mission-buttons"><Button type="submit" disabled={command.busy}>{t('usage.save')}</Button><Button disabled={command.busy} onClick={cancel}>{t('cancel')}</Button></div>
  </form>
}
