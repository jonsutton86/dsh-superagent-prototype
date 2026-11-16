/**
 * Read-only JARVIS dashboard: one page over existing management views with seven sections.
 * It reads only, never writes, never invents counts, and never claims that anything was verified.
 */
import { useState, type ReactNode } from 'react'
import { usePoll } from './api.ts'
import { Button, Tag } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, KeyValues, Section, When } from './widgets.tsx'

const usd = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })
  .format(value / 1e6)

/** Names one section body so each read-only area states its own availability. */
function Area({ name, children }: { name: string; children: ReactNode }) {
  return <div data-jarvis={name}>{children}</div>
}
function Unavailable({ failure }: { failure: Error }) {
  const { t } = usePanel()
  return <p className="dt-hint" role="status">{t('jarvis.unavailable', { error: errorText(failure) })}</p>
}
function Loading() {
  const { t } = usePanel()
  return <Hint>{t('loading')}</Hint>
}

function OverviewSection() {
  const { t, call } = usePanel()
  const { state } = usePanelData()
  const { data, error } = usePoll(() => call('GET overview'), [call])
  const stat = (label: string, value: ReactNode) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span><span className="dt-stat-value">{value}</span>
  </span>
  return <Section title={t('jarvis.section.overview')}>
    <Area name="overview">
      <Hint>{t('jarvis.overviewHint')}</Hint>
      {error && <Unavailable failure={error} />}
      {!data && !error && <Loading />}
      {data && <div className="dt-stats">
        {stat(t('pendingTickets'), data.person.length)}
        {stat(t('problems'), data.problems.length)}
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted)}
      </div>}
      {/* The pause is host state, read from the ordinary state poll; no other value is derived from it. */}
      {state?.paused && <p role="status"><Tag tone="warning">{t('jarvis.paused')}</Tag></p>}
    </Area>
  </Section>
}

function MemorySection() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET memory/search', { query: { limit: 5 } }), [call])
  return <Section title={t('jarvis.section.memory')} count={data?.items.length}>
    <Area name="memory">
      <Hint>{t('jarvis.memoryHint')}</Hint>
      {error && <Unavailable failure={error} />}
      {!data && !error && <Loading />}
      {data && !data.items.length && <Hint>{t('jarvis.memoryEmpty')}</Hint>}
      <Button variant="outline" size="sm" onClick={() => navigate({ page: 'library' })}>{t('jarvis.openAll')}</Button>
      {!!data?.items.length && <ul className="dt-list">{data.items.map(item => <li key={item.id} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title">{item.subject || item.id}</div>
          <div className="dt-row-meta">
            <span>{t(`jarvis.memoryKind.${item.kind}`)}</span><span>{item.scopeKey}</span><When at={item.updatedAt} />
          </div>
          {item.summary && <p className="dt-hint">{item.summary}</p>}
        </div>
      </li>)}</ul>}
    </Area>
  </Section>
}

function AgentsSection() {
  const { t, navigate } = usePanel()
  const { state, error } = usePanelData()
  const rows: [string, ReactNode][] = state ? [
    [t('executingLabel'), `${state.load.running} / ${state.load.maxWorkers}`],
    [t('queuedLabel'), state.load.queued],
    [t('jarvis.maxWorkers'), state.load.maxWorkers],
    [t('jarvis.masterSession'), state.masterId ?? t('none')],
  ] : []
  return <Section title={t('jarvis.section.agents')}>
    <Area name="agents">
      <Hint>{t('jarvis.agentsHint')}</Hint>
      {error && <Unavailable failure={error} />}
      {!state && !error && <Loading />}
      <Button variant="outline" size="sm" onClick={() => navigate({ page: 'execution' })}>{t('jarvis.openAll')}</Button>
      {state && <><KeyValues rows={rows} />
        {state.paused && <p><Tag tone="warning">{t('jarvis.paused')}</Tag></p>}</>}
    </Area>
  </Section>
}

function GoalsSection() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET missions'), [call])
  return <Section title={t('jarvis.section.goals')} count={data?.items.length}>
    <Area name="goals">
      <Hint>{t('jarvis.goalsHint')}</Hint>
      {error && <Unavailable failure={error} />}
      {!data && !error && <Loading />}
      {data && !data.items.length && <Hint>{t('jarvis.goalsEmpty')}</Hint>}
      {!!data?.items.length && <ul className="dt-list">{data.items.map(goal => <li key={goal.id} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title">{goal.title}</div>
          <div className="dt-row-meta">
            <span>{t(`mission.${goal.status}`)}</span>
            <span>{t('jarvis.goalProgress', { completed: goal.completed, total: goal.total })}</span>
            {goal.needsReview && <Tag tone="info">{t('jarvis.needsReview')}</Tag>}
            <When at={goal.updatedAt} />
          </div>
        </div>
      </li>)}</ul>}
      <Button variant="outline" size="sm" onClick={() => navigate({ page: 'missions' })}>{t('jarvis.openAll')}</Button>
      {data?.nextOffset != null && <Hint>{t('jarvis.firstPage')}</Hint>}
    </Area>
  </Section>
}

