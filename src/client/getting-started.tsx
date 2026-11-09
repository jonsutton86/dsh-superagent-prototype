/** Read-only setup guidance. Catalog hints never grant authority or reject custom model routes. */
import type { ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { SetupMessage } from './widgets.tsx'

type Catalog = ApiResponse<'GET models'>
type Model = { provider: string; model: string }
function ModelStatus({ label, selection, catalog, unavailable }: { label: string; selection?: Model; catalog?: Catalog; unavailable: boolean }) {
  const { t } = usePanel()
  const advertised = selection && catalog?.groups.some(group => group.id === selection.provider && group.models.some(model => model.id === selection.model))
  const failed = selection && catalog?.failures.some(provider => provider.id === selection.provider)
  return <li><strong>{label}</strong><p>{selection ? `${selection.provider} / ${selection.model}` : t('guide.noModel')}</p>
    <p role="status">{t(unavailable || failed ? 'guide.modelUnknown' : !catalog ? 'loading' : advertised ? 'guide.modelListed' : 'guide.modelUnlisted')}</p></li>
}
function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <section className="dt-guide-step" aria-labelledby={`dt-guide-step-${number}`}><h3 id={`dt-guide-step-${number}`}>{number}. {title}</h3>{children}</section>
}
export function GettingStartedLink() {
  const { t, navigate } = usePanel()
  return <div className="dt-guide-intro"><p>{t('guide.intro')}</p><Button onClick={() => navigate({ page: 'guide' })}>{t('guide.open')}</Button></div>
}
export function GettingStartedPage() {
  const { t, call, navigate } = usePanel(), { state, error: stateError, reload: reloadState } = usePanelData()
  const models = usePoll(() => call('GET models'), [call], 30_000)
  const settings = usePoll(() => call('GET settings'), [call])
  const environment = usePoll(() => call('GET inbox/setup'), [call])
  const missions = usePoll(() => call('GET missions', { query: { limit: 5 } }), [call])
  const modelUnknown = !!models.error || !!settings.error || !settings.data
  const selection = (role: 'executor' | 'eval') => settings.data?.blocks[role].value.model ?? models.data?.default
  const current = environment.data?.defaultEnvironment
  const canStart = !!state && !stateError && !state.paused && !state.setup.problem && !!state.environment?.ready
  const refresh = () => { void Promise.allSettled([reloadState(), models.reload(), settings.reload(), environment.reload(), missions.reload()]) }
  return <section className="dt-guide"><div className="dt-mission-heading"><h2>{t('guide.title')}</h2><Button onClick={refresh}>{t('mission.refresh')}</Button></div>
    <p>{t('guide.intro')}</p>
    <Step number={1} title={t('guide.models')}>
      <p>{t('guide.modelsHelp')}</p>
      <ul className="dt-guide-models"><ModelStatus label={t('guide.workerModel')} selection={selection('executor')} catalog={models.data} unavailable={modelUnknown} />
        <ModelStatus label={t('guide.routerModel')} selection={selection('eval')} catalog={models.data} unavailable={modelUnknown} /></ul>
      <p className="dt-hint">{t('guide.catalogHint')}</p>
      <div className="dt-guide-actions"><Button onClick={() => navigate(settingsRoute('execution'))}>{t('guide.workerSettings')}</Button>
        <Button onClick={() => navigate(settingsRoute('eval'))}>{t('guide.routerSettings')}</Button></div>
    </Step>
    <Step number={2} title={t('guide.environment')}>
      {!state && !stateError && <p role="status">{t('loading')}</p>}
      {(stateError || environment.error) && <p role="alert">{t('guide.environmentUnknown')}</p>}
      {state?.setup.problem && <p role="alert"><SetupMessage problem={state.setup.problem} /></p>}
      {state?.paused && <p role="status">{t('guide.paused')}</p>}
      {!environment.error && current?.available && <><strong>{current.name}</strong><p className="dt-guide-path">{current.root}</p><p>{t('guide.defaultLocation')}</p></>}
      {!environment.error && current && !current.available && <p role="status">{t(state?.environment?.ready ? 'guide.chooseWorld' : 'guide.noEnvironment')}</p>}
      <div className="dt-guide-actions"><Button onClick={() => navigate({ page: 'environments' })}>{t('tab.environments')}</Button>
        {state?.paused && <Button onClick={() => navigate({ page: 'execution' })}>{t('guide.executionControls')}</Button>}</div>
      {state?.setup.machine.stateDir && <details><summary>{t('guide.storage')}</summary><p className="dt-guide-path">{state.setup.machine.stateDir}</p>
        <p>{t('guide.storageHint')}</p><Button onClick={() => navigate(settingsRoute('deployment'))}>{t('guide.deployment')}</Button></details>}
    </Step>
    <Step number={3} title={t('guide.preferences')}>
      <p>{t('guide.preferencesHelp')}</p><div className="dt-guide-actions">
        <Button onClick={() => navigate({ page: 'personas' })}>{t('tab.personas')}</Button>
        <Button onClick={() => navigate({ page: 'usage' })}>{t('tab.usage')}</Button>
        <Button onClick={() => navigate({ page: 'library' })}>{t('tab.library')}</Button></div>
      <p className="dt-hint">{t('guide.inputs')}</p>
    </Step>
    <Step number={4} title={t('guide.firstTask')}>
      <p>{t('guide.taskHelp')}</p><p>{t('guide.reviewHelp')}</p>
      <Button variant="primary" disabled={!canStart} onClick={() => navigate({ page: 'inbox', query: { compose: true } })}>{t('guide.start')}</Button>
      {!canStart && <p role="status">{t('guide.startUnavailable')}</p>}
      <p className="dt-hint">{t('guide.scheduleHelp')}</p><Button onClick={() => navigate({ page: 'schedules' })}>{t('tab.schedules')}</Button>
    </Step>
    <section aria-labelledby="dt-guide-missions"><h3 id="dt-guide-missions">{t('guide.recent')}</h3>
      {missions.error ? <p role="alert">{t('guide.missionsUnknown')}</p> : !missions.data ? <p role="status">{t('loading')}</p>
        : missions.data.items.length ? <ul className="dt-guide-missions">{missions.data.items.map(mission => <li key={mission.id}>
          <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'missions', id: mission.id })}>{mission.title}</button>
          <p>{t(mission.needsReview ? 'guide.reviewAgain' : mission.status === 'completed' ? 'guide.missionComplete' : mission.status === 'archived' ? 'guide.missionArchived' : 'guide.missionActive',
            { done: mission.completed, total: mission.total })}</p></li>)}</ul> : <p>{t('guide.noMissions')}</p>}
      <Button onClick={() => navigate({ page: 'missions' })}>{t('tab.missions')}</Button>
    </section>
  </section>
}
