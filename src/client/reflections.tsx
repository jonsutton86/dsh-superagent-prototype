import { useState, type FormEvent } from 'react'
import type { ReflectionProposal, ReflectionView } from '../workspace/reflection-model.ts'
import type { PlanDefinition } from '../workspace/plan-model.ts'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Button } from './controls.tsx'
import { useOperatorCommand } from './operator-command.ts'
import { NewReflectionSchedule } from './schedules.tsx'

export function ReflectionsPage({ id }: { id?: string }) {
  return id ? <ReflectionDetail id={id} /> : <ReflectionList />
}
function ReflectionList() {
  const { call, navigate, t } = usePanel(), [offset, setOffset] = useState(0), [creating, setCreating] = useState(false)
  const { data, error, reload } = usePoll(() => call('GET reflections', { query: { offset } }), [call, offset])
  return <section className="dt-missions"><h2>{t('tab.reflections')}</h2><p>{t('reflection.intro')}</p>
    <Button onClick={() => setCreating(!creating)}>{t(creating ? 'cancel' : 'reflection.new')}</Button>
    {creating && <NewReflectionSchedule />}
    {error && <p role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && !data.items.length && <p>{t('reflection.empty')}</p>}
    <div className="dt-mission-grid">{data?.items.map(run => <button type="button" className="dt-mission-card" key={run.id}
      onClick={() => navigate({ page: 'reflections', id: run.id })}><h3>{new Date(run.capturedAt).toLocaleString()}</h3>
      <p>{run.pending} {t('reflection.pending')} · {run.bytes.toLocaleString()} {t('recall.bytes')}</p></button>)}</div>
    {offset > 0 && <Button onClick={() => setOffset(offset - 30)}>{t('mission.previous')}</Button>}
    {data?.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}
  </section>
}
function ReflectionDetail({ id }: { id: string }) {
  const { call, navigate, t } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET reflections/:id', { id }), [call, id])
  return <section className="dt-missions"><Button onClick={() => navigate({ page: 'reflections' })}>{t('tab.reflections')}</Button>
    <h2>{t('reflection.review')}</h2><p>{t('reflection.intro')}</p>
    {error && <p role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && <><p>{new Date(data.capturedAt).toLocaleString()} · {data.bytes.toLocaleString()} {t('recall.bytes')}</p>
      <Button onClick={() => navigate({ page: 'schedules', id: data.scheduleId })}>{t('schedule.origin')}</Button>
      <Button onClick={() => navigate({ page: 'missions', id: data.missionId })}>{t('schedule.viewMission')}</Button>
      <details><summary>{t('reflection.context')}</summary><p>{data.snapshot.guidance}</p>
        <p>{t('reflection.since')}: {new Date(data.snapshot.since).toLocaleString()}</p><code>{data.snapshotHash}</code>
        <p>{t('reflection.omitted')}: {data.snapshot.omissions.missions} {t('tab.missions')}, {data.snapshot.omissions.records} {t('tab.library')},
          {' '}{data.snapshot.omissions.unavailable} {t('reflection.unavailable')}, {data.snapshot.omissions.partialRecords} {t('reflection.partial')}</p>
        {data.snapshot.omissions.selectionStopped && <p>{t('reflection.stopped')}</p>}
        {data.snapshot.missions.map(({ value }) => <details key={value.id}><summary>{value.title}</summary>
          <PlanPreview plan={value} /><ul>{value.actions.map(action => <li key={action.id}>{action.title}: {t(`mission.${action.status}`)}
            {action.ticket?.summary && <p>{action.ticket.summary}</p>}</li>)}</ul>
          <ul>{value.events.map(event => <li key={event.id}>{event.at}: {event.text}</li>)}</ul>
          <Button onClick={() => navigate({ page: 'missions', id: value.id })}>{t('reflection.currentMission')}</Button></details>)}
        {data.snapshot.records.map(({ value }) => <details key={value.id}><summary>{value.title}</summary><p>{value.summary}</p>
          <p>{t('library.unverified')}</p><pre className="dt-library-excerpt">{value.content}</pre>
          {value.nextOffset !== null && <p>{t('library.excerpt')}</p>}
          <Button onClick={() => navigate({ page: 'library', id: value.id })}>{t('reflection.currentRecord')}</Button></details>)}
      </details><h3>{t('reflection.proposals')}</h3>
      {!data.proposals.length && <p>{t('reflection.noProposals')}</p>}
      {data.proposals.map(proposal => <Proposal key={`${proposal.id}:${proposal.revision}`} proposal={proposal} run={data} done={() => { void reload() }} />)}</>}
  </section>
}
function PlanPreview({ plan }: { plan: PlanDefinition }) {
  const { t } = usePanel()
  return <><h4>{plan.title}</h4><p>{plan.objective}</p><p>{plan.acceptance}</p><ol>{plan.actions.map(action => <li key={action.id}>
    <strong>{action.title}</strong> ({t(action.owner === 'agent' ? 'mission.agent' : 'mission.person')})<p>{action.instructions}</p>
    {!!action.dependsOn.length && <p>{t('mission.dependencies')}: {action.dependsOn.map(id => plan.actions.find(item => item.id === id)?.title).join(', ')}</p>}
    {action.persona && <p>{t('tab.personas')}: {action.persona.id} / {action.persona.version}</p>}
    {action.environment && <p>{t('tab.environments')}: {action.environment}</p>}</li>)}</ol></>
}
function Proposal({ proposal, run, done }: { proposal: ReflectionProposal; run: ReflectionView; done: () => void }) {
  const { call, navigate, t } = usePanel(), command = useOperatorCommand(done), [decision, setDecision] = useState<'approve' | 'reject'>('approve')
  const candidate = proposal.candidate
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = { revision: proposal.revision, decision, note: String(new FormData(event.currentTarget).get('note') ?? '') }
    void command.run({ id: run.id, proposal: proposal.id, body }, requestId => call('POST reflections/:id/proposals/:proposal/review', {
      id: run.id, proposal: proposal.id, body: { ...body, requestId } }))
  }
  return <article className="dt-mission-card"><h4>{t(`reflection.kind.${candidate.kind}`)} · {t(`reflection.status.${proposal.status}`)}</h4>
    <p>{proposal.rationale}</p><Button onClick={() => navigate({ page: 'inbox', id: proposal.ticketId })}>{t('inbox.conversation')}</Button>
    <p>{t('reflection.evidence')}</p><ul>
      {proposal.evidence.missions.map(id => <li key={id}>{run.snapshot.missions.find(item => item.value.id === id)?.value.title}</li>)}
      {proposal.evidence.records.map(id => <li key={id}>{run.snapshot.records.find(item => item.value.id === id)?.value.title}</li>)}</ul>
    {'missionId' in candidate && candidate.missionId && <p>{t('reflection.target')}: {run.snapshot.missions.find(item => item.value.id === candidate.missionId)?.value.title}</p>}
    {candidate.kind === 'memory' ? <><h4>{candidate.title}</h4><p>{candidate.summary}</p><pre className="dt-library-excerpt">{candidate.content}</pre>
      <p>{t(candidate.missionId ? 'reflection.missionMemory' : 'reflection.sharedMemory')}</p></> : <PlanPreview plan={candidate.plan} />}
    {proposal.review && <p>{proposal.review.note} · {new Date(proposal.review.at).toLocaleString()}</p>}
    {proposal.review?.result && <Button onClick={() => { const result = proposal.review!.result!; navigate({ page: result.kind === 'memory' ? 'library' : 'missions', id: result.id }) }}>{t('reflection.result')}</Button>}
    {proposal.status === 'pending' && <form onSubmit={submit}><p>{t('reflection.approval')}</p>
      <label>{t('reflection.decision')}<select value={decision} onChange={event => setDecision(event.target.value as 'approve' | 'reject')}>
        <option value="approve">{t('reflection.approve')}</option><option value="reject">{t('reflection.reject')}</option></select></label>
      <label>{t('reflection.note')}<textarea name="note" required maxLength={4000} /></label>
      {command.error && <p role="alert">{command.error}{command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('schedule.retryRequest')}</Button>}</p>}
      <Button type="submit" disabled={command.busy}>{t('reflection.submitReview')}</Button></form>}
  </article>
}