function ConnectionsSection() {
  const { t, call, navigate } = usePanel()
  const providers = usePoll(() => call('GET providers'), [call])
  const credentials = usePoll(() => call('GET credentials'), [call])
  return <Section title={t('jarvis.section.connections')}>
    <Area name="connections">
      <Hint>{t('jarvis.connectionsHint')}</Hint>
      {/* The providers view always reports `verified: false`; the page repeats that instead of implying a check. */}
      <p role="status"><Tag tone="neutral">{t('jarvis.notVerified')}</Tag></p>
      <Button variant="outline" size="sm" onClick={() => navigate({ page: 'settings', query: { group: 'source' } })}>{t('jarvis.openAll')}</Button>
      <h3>{t('jarvis.providers')}</h3>
      {providers.error && <Unavailable failure={providers.error} />}
      {!providers.data && !providers.error && <Loading />}
      {providers.data && !providers.data.items.length && <Hint>{t('jarvis.providersEmpty')}</Hint>}
      {!!providers.data?.items.length && <ul className="dt-list">{providers.data.items.map(provider => <li key={provider.id} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title">{provider.id}</div>
          <div className="dt-row-meta">
            <span className="dt-mono">{provider.baseUrl}</span>
            <span>{t('jarvis.models')}: {provider.models.join(', ')}</span>
            {provider.credential && <span>{provider.credential.name} · {t(provider.credential.present ? 'jarvis.credentialStored'
              : 'jarvis.credentialMissing')}</span>}
          </div>
        </div>
      </li>)}</ul>}
      <h3>{t('jarvis.credentials')}</h3>
      {credentials.error && <Unavailable failure={credentials.error} />}
      {!credentials.data && !credentials.error && <Loading />}
      {credentials.data && !credentials.data.items.length && <Hint>{t('jarvis.credentialsEmpty')}</Hint>}
      {!!credentials.data?.items.length && <ul className="dt-list">{credentials.data.items.map(credential => <li key={credential.name}
        className="dt-row"><div className="dt-row-main">
        <div className="dt-row-title">{credential.name}</div>
        <div className="dt-row-meta"><span>{credential.bytes} {t('repositoryExport.bytes')}</span>
          <When at={credential.updatedAt} /></div>
      </div></li>)}</ul>}
    </Area>
  </Section>
}

function AnalyticsSection() {
  const { t, call, navigate } = usePanel(), [period, setPeriod] = useState<'day' | 'month' | 'all'>('month')
  const now = new Date(), from = period === 'day' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
    : period === 'month' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() : undefined
  const { data, error } = usePoll(() => call('GET usage', { query: { scope: 'workspace', ...(from ? { from } : {}) } }), [call, from])
  return <Section title={t('jarvis.section.analytics')}>
    <Area name="analytics">
      <Hint>{t('jarvis.analyticsHint')}</Hint>
      <label>{t('jarvis.periodLabel')} <select aria-label={t('jarvis.periodLabel')} value={period} onChange={event => setPeriod(event.target.value as 'day' | 'month' | 'all')}>
        <option value="day">{t('jarvis.periodDay')}</option><option value="month">{t('jarvis.periodMonth')}</option><option value="all">{t('jarvis.periodAll')}</option>
      </select></label>
      <Button variant="outline" size="sm" onClick={() => navigate({ page: 'usage' })}>{t('jarvis.openAll')}</Button>
      {error && <Unavailable failure={error} />}
      {!data && !error && <Loading />}
      {data && <><KeyValues rows={[
        [t('usage.calls'), data.totals.calls.toLocaleString()],
        [t('usage.tokens'), data.totals.tokens.toLocaleString()],
        [t('usage.cost'), usd(data.totals.cost)],
        [t('usage.reserved'), `${data.totals.reservedTokens.toLocaleString()} / ${usd(data.totals.reservedCost)}`],
        [t('usage.unknown'), `${data.totals.unknownTokens.toLocaleString()} / ${usd(data.totals.unknownCost)}`],
        [t('usage.pending'), data.totals.pending.toLocaleString()],
        [t('usage.budgets'), data.budgets.length.toLocaleString()],
      ]} />
        <p className="dt-hint">{t('usage.coverage')} <When at={data.configuration.trackingSince} /></p>
        <p className="dt-hint">{t('jarvis.analyticsNote')}</p></>}
    </Area>
  </Section>
}

function VoiceSection() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET voice'), [call])
  const mode = (value: 'local' | 'cloud' | null) => value ? t(`voice.${value}`) : t('jarvis.voiceOff')
  return <Section title={t('jarvis.section.voice')}>
    <Area name="voice">
      <Hint>{t('jarvis.voiceHint')}</Hint>
      {error && <Unavailable failure={error} />}
      {!data && !error && <Loading />}
      {data && <><KeyValues rows={[
        [t('jarvis.voiceInput'), mode(data.input)],
        [t('jarvis.voiceOutput'), mode(data.output)],
        [t('jarvis.voiceActive'), String(data.active ?? 0)],
      ]} />
        <Button variant="outline" size="sm" onClick={() => navigate({ page: 'inbox' })}>{t('jarvis.openAll')}</Button>
        <Hint>{t('jarvis.voiceLimits', { seconds: Math.round(data.recordingMs / 1000), bytes: data.inputBytes, chars: data.textChars })}</Hint>
        <p className="dt-hint">{t('jarvis.voiceNote')}</p></>}
    </Area>
  </Section>
}

/** The JARVIS tab: seven read-only sections, each read from an existing management endpoint. */
export function JarvisPage() {
  const { t } = usePanel()
  return <>
    <p className="dt-hint">{t('jarvis.intro')}</p>
    <OverviewSection />
    <MemorySection />
    <AgentsSection />
    <GoalsSection />
    <ConnectionsSection />
    <AnalyticsSection />
    <VoiceSection />
  </>
}
