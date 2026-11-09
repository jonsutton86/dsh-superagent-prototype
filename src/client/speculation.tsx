import { useState, type FormEvent } from 'react'
import type { SpeculationConfiguration, SpeculationAllowance, SpeculationPolicy, SpeculationRun, SpeculationView } from '../speculation/model.ts'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Button } from './controls.tsx'
import { useOperatorCommand } from './operator-command.ts'

const dimensions = ['workspace', 'owner', 'provider', 'environment'] as const
export function SpeculationPage({ id }: { id?: string }) { return id ? <Detail id={id} /> : <List /> }
function List() {
  const { call, navigate, t } = usePanel(), [offset, setOffset] = useState(0), [editing, setEditing] = useState<SpeculationConfiguration>()
  const { data, error, reload } = usePoll(() => call('GET speculation', { query: { offset } }), [call, offset])
  return <section className="dt-missions"><h2>{t('tab.speculation')}</h2><p>{t('speculation.intro')}</p>
    {error && <p role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <><p>{t(data.configuration.policy.enabled ? 'speculation.enabled' : 'speculation.disabled')}</p>
      <Button onClick={() => setEditing(data.configuration)}>{t('speculation.configure')}</Button>
      {!data.items.length && <p>{t('speculation.empty')}</p>}
      <div className="dt-mission-grid">{data.items.map(run => <button type="button" className="dt-mission-card" key={run.id}
        onClick={() => navigate({ page: 'speculation', id: run.id })}><h3>{run.title}</h3><State run={run} />
        {run.problem && <p>{run.problem}</p>}</button>)}</div></>}
    {editing && <Policy config={editing} cancel={() => setEditing(undefined)} done={() => { setEditing(undefined); void reload() }} />}
    {offset > 0 && <Button onClick={() => setOffset(Math.max(0, offset - 30))}>{t('mission.previous')}</Button>}
    {data?.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}
  </section>
}
function State({ run }: { run: SpeculationRun }) {
  const { t } = usePanel()
  return <p>{t(`speculation.state.${run.state}`)} · {t(run.admittedAt && !run.releasedAt ? 'speculation.held' : 'speculation.unheld')}</p>
}
function Policy({ config, cancel, done }: { config: SpeculationConfiguration; cancel(): void; done(): void }) {
  const { call, t } = usePanel(), command = useOperatorCommand(done), policy = config.policy
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const read = (prefix: string): SpeculationAllowance => ({ calls: Number(form.get(`${prefix}.calls`)), tokens: Number(form.get(`${prefix}.tokens`)),
      seconds: Number(form.get(`${prefix}.seconds`)), ...(form.get(`${prefix}.cost`) ? { cost: Math.round(Number(form.get(`${prefix}.cost`)) * 1e6) } : {}) })
    const next: SpeculationPolicy = { enabled: form.has('enabled'), ttlMinutes: Number(form.get('ttl')), run: read('run'),
      limits: Object.fromEntries(dimensions.map(d => [d, { ...read(d), concurrent: Number(form.get(`${d}.concurrent`)), runs: Number(form.get(`${d}.runs`)) }])) as SpeculationPolicy['limits'] }
    const body = { revision: config.revision, policy: next }
    void command.run(body, requestId => call('PUT speculation', { body: { ...body, requestId } }))
  }
  return <form className="dt-mission-form" onSubmit={submit}><h3>{t('speculation.configure')}</h3><p>{t('speculation.quotaHint')}</p>
    <label><input name="enabled" type="checkbox" defaultChecked={policy.enabled} />{t('speculation.enable')}</label>
    <label>{t('speculation.ttl')}<input name="ttl" type="number" required min={1} max={10080} defaultValue={policy.ttlMinutes} /></label>
    <fieldset><legend>{t('speculation.run')}</legend><Allowance prefix="run" value={policy.run} /></fieldset>
    {dimensions.map(d => <fieldset key={d}><legend>{t(`speculation.dimension.${d}`)}</legend>
      <label>{t('speculation.concurrent')}<input name={`${d}.concurrent`} type="number" required min={1} max={100} defaultValue={policy.limits[d].concurrent} /></label>
      <label>{t('speculation.runs')}<input name={`${d}.runs`} type="number" required min={1} max={10000} defaultValue={policy.limits[d].runs} /></label>
      <Allowance prefix={d} value={policy.limits[d]} /></fieldset>)}
    <CommandError command={command} /><Button type="submit" disabled={command.busy}>{t('usage.save')}</Button>
    <Button onClick={cancel} disabled={command.busy}>{t('cancel')}</Button>
  </form>
}
function Allowance({ prefix, value }: { prefix: string; value: SpeculationAllowance }) {
  const { t } = usePanel()
  return <>{(['calls', 'tokens', 'seconds'] as const).map(metric => <label key={metric}>{t(`speculation.${metric}`)}
    <input name={`${prefix}.${metric}`} type="number" required min={1} max={metric === 'calls' ? 10000 : metric === 'seconds' ? 86400 : 1e12} defaultValue={value[metric]} /></label>)}
    <label>{t('usage.costLimit')}<input name={`${prefix}.cost`} type="number" min={0.000001} max={1e6} step="0.000001" defaultValue={value.cost === undefined ? '' : value.cost / 1e6} /></label></>
}
function CommandError({ command }: { command: ReturnType<typeof useOperatorCommand> }) {
  const { t } = usePanel()
  return command.error && <p role="alert">{command.error}{command.retry && <Button disabled={command.busy}
    onClick={() => { void command.retry?.() }}>{t('schedule.retryRequest')}</Button>}</p>
}
function Detail({ id }: { id: string }) {
  const { call, navigate, t } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET speculation/:id', { id }), [call, id])
  return <section className="dt-missions"><Button onClick={() => navigate({ page: 'speculation' })}>{t('tab.speculation')}</Button>
    <h2>{data?.title ?? t('tab.speculation')}</h2>
    {error && <p role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <><State run={data} /><p>{data.problem}</p><p>{t('speculation.expires')}: {new Date(data.expiresAt).toLocaleString()}</p>
      <p>{data.owner} · {data.environment} · {data.providers.join(', ')}</p>
      <Button onClick={() => navigate({ page: 'inbox', id: data.ticketId })}>{t('inbox.conversation')}</Button>
      <Button onClick={() => navigate({ page: 'environments' })}>{t('tab.environments')}</Button>
      <Button onClick={() => navigate({ page: 'usage' })}>{t('tab.usage')}</Button>
      <p>{t('usage.calls')}: {data.usage.calls} · {t('usage.tokens')}: {data.usage.tokens.toLocaleString()} · {t('usage.reserved')}: {data.usage.reservedTokens.toLocaleString()}</p>
      <p>{t('usage.cost')}: ${(data.usage.cost / 1e6).toFixed(6)} · {t('usage.reserved')}: ${(data.usage.reservedCost / 1e6).toFixed(6)}</p>
      {!!data.usage.unknownCost && <p>{t('speculation.unpriced')}</p>}
      <p>{t('speculation.reviewHint')}</p><pre className="dt-library-excerpt">{data.report}</pre>
      {data.evidence && <code>{data.evidence}</code>}
      {data.review && <p>{data.review.note} · {new Date(data.review.at).toLocaleString()}</p>}
      <Review key={`${data.id}:${data.revision}`} run={data} done={() => { void reload() }} />
      <h3>{t('speculation.messages')}</h3><p>{t('speculation.messageHint')}</p>
      {!data.messages.length && <p>{t('speculation.noMessages')}</p>}
      {data.messages.map(message => <Message key={`${message.id}:${message.fingerprint}:${data.revision}`} run={data} message={message} done={() => { void reload() }} />)}
    </>}
  </section>
}
function Review({ run, done }: { run: SpeculationView; done(): void }) {
  const { call, t } = usePanel(), command = useOperatorCommand(done), [choice, setChoice] = useState<'promote' | 'cancel' | 'reconcile'>(
    run.state === 'ready' && run.releasedAt ? 'promote' : run.recovered ? 'reconcile' : 'cancel')
  if (['expired', 'cancelled'].includes(run.state) && !run.recovered) return null
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = { revision: run.revision, command: choice, evidence: run.evidence, note: String(new FormData(event.currentTarget).get('note') ?? '') }
    void command.run({ id: run.id, body }, requestId => call('POST speculation/:id/review', { id: run.id, body: { ...body, requestId } }))
  }
  return <form onSubmit={submit}><label>{t('reflection.decision')}<select value={choice} onChange={event => setChoice(event.target.value as typeof choice)}>
    {run.state === 'ready' && run.releasedAt && <option value="promote">{t('speculation.promote')}</option>}
    <option value="cancel">{t('speculation.cancel')}</option>
    {run.recovered && <option value="reconcile">{t('speculation.reconcile')}</option>}</select></label>
    {choice === 'reconcile' && <p>{t('speculation.reconcileHint')}</p>}
    <label>{t('reflection.note')}<textarea name="note" required maxLength={2000} /></label>
    <CommandError command={command} /><Button type="submit" disabled={command.busy}>{t('reflection.submitReview')}</Button></form>
}
function Message({ run, message, done }: { run: SpeculationView; message: SpeculationView['messages'][number]; done(): void }) {
  const { call, t } = usePanel(), command = useOperatorCommand(done)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = { revision: run.revision, receiptId: message.id, fingerprint: message.fingerprint, note: String(new FormData(event.currentTarget).get('note') ?? '') }
    void command.run({ id: run.id, body }, requestId => call('POST speculation/:id/messages', { id: run.id, body: { ...body, requestId } }))
  }
  return <article className="dt-mission-card"><pre>{JSON.stringify(message.channel, null, 2)}</pre><pre className="dt-library-excerpt">{message.text}</pre>
    <p>{message.status} · {t(message.approved ? 'speculation.approved' : 'speculation.awaiting')}</p>
    {run.state === 'promoted' && !message.approved && message.status === 'pending' && <form onSubmit={submit}>
      <label>{t('reflection.note')}<textarea name="note" required maxLength={2000} /></label><CommandError command={command} />
      <Button type="submit" disabled={command.busy}>{t('speculation.approveMessage')}</Button></form>}</article>
}
