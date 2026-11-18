import { useRef, useState, type FormEvent } from 'react'
import { StopHoldNotice } from './stop-recovery.tsx'
import type { ActionCommandInput, ActionView, MissionView } from '../workspace/model.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import { MissionPlans } from './plans.tsx'
import { PersonaSelector } from './personas.tsx'
import type { PersonaRef } from '../personas/model.ts'
import { WorldSelector } from './worlds.tsx'
import { MissionDeliveryCard } from './mission-delivery.tsx'
import { ArtifactCheckPicker } from './verification.tsx'
import { MissionPullCard, MissionPullObservation } from './mission-pulls.tsx'
import { MissionCompletionCard } from './mission-completion.tsx'
import type { PullObservation } from '../publication/pull-model.ts'
import type { CheckSelection } from '../verification/review-model.ts'

/** Retain a request ID after an ambiguous response; identical retries cannot duplicate an execution. */
function useCommand(done: (mission: MissionView) => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const running = useRef(false), requests = useRef(new Map<string, string>())
  const run = async (identity: unknown, send: (requestId: string) => Promise<MissionView>) => {
    if (running.current) return
    const key = JSON.stringify(identity), requestId = requests.current.get(key) ?? crypto.randomUUID()
    requests.current.set(key, requestId); running.current = true; setBusy(true); setError('')
    try { const value = await send(requestId); requests.current.delete(key); done(value) }
    catch (failure) { setError(errorText(failure)) }
    finally { running.current = false; setBusy(false) }
  }
  return { busy, error, run }
}
const fieldValue = (event: FormEvent<HTMLFormElement>, name: string) => String(new FormData(event.currentTarget).get(name) ?? '')

export function MissionsPage({ id }: { id?: string }) {
  return id ? <MissionDetail key={id} id={id} /> : <MissionList />
}
function MissionList() {
  const { call, navigate, t } = usePanel()
  const [offset, setOffset] = useState(0), [creating, setCreating] = useState(false)
  const { data, error, reload } = usePoll(() => call('GET missions', { query: { offset } }), [call, offset])
  const command = useCommand(mission => navigate({ page: 'missions', id: mission.id }))
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = { title: fieldValue(event, 'title'), objective: fieldValue(event, 'objective'), acceptance: fieldValue(event, 'acceptance') }
    void command.run(body, requestId => call('POST missions', { body: { ...body, requestId } }))
  }
  return <section className="dt-missions">
    <div className="dt-mission-heading"><div><p className="dt-hint">{t('mission.eyebrow')}</p>
      <h2>{t('tab.missions')}</h2><p>{t('mission.intro')}</p></div>
      <Button variant="primary" onClick={() => setCreating(!creating)}>{t(creating ? 'cancel' : 'mission.new')}</Button></div>
    {(error || command.error) && <p role="alert" className="dt-error">{command.error || error?.message}
      {error && <Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button>}</p>}
    {creating && <form className="dt-mission-form" onSubmit={create}>
      <label>{t('mission.title')}<input name="title" required maxLength={160} /></label>
      <label>{t('mission.objective')}<textarea name="objective" required maxLength={12000} rows={3} /></label>
      <label>{t('mission.acceptance')}<textarea name="acceptance" required maxLength={12000} rows={3} /></label>
      <Button type="submit" variant="primary" disabled={command.busy}>{t('mission.create')}</Button>
    </form>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && !data.items.length && <div className="dt-mission-empty"><h3>{t('mission.empty')}</h3><p>{t('mission.emptyHint')}</p></div>}
    <div className="dt-mission-grid">{data?.items.map(mission => <button type="button" key={mission.id} className="dt-mission-card"
      onClick={() => navigate({ page: 'missions', id: mission.id })}>
      <span className="dt-mission-chip">{t(mission.needsReview ? 'mission.changedResult' : `mission.${mission.status}`)}</span><h3>{mission.title}</h3><p>{mission.objective}</p>
      <progress max={Math.max(1, mission.total)} value={mission.completed} aria-label={t('mission.progress')} />
      <span>{t('mission.count', { complete: mission.completed, total: mission.total })}</span>
    </button>)}</div>
    <div className="dt-mission-buttons">
      {offset > 0 && <Button onClick={() => setOffset(Math.max(0, offset - 30))}>{t('mission.previous')}</Button>}
      {data?.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}
    </div>
  </section>
}

