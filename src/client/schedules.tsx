import { useState, type FormEvent } from 'react'
import type { ScheduleView, ScheduleDefinition, Cadence } from '../workspace/schedule-model.ts'
import type { PlanDefinition } from '../workspace/plan-model.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { useOperatorCommand } from './operator-command.ts'

export function SchedulesPage({ id, missionId }: { id?: string; missionId?: string }) {
  return id ? <ScheduleDetail id={id} /> : missionId ? <FromMission id={missionId} /> : <ScheduleList />
}
function ScheduleList() {
  const { call, navigate, t } = usePanel(), [offset, setOffset] = useState(0)
  const { data, error, reload } = usePoll(() => call('GET schedules', { query: { offset } }), [call, offset])
  return <section className="dt-missions"><h2>{t('tab.schedules')}</h2><p>{t('schedule.intro')}</p>
    <Button onClick={() => navigate({ page: 'missions' })}>{t('schedule.chooseMission')}</Button>
    {error && <p role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && !data.items.length && <p>{t('schedule.empty')}</p>}
    <div className="dt-mission-grid">{data?.items.map(schedule => <button type="button" className="dt-mission-card" key={schedule.id}
      onClick={() => navigate({ page: 'schedules', id: schedule.id })}><h3>{schedule.title}</h3>
      <p>{t(schedule.enabled ? 'schedule.enabled' : 'schedule.paused')} · {schedule.runs}/{schedule.maxRuns} {t('schedule.runs')}</p>
      <p>{schedule.open}/{schedule.maxOpen} {t('schedule.open')}</p>
      <p>{t('schedule.next')}: {schedule.runs >= schedule.maxRuns ? t('schedule.exhausted') : schedule.nextAt ? new Date(schedule.nextAt).toLocaleString() : t('schedule.finished')}</p>
    </button>)}</div>
    <div className="dt-mission-buttons">{offset > 0 && <Button onClick={() => setOffset(offset - 30)}>{t('mission.previous')}</Button>}
      {data?.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}</div>
  </section>
}
function FromMission({ id }: { id: string }) {
  const { call, navigate, t } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET missions/:id', { id }), [call, id])
  return <section className="dt-missions"><Button onClick={() => navigate({ page: 'missions', id })}>{t('schedule.backMission')}</Button>
    <h2>{t('schedule.new')}</h2>
    {error && <p role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <ScheduleForm key={`${id}:${data.planVersion}`} plan={{ title: data.title, objective: data.objective, acceptance: data.acceptance,
      actions: data.actions.map(({ id, title, instructions, owner, dependsOn, persona, environment }) => ({ id, title, instructions, owner, dependsOn, persona, environment })) }}
      done={schedule => navigate({ page: 'schedules', id: schedule.id })} />}
  </section>
}
function ScheduleDetail({ id }: { id: string }) {
  const { call, navigate, t } = usePanel(), [offset, setOffset] = useState(0), [editing, setEditing] = useState<ScheduleView>()
  const { data, error, reload } = usePoll(() => call('GET schedules/:id', { id, query: { offset } }), [call, id, offset])
  const command = useOperatorCommand(() => { void reload() })
  return <section className="dt-missions"><Button onClick={() => navigate({ page: 'schedules' })}>{t('schedule.all')}</Button>
    {(error || command.error) && <p role="alert">{command.error || error?.message}
      <Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button>
      {command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('schedule.retryRequest')}</Button>}</p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <><h2>{data.definition.title}</h2><p>{t(data.enabled ? 'schedule.enabled' : 'schedule.paused')} · {data.runs}/{data.definition.maxRuns} {t('schedule.runs')}
      {' · '}{data.open}/{data.definition.maxOpen} {t('schedule.open')}</p><p>{t('schedule.next')}: {data.runs >= data.definition.maxRuns ? t('schedule.exhausted') : data.nextAt ? new Date(data.nextAt).toLocaleString() : t('schedule.finished')}</p>
      <p>{t('schedule.pauseHint')}</p><div className="dt-mission-buttons">
        <Button disabled={command.busy} onClick={() => { void command.run({ id, revision: data.revision, enabled: !data.enabled }, requestId =>
          call('POST schedules/:id/enabled', { id, body: { requestId, revision: data.revision, enabled: !data.enabled } })) }}>{t(data.enabled ? 'schedule.pause' : 'schedule.enable')}</Button>
        <Button onClick={() => setEditing(editing ? undefined : data)}>{t(editing ? 'cancel' : 'schedule.edit')}</Button></div>
      {editing && <ScheduleForm key={id} existing={editing} plan={editing.definition.plan} done={() => { setEditing(undefined); void reload() }} />}
      <h3>{t('schedule.history')}</h3><div className="dt-mission-actions">{data.occurrences.map(occurrence => <article className="dt-mission-card" key={occurrence.id}>
        <time dateTime={occurrence.due}>{new Date(occurrence.due).toLocaleString()}</time>{occurrence.through && <> — <time dateTime={occurrence.through}>{new Date(occurrence.through).toLocaleString()}</time></>}
        <p>{t(`schedule.state.${occurrence.state}`)} · {t('schedule.version')} {occurrence.revision}</p>
        {occurrence.error && <p role="alert">{occurrence.error}</p>}
        {occurrence.missionId && <Button onClick={() => navigate({ page: 'missions', id: occurrence.missionId })}>{t('schedule.viewMission')}</Button>}
        {occurrence.state === 'blocked' && <Button disabled={command.busy} onClick={() => { void command.run({ id, occurrence: occurrence.id }, requestId =>
          call('POST schedules/:id/occurrences/:occurrence/retry', { id, occurrence: occurrence.id, body: { requestId } })) }}>{t('schedule.retryOccurrence')}</Button>}
      </article>)}</div><div className="dt-mission-buttons">
        {offset > 0 && <Button onClick={() => setOffset(offset - 30)}>{t('mission.previous')}</Button>}
        {data.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}</div></>}
  </section>
}
function ScheduleForm({ existing, plan, done }: { existing?: ScheduleView; plan: PlanDefinition; done: (value: ScheduleView) => void }) {
  const { call, t } = usePanel(), [kind, setKind] = useState<Cadence['kind']>(existing?.definition.cadence.kind ?? 'calendar')
  const command = useOperatorCommand(() => {})
  // A successful response is handled inside send; the hook retains its exact payload and request ID after an ambiguous response.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget), value = (key: string) => String(form.get(key) ?? '')
    const cadence: Cadence = kind === 'calendar' ? { kind, time: value('time'), timeZone: value('timeZone'), startDate: value('startDate'), weekdays: form.getAll('weekday').map(Number) }
      : kind === 'once' ? { kind, at: value('instant') } : { kind, start: value('instant'), everyMinutes: Number(value('minutes')) }
    const definition: ScheduleDefinition = { title: value('title'), plan, cadence, missed: value('missed') as ScheduleDefinition['missed'],
      graceSeconds: Number(value('grace')), maxRuns: Number(value('maxRuns')), maxOpen: Number(value('maxOpen')) }
    const body = { definition, enabled: form.has('enabled'), ...(existing ? { revision: existing.revision } : {}) }
    void command.run({ id: existing?.id, body }, async requestId => {
      const result = existing ? await call('PUT schedules/:id', { id: existing.id, body: { ...body, revision: existing.revision, requestId } })
        : await call('POST schedules', { body: { ...body, requestId } })
      done(result)
    })
  }
  const cadence = existing?.definition.cadence
  return <form className="dt-mission-form" onSubmit={submit}>
    <p>{t('schedule.snapshot')}</p><details><summary>{plan.title} · {plan.actions.length} {t('schedule.actions')}</summary>
      <p>{plan.objective}</p><p>{plan.acceptance}</p><ol>{plan.actions.map(action => <li key={action.id}><strong>{action.title}</strong> ({action.owner})
        <p>{action.instructions}</p>{!!action.dependsOn.length && <p>{t('mission.dependencies')}: {action.dependsOn.map(id => plan.actions.find(item => item.id === id)?.title).join(', ')}</p>}</li>)}</ol></details>
    <label>{t('schedule.title')}<input name="title" required maxLength={160} defaultValue={existing?.definition.title ?? plan.title} /></label>
    <label>{t('schedule.cadence')}<select value={kind} onChange={event => setKind(event.target.value as Cadence['kind'])}>
      <option value="calendar">{t('schedule.calendar')}</option><option value="interval">{t('schedule.interval')}</option><option value="once">{t('schedule.once')}</option></select></label>
    {kind === 'calendar' ? <>
      <label>{t('schedule.zone')}<input name="timeZone" required defaultValue={cadence?.kind === 'calendar' ? cadence.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone} /></label>
      <label>{t('schedule.startDate')}<input name="startDate" type="date" required defaultValue={cadence?.kind === 'calendar' ? cadence.startDate : new Date().toLocaleDateString('en-CA')} /></label>
      <label>{t('schedule.time')}<input name="time" type="time" required defaultValue={cadence?.kind === 'calendar' ? cadence.time : '09:00'} /></label>
      <fieldset><legend>{t('schedule.weekdays')}</legend>{[1, 2, 3, 4, 5, 6, 7].map(day => <label className="dt-mission-check" key={day}>
        <input type="checkbox" name="weekday" value={day} defaultChecked={cadence?.kind === 'calendar' ? cadence.weekdays.includes(day) : true} />
        {new Intl.DateTimeFormat(t('lang'), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 10, 8 + day)))}</label>)}</fieldset>
      <p>{t('schedule.dst')}</p></> : <>
      <label>{t('schedule.instant')}<input name="instant" required placeholder="2026-11-10T14:00:00Z" defaultValue={cadence?.kind === 'once' ? cadence.at : cadence?.kind === 'interval' ? cadence.start : new Date(Date.now() + 3600000).toISOString()} /></label>
      {kind === 'interval' && <label>{t('schedule.minutes')}<input name="minutes" type="number" min={1} max={525600} required defaultValue={cadence?.kind === 'interval' ? cadence.everyMinutes : 60} /></label>}</>}
    <label>{t('schedule.missed')}<select name="missed" defaultValue={existing?.definition.missed ?? 'latest'}>
      <option value="skip">{t('schedule.skip')}</option><option value="latest">{t('schedule.latest')}</option><option value="all">{t('schedule.catchUp')}</option></select></label>
    <label>{t('schedule.grace')}<input name="grace" type="number" min={1} max={3600} required defaultValue={existing?.definition.graceSeconds ?? 60} /></label>
    <label>{t('schedule.maxRuns')}<input name="maxRuns" type="number" min={1} max={10000} required defaultValue={existing?.definition.maxRuns ?? 30} /></label>
    <label>{t('schedule.maxOpen')}<input name="maxOpen" type="number" min={1} max={20} required defaultValue={existing?.definition.maxOpen ?? 1} /></label>
    <p>{t('schedule.limits')}</p><label className="dt-mission-check"><input name="enabled" type="checkbox" defaultChecked={existing?.enabled ?? false} />{t('schedule.authorize')}</label>
    {command.error && <p role="alert">{command.error}{command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('schedule.retryRequest')}</Button>}</p>}
    <Button type="submit" variant="primary" disabled={command.busy || !plan.actions.length}>{t(existing ? 'schedule.save' : 'schedule.create')}</Button>
  </form>
}
