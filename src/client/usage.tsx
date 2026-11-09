import { useState, type FormEvent } from 'react'
import type { UsageScope, UsageCall, UsageConfiguration, UsageBudget, ModelPrice } from '../usage/model.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { useOperatorCommand } from './operator-command.ts'

const usd = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value / 1e6)
const micro = (text: string) => text.trim() === '' ? undefined : Math.round(Number(text) * 1e6)
const value = (form: FormData, name: string) => String(form.get(name) ?? '')
const count = (form: FormData, name: string) => value(form, name).trim() === '' ? undefined : Number(value(form, name))
type Editor = { config: UsageConfiguration; budget?: UsageBudget; price?: ModelPrice; kind: 'budget' | 'price' }

export function UsagePage({ scope = 'workspace', subject }: { scope?: UsageScope['kind']; subject?: string }) {
  const { call, navigate, t } = usePanel(), [offset, setOffset] = useState(0), [period, setPeriod] = useState('month'), [editing, setEditing] = useState<Editor>()
  const now = new Date(), from = period === 'all' ? '0000-01-01T00:00:00.000Z'
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), period === 'month' ? 1 : now.getUTCDate())).toISOString()
  const { data, error, reload } = usePoll(() => call('GET usage', { query: { scope, subject, from, offset } }), [call, scope, subject, from, offset])
  const selected: UsageScope = scope === 'workspace' ? { kind: scope } : { kind: scope, id: subject! }
  const changePeriod = (next: string) => { setOffset(0); setPeriod(next) }
  return <section className="dt-missions"><h2>{t('tab.usage')} · {t(`usage.scope.${scope}`)}</h2>
    <p>{t('usage.intro')}</p>{scope !== 'workspace' && <Button onClick={() => navigate({ page: 'usage' })}>{t('usage.all')}</Button>}
    <label>{t('usage.period')}<select value={period} onChange={event => changePeriod(event.target.value)}>
      <option value="day">{t('usage.day')}</option><option value="month">{t('usage.month')}</option><option value="all">{t('usage.lifetime')}</option></select></label>
    {error && <p role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <><p>{t('usage.coverage')} <time dateTime={data.configuration.trackingSince}>{new Date(data.configuration.trackingSince).toLocaleString()}</time></p>
      <div className="dt-mission-grid"><article className="dt-mission-card"><h3>{t('usage.calls')}</h3><p>{data.totals.calls.toLocaleString()}</p></article>
        <article className="dt-mission-card"><h3>{t('usage.tokens')}</h3><p>{data.totals.tokens.toLocaleString()}</p><p>{t('usage.reserved')}: {data.totals.reservedTokens.toLocaleString()}</p></article>
        <article className="dt-mission-card"><h3>{t('usage.cost')}</h3><p>{usd(data.totals.cost)}</p><p>{t('usage.reserved')}: {usd(data.totals.reservedCost)}</p></article></div>
      <p>{t('usage.unknown')}: {data.totals.unknownTokens} {t('usage.tokens')}, {data.totals.unknownCost} {t('usage.cost')} · {data.totals.pending} {t('usage.pending')}</p>
      <h3>{t('usage.budgets')}</h3><p>{t('usage.reserveHint')}</p>
      <Button onClick={() => setEditing({ kind: 'budget', config: data.configuration })}>{t('usage.addBudget')}</Button>
      <div className="dt-mission-grid">{data.budgets.filter(budget => scope === 'workspace' || budget.scope.kind === 'workspace' || budget.scope.kind === scope && 'id' in budget.scope && budget.scope.id === subject).map(budget => <article className="dt-mission-card" key={budget.id}>
        <h4>{budget.title}</h4><p>{t(`usage.scope.${budget.scope.kind}`)} · {t(`usage.${budget.period}`)} · {t(budget.enabled ? budget.exhausted ? 'usage.exhausted' : 'schedule.enabled' : 'schedule.paused')}</p>
        {budget.calls !== undefined && <p>{t('usage.calls')}: {budget.totals.calls}/{budget.calls}</p>}
        {budget.tokens !== undefined && <p>{t('usage.tokens')}: {budget.totals.tokens + budget.totals.reservedTokens}/{budget.tokens}</p>}
        {budget.cost !== undefined && <p>{t('usage.cost')}: {usd(budget.totals.cost + budget.totals.reservedCost)}/{usd(budget.cost)}</p>}
        <Button onClick={() => setEditing({ kind: 'budget', config: data.configuration, budget })}>{t('usage.editBudget')}</Button>
      </article>)}</div>
      <h3>{t('usage.prices')}</h3><p>{t('usage.priceHint')}</p><Button onClick={() => setEditing({ kind: 'price', config: data.configuration })}>{t('usage.addPrice')}</Button>
      <div className="dt-mission-grid">{data.configuration.prices.map(price => <article className="dt-mission-card" key={JSON.stringify([price.provider, price.model])}>
        <h4>{price.provider} / {price.model}</h4><p>{t('usage.input')}: {usd(price.input)} · {t('usage.output')}: {usd(price.output)}</p>
        <p>{t('usage.cacheRead')}: {usd(price.cacheRead)} · {t('usage.cacheWrite')}: {usd(price.cacheWrite)}</p><p>{price.note}</p>
        <Button onClick={() => setEditing({ kind: 'price', config: data.configuration, price })}>{t('usage.editPrice')}</Button>
      </article>)}</div>
      {editing && <ConfigurationForm key={`${editing.kind}:${editing.budget?.id ?? editing.price?.model ?? 'new'}:${editing.config.revision}`} editor={editing} scope={selected}
        done={() => { setEditing(undefined); void reload() }} cancel={() => setEditing(undefined)} />}
      <h3>{t('usage.history')}</h3><div className="dt-mission-actions">{data.calls.map(item => <CallCard key={item.id} item={item} changed={() => { void reload() }} />)}</div>
      <div className="dt-mission-buttons">{offset > 0 && <Button onClick={() => setOffset(offset - 30)}>{t('mission.previous')}</Button>}
        {data.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}</div></>}
  </section>
}
function ConfigurationForm({ editor, scope, done, cancel }: { editor: Editor; scope: UsageScope; done: () => void; cancel: () => void }) {
  const { call, t } = usePanel(), command = useOperatorCommand(done), [newId] = useState(() => crypto.randomUUID())
  const { config, budget, price, kind } = editor
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    let prices = config.prices, budgets = config.budgets
    if (kind === 'budget') {
      const next: UsageBudget = { id: budget?.id ?? newId, title: value(form, 'title'), scope: budget?.scope ?? scope,
        period: value(form, 'period') as UsageBudget['period'], enabled: form.has('enabled'), calls: count(form, 'calls'), tokens: count(form, 'tokens'), cost: micro(value(form, 'cost')) }
      budgets = [...budgets.filter(item => item.id !== next.id), next]
    } else {
      const next: ModelPrice = { provider: value(form, 'provider'), model: value(form, 'model'), note: value(form, 'note'),
        input: micro(value(form, 'input'))!, output: micro(value(form, 'output'))!, cacheRead: micro(value(form, 'cacheRead'))!, cacheWrite: micro(value(form, 'cacheWrite'))! }
      prices = [...prices.filter(item => item.provider !== next.provider || item.model !== next.model), next]
    }
    const body = { revision: config.revision, prices, budgets }
    void command.run(body, requestId => call('PUT usage', { body: { ...body, requestId } }))
  }
  return <form className="dt-mission-form" onSubmit={submit}><h3>{t(kind === 'budget' ? 'usage.editBudget' : 'usage.editPrice')}</h3>
    {kind === 'budget' ? <><p>{t(`usage.scope.${(budget?.scope ?? scope).kind}`)}</p>
      <label>{t('usage.budgetName')}<input name="title" required maxLength={160} defaultValue={budget?.title ?? ''} /></label>
      <label>{t('usage.period')}<select name="period" defaultValue={budget?.period ?? 'month'}><option value="day">{t('usage.day')}</option><option value="month">{t('usage.month')}</option><option value="lifetime">{t('usage.lifetime')}</option></select></label>
      <p>{t('usage.emptyLimit')}</p><label>{t('usage.callLimit')}<input name="calls" type="number" min={1} max={1e9} defaultValue={budget?.calls ?? ''} /></label>
      <label>{t('usage.tokenLimit')}<input name="tokens" type="number" min={1} max={1e12} defaultValue={budget?.tokens ?? ''} /></label>
      <label>{t('usage.costLimit')}<input name="cost" type="number" min={0.000001} max={1e6} step="0.000001" defaultValue={budget?.cost === undefined ? '' : budget.cost / 1e6} /></label>
      <label className="dt-mission-check"><input name="enabled" type="checkbox" defaultChecked={budget?.enabled ?? true} />{t('usage.enforce')}</label></> : <>
      <label>{t('usage.provider')}<input name="provider" required maxLength={120} readOnly={!!price} defaultValue={price?.provider ?? ''} /></label>
      <label>{t('usage.model')}<input name="model" required maxLength={200} readOnly={!!price} defaultValue={price?.model ?? ''} /></label>
      {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(name => <label key={name}>{t(`usage.${name}`)}<input name={name} type="number" min={0} max={1e6} step="0.000001" required defaultValue={price ? price[name] / 1e6 : ''} /></label>)}
      <label>{t('usage.priceSource')}<input name="note" required maxLength={1000} defaultValue={price?.note ?? ''} /></label></>}
    {command.error && <p role="alert">{command.error}{command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('schedule.retryRequest')}</Button>}</p>}
    <div className="dt-mission-buttons"><Button type="submit" variant="primary" disabled={command.busy}>{t('usage.save')}</Button><Button disabled={command.busy} onClick={cancel}>{t('cancel')}</Button></div>
  </form>
}
function CallCard({ item, changed }: { item: UsageCall; changed: () => void }) {
  const { call, navigate, t } = usePanel(), [editing, setEditing] = useState(false)
  const command = useOperatorCommand(() => { setEditing(false); changed() })
  const tokens = item.reconciliation?.tokens ?? item.tokens
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const body = { tokens: { inputTokens: Number(value(form, 'input')), outputTokens: Number(value(form, 'output')),
      cacheReadTokens: count(form, 'cacheRead'), cacheWriteTokens: count(form, 'cacheWrite'), totalTokens: count(form, 'total') },
      cost: micro(value(form, 'cost')), note: value(form, 'note') }
    void command.run({ id: item.id, body }, requestId => call('POST usage/calls/:id/reconcile', { id: item.id, body: { ...body, requestId } }))
  }
  return <article className="dt-mission-card"><h4>{item.provider} / {item.model}</h4><p><time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString()}</time> · {item.purpose} · {t(`usage.phase.${item.phase}`)}</p>
    <p>{t('usage.tokens')}: {item.totalTokens === undefined ? t('usage.unreported') : item.totalTokens.toLocaleString()}
      {' · '}{t(item.reconciliation?.cost === undefined ? 'usage.estimated' : 'usage.recorded')}: {item.cost === undefined ? t('usage.unreported') : usd(item.cost)}</p>
    {tokens && <p>{t('usage.input')}: {tokens.inputTokens} · {t('usage.output')}: {tokens.outputTokens} · {t('usage.cacheRead')}: {tokens.cacheReadTokens ?? 0} · {t('usage.cacheWrite')}: {tokens.cacheWriteTokens ?? 0}</p>}
    {item.phase === 'unknown' && <p>{t('usage.reserved')}: {item.reservedTokens ?? t('usage.unreported')} {t('usage.tokens')}, {item.reservedCost === undefined ? t('usage.unreported') : usd(item.reservedCost)}</p>}
    {item.owner.ticketId && <Button onClick={() => navigate({ page: 'execution', id: item.owner.ticketId })}>{t('usage.openTask')}</Button>}
    {item.owner.missionId && <Button onClick={() => navigate({ page: 'usage', query: { scope: 'mission', subject: item.owner.missionId } })}>{t('usage.mission')}</Button>}
    {item.owner.personaId && <Button onClick={() => navigate({ page: 'usage', query: { scope: 'persona', subject: item.owner.personaId } })}>{t('usage.persona')}</Button>}
    {item.reconciliation && <p>{item.reconciliation.note}</p>}
    {(item.phase === 'unknown' || item.phase === 'reported' && item.cost === undefined) && <Button onClick={() => setEditing(!editing)}>{t(editing ? 'cancel' : 'usage.reconcile')}</Button>}
    {editing && <form className="dt-mission-form" onSubmit={submit}><p>{t('usage.reconcileHint')}</p>
      {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(name => <label key={name}>{t(`usage.${name}`)}<input name={name} type="number" min={0} max={Number.MAX_SAFE_INTEGER}
        required={name === 'input' || name === 'output'} defaultValue={tokens?.[`${name}Tokens`] ?? ''} /></label>)}
      <label>{t('usage.tokens')}<input name="total" type="number" min={0} max={Number.MAX_SAFE_INTEGER} defaultValue={tokens?.totalTokens ?? ''} /></label>
      <label>{t('usage.verifiedCost')}<input name="cost" type="number" min={0} max={1e6} step="0.000001" required={!item.price} /></label>
      <label>{t('usage.evidence')}<textarea name="note" required maxLength={2000} /></label>
      {command.error && <p role="alert">{command.error}{command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('schedule.retryRequest')}</Button>}</p>}
      <Button type="submit" disabled={command.busy}>{t('usage.recordUsage')}</Button>
    </form>}
  </article>
}