function MissionDetail({ id }: { id: string }) {
  const { call, navigate, t } = usePanel(), { state } = usePanelData()
  const { data: polled, error, reload } = usePoll(() => call('GET missions/:id', { id }), [call, id])
  const [saved, setSaved] = useState<MissionView>(), [adding, setAdding] = useState(false)
  const [owner, setOwner] = useState<'agent' | 'person'>('agent'), [persona, setPersona] = useState<PersonaRef>()
  const [environment, setEnvironment] = useState<string>()
  const mission = saved && (!polled || saved.revision > polled.revision) ? saved : polled
  const command = useCommand(value => { setSaved(value); setAdding(false); void reload() })
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!mission) return
    const fields = new FormData(event.currentTarget)
    const body = { revision: mission.revision, title: String(fields.get('title')), instructions: String(fields.get('instructions')),
      owner, dependsOn: fields.getAll('dependency').map(String), ...(owner === 'agent' && persona ? { persona } : {}), ...(owner === 'agent' && environment ? { environment } : {}) }
    void command.run({ id, body }, requestId => call('POST missions/:id/actions', { id, body: { ...body, requestId } }))
  }
  const changeStatus = (status: MissionView['status']) => {
    if (!mission) return
    const body = { revision: mission.revision, status }
    void command.run({ id, body }, requestId => call('PUT missions/:id', { id, body: { ...body, requestId } }))
  }
  const act = (action: ActionView, operation: ActionCommandInput['command'], text = '', review?: Pick<ActionCommandInput, 'reviewKind' | 'checks' | 'pullHash'>) => {
    if (!mission) return
    const body = { revision: mission.revision, command: operation, text, ticketRevision: action.ticket?.revision, ...review }
    void command.run({ id, action: action.id, body }, requestId => call('POST missions/:id/actions/:action', {
      id, action: action.id, body: { ...body, requestId } }))
  }
  return <section className="dt-missions">
    <Button variant="ghost" onClick={() => navigate({ page: 'missions' })}>{t('mission.all')}</Button>
    {(error || command.error) && <p role="alert" className="dt-error">{command.error || error?.message}
      <Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!mission ? !error && <p role="status">{t('loading')}</p> : <>
      <div className="dt-mission-heading"><div><span className="dt-mission-chip">{t(mission.needsReview ? 'mission.changedResult' : `mission.${mission.status}`)}</span>
        <h2>{mission.title}</h2><p className="dt-mission-prose">{mission.objective}</p></div>
        <span>{t('mission.count', { complete: mission.completed, total: mission.actions.length })}</span></div>
      <div className="dt-mission-criteria"><h3>{t('mission.acceptance')}</h3><p className="dt-mission-prose">{mission.acceptance}</p></div>
      <MissionPlans mission={mission} changed={() => { void reload() }} />
      <MissionDeliveryCard key={`${mission.id}:${mission.planVersion}`} mission={mission} />
      <MissionCompletionCard mission={mission} changed={value => { setSaved(value); void reload() }} />
      <Button onClick={() => navigate({ page: 'library', query: { scope: `mission:${mission.id}` } })}>{t('library.missionRecords')}</Button>
      {(state?.paused || state?.setup.problem || (state && !state.environment?.ready)) && <p role="status">{t('mission.executionUnavailable')}</p>}
      <div className="dt-mission-buttons">
        <Button disabled={!mission.actions.length} onClick={() => navigate({ page: 'schedules', query: { mission: mission.id } })}>{t('schedule.thisPlan')}</Button>
        <Button onClick={() => navigate({ page: 'usage', query: { scope: 'mission', subject: mission.id } })}>{t('usage.limits')}</Button>
        {mission.schedule && <Button onClick={() => navigate({ page: 'schedules', id: mission.schedule!.id })}>{t('schedule.origin')}</Button>}
        {mission.status === 'active' ? <>
          <Button onClick={() => setAdding(!adding)}>{t(adding ? 'cancel' : 'mission.addAction')}</Button>
          <Button disabled={command.busy || !mission.actions.length || mission.completed !== mission.actions.length}
            onClick={() => changeStatus('completed')}>{t('mission.finish')}</Button>
          <Button disabled={command.busy || mission.actions.some(action => action.ticket?.stoppable)}
            onClick={() => changeStatus('archived')}>{t('mission.archive')}</Button>
        </> : <Button disabled={command.busy} onClick={() => changeStatus('active')}>{t('mission.reopen')}</Button>}
      </div>
      {adding && <form className="dt-mission-form" onSubmit={add}>
        <label>{t('mission.actionTitle')}<input name="title" required maxLength={160} /></label>
        <label>{t('mission.instructions')}<textarea name="instructions" required maxLength={12000} rows={3} /></label>
        <label>{t('mission.owner')}<select name="owner" value={owner} onChange={event => setOwner(event.target.value as 'agent' | 'person')}><option value="agent">{t('mission.agent')}</option>
          <option value="person">{t('mission.person')}</option></select></label>
        {owner === 'agent' && <PersonaSelector value={persona} change={setPersona} />}
        {owner === 'agent' && <WorldSelector value={environment} change={setEnvironment} />}
        {!!mission.actions.length && <fieldset><legend>{t('mission.dependencies')}</legend>{mission.actions.map(action =>
          <label className="dt-mission-check" key={action.id}><input type="checkbox" name="dependency" value={action.id} />{action.title}</label>)}</fieldset>}
        <Button type="submit" variant="primary" disabled={command.busy}>{t('mission.addAction')}</Button>
      </form>}
      {!mission.actions.length && <div className="dt-mission-empty"><h3>{t('mission.noActions')}</h3><p>{t('mission.actionsHint')}</p></div>}
      <div className="dt-mission-actions">{mission.actions.map(action => <Action key={action.id} action={action} mission={mission}
        busy={command.busy} runnable={!!state && !state.paused && !state.setup.problem && state.environment?.ready} act={act} changed={value => { setSaved(value); void reload() }} />)}</div>
      <details className="dt-mission-history"><summary>{t('mission.activity')}</summary><ol>{mission.events.map(event =>
        <li key={event.id}><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time><p>{event.text}</p></li>)}</ol></details>
    </>}
  </section>
}

function Action({ action, mission, busy, runnable, act, changed }: { action: ActionView; mission: MissionView; busy: boolean; runnable: boolean; changed(value: MissionView): void
  act: (action: ActionView, operation: ActionCommandInput['command'], text?: string, review?: Pick<ActionCommandInput, 'reviewKind' | 'checks' | 'pullHash'>) => void }) {
  const { t, navigate, openSession, notify } = usePanel(), [message, setMessage] = useState('')
  const mutable = mission.status === 'active', ticket = action.ticket
  const complete = action.status === 'review' || (action.owner === 'person' && ['todo', 'outdated'].includes(action.status))
  const dependencies = action.dependsOn.map(id => mission.actions.find(item => item.id === id)?.title).filter(Boolean)
  return <article className="dt-mission-action">
    <div className="dt-mission-heading"><div><span className="dt-mission-chip">{t(`mission.${action.owner}`)}</span><h3>{action.title}</h3></div>
      <span className={`dt-mission-status dt-mission-status-${action.status}`}>{t(`mission.${action.status}`)}</span></div>
    <p className="dt-mission-prose">{action.instructions}</p>
    {action.persona && <p className="dt-hint">{t('persona.select')}: <code>{action.persona.id}</code> · {t('persona.version', { version: action.persona.version })}</p>}
    {action.environment && <p className="dt-hint">{t('world.select')}: <code>{action.environment}</code></p>}
    <MissionPullCard mission={mission} action={action} changed={changed} />
    {!!dependencies.length && <p className="dt-hint">{t('mission.after', { actions: dependencies.join(', ') })}</p>}
    {ticket?.summary && <blockquote className="dt-mission-prose">{ticket.summary}</blockquote>}
    {ticket && <StopHoldNotice hold={ticket.stopHold} ticketId={ticket.id} link />}
    {action.status === 'done' && <p className="dt-mission-prose">{action.accepted?.note}</p>}
    {action.accepted && <p>{t(action.accepted.basis === 'checks' ? 'verification.acceptedChecks' : 'verification.acceptedManual')} · {new Date(action.accepted.at).toLocaleString()}</p>}
    <div className="dt-mission-buttons">
      {mutable && action.owner === 'agent' && ['todo', 'stopped', 'outdated'].includes(action.status) &&
        <Button variant="primary" disabled={busy || !runnable} onClick={() => act(action, 'run')}>{t('mission.run')}</Button>}
      {ticket && <Button onClick={() => navigate({ page: 'execution', id: ticket.id })}>{t('mission.execution')}</Button>}
      {ticket && <Button onClick={() => navigate({ page: 'inbox', id: ticket.id })}>{t('inbox.conversation')}</Button>}
      {ticket?.sessionId && <Button onClick={() => { void openSession(ticket.sessionId!).catch(failure => notify(errorText(failure))) }}>{t('mission.chat')}</Button>}
      {mutable && ticket?.stoppable && <>
        {ticket.retryable && <Button disabled={busy || !runnable} onClick={() => act(action, 'retry')}>{t('mission.retry')}</Button>}
        <Button disabled={busy} onClick={() => act(action, 'stop')}>{t('stop')}</Button>
      </>}
    </div>
    {mutable && complete && <ResultAcceptance key={`${ticket?.revision ?? action.id}:${action.pull ?? ''}`} missionId={mission.id} action={action} busy={busy} act={act} />}
    {mutable && !complete && ticket && !ticket.ended && <form className="dt-mission-form" onSubmit={event => {
      event.preventDefault(); act(action, 'steer', message)
    }}><label>{t('mission.message')}
        <textarea required value={message} onChange={event => setMessage(event.target.value)} maxLength={12000} rows={2} /></label>
      <Button type="submit" disabled={busy || !message.trim()}>{t('mission.send')}</Button>
    </form>}
  </article>
}

function ResultAcceptance({ missionId, action, busy, act }: { missionId: string; action: ActionView; busy: boolean;
  act(action: ActionView, operation: ActionCommandInput['command'], text: string, review: Pick<ActionCommandInput, 'reviewKind' | 'checks' | 'pullHash'>): void }) {
  const { call, t } = usePanel(), [message, setMessage] = useState(''), [manual, setManual] = useState(false), [selected, setSelected] = useState<Record<string, CheckSelection[]>>({})
  const [pull, setPull] = useState<PullObservation>(), [inspecting, setInspecting] = useState(false), [error, setError] = useState(''), inspection = useRef(false)
  const artifacts = action.review?.artifacts ?? [], checked = artifacts.length > 0
  const selections = artifacts.flatMap(artifact => selected[artifact.id] ?? []).sort((a, b) => a.runId.localeCompare(b.runId))
  const pullReady = !action.pull || !!pull && !action.pullState?.problem && (pull.binding.state === 'open' || pull.binding.merged)
  const ready = !action.review?.problem && pullReady && !inspecting && (checked ? artifacts.every(artifact => selected[artifact.id]?.length) : !action.pull && (action.owner === 'person' || manual))
  return <form className="dt-mission-form" onSubmit={event => {
    event.preventDefault(); if (ready) act(action, 'complete', message, { reviewKind: checked ? 'checks' : 'operator', ...(checked ? { checks: selections } : {}), ...(action.pull && pull ? { pullHash: pull.hash } : {}) })
  }}>
    {error && <p role="alert">{error}</p>}
    {action.pull && <><p>{t('missionPull.acceptHint')}</p><Button disabled={busy || inspecting} onClick={() => {
      if (inspection.current) return
      inspection.current = true; setInspecting(true); setSelected({}); setPull(undefined); setError('')
      void call('POST missions/:id/actions/:action/pull/inspect', { id: missionId, action: action.id }).then(setPull).catch(failure => setError(errorText(failure)))
        .finally(() => { inspection.current = false; setInspecting(false) })
    }}>{t('publication.inspectPull')}</Button>{pull && <MissionPullObservation observation={pull} />}</>}
    {action.review?.problem && <p role="alert">{action.review.problem}</p>}
    {artifacts.map(artifact => <div key={`${artifact.id}:${artifact.revision}:${artifact.hash}`}><h4>{artifact.title}</h4>
      <ArtifactCheckPicker artifactId={artifact.id} selected={selected[artifact.id] ?? []} disabled={busy || inspecting || !pullReady} pull={action.pull ? pull?.binding : undefined}
        onChange={value => setSelected(previous => ({ ...previous, [artifact.id]: value }))} />
    </div>)}
    {!checked && action.owner === 'agent' && <label><input type="checkbox" checked={manual} onChange={event => setManual(event.target.checked)} />{t('verification.manualReview')}</label>}
    <label>{t('mission.reviewNote')}<textarea required value={message} onChange={event => setMessage(event.target.value)} maxLength={12000} rows={2} /></label>
    {busy && checked && <p role="status">{t('verification.preparing')}</p>}
    <Button type="submit" disabled={busy || !message.trim() || !ready}>{t('mission.acceptResult')}</Button>
  </form>
}
