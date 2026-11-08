import { useRef, useState, type FormEvent } from 'react'
import type { MissionView } from '../workspace/model.ts'
import type { PlanDefinition, PlanProposal, PlanVersion } from '../workspace/plan-model.ts'
import { ApiError, usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import { When } from './widgets.tsx'
import { PersonaSelector } from './personas.tsx'

/** Retain the exact request closure across ambiguous responses, including its original revision. */
function usePlanCommand() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const running = useRef(false), pending = useRef<{ identity: string; send: () => Promise<void> }>()
  const run = async (identity: unknown, send: (requestId: string) => Promise<void>) => {
    if (running.current) return
    const key = JSON.stringify(identity)
    if (pending.current?.identity !== key) { const requestId = crypto.randomUUID(); pending.current = { identity: key, send: () => send(requestId) } }
    running.current = true; setBusy(true); setError('')
    try { await pending.current.send(); pending.current = undefined }
    catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) pending.current = undefined
      setError(errorText(failure))
    } finally { running.current = false; setBusy(false) }
  }
  return { busy, error, run }
}
const definition = (mission: MissionView): PlanDefinition => ({ title: mission.title, objective: mission.objective, acceptance: mission.acceptance,
  actions: mission.actions.map(({ id, title, instructions, owner, dependsOn, persona }) => ({ id, title, instructions, owner, dependsOn, ...(persona ? { persona } : {}) })) })

export function MissionPlans({ mission, changed }: { mission: MissionView; changed: () => void }) {
  const { call, t, notify, navigate } = usePanel(), { state } = usePanelData(), id = mission.id
  const [offset, setOffset] = useState(0), [draft, setDraft] = useState<{ key: string; plan: PlanDefinition; baseVersion: number }>()
  const [selected, setSelected] = useState<PlanProposal>(), [historical, setHistorical] = useState<PlanVersion>()
  const [planning, setPlanning] = useState(false), [guidance, setGuidance] = useState(''), [note, setNote] = useState('')
  const { data, error, reload } = usePoll(() => call('GET missions/:id/plans', { id, query: { offset } }), [call, id, offset, mission.planVersion])
  const command = usePlanCommand(), active = mission.status === 'active'
  const refresh = () => { changed(); void reload() }
  const openProposal = (proposal: string) => { void call('GET missions/:id/proposals/:proposal', { id, proposal })
    .then(value => { setSelected(value); setNote(''); setHistorical(undefined) }).catch(failure => notify(errorText(failure))) }
  const edit = (plan: PlanDefinition) => { setDraft({ key: crypto.randomUUID(), plan, baseVersion: mission.planVersion }); setSelected(undefined); setHistorical(undefined) }
  const review = (decision: 'approve' | 'reject') => {
    if (!selected) return
    void command.run({ decision, proposal: selected.id, note }, async requestId => {
      const value = await call('POST missions/:id/proposals/:proposal', { id, proposal: selected.id,
        body: { requestId, revision: selected.revision, missionRevision: mission.revision, decision, note } })
      setSelected(value); refresh()
    })
  }
  return <section className="dt-plans" aria-label={t('plan.heading')}>
    <div className="dt-mission-heading"><h3>{t('plan.version', { version: mission.planVersion })}</h3><div className="dt-mission-buttons">
      {active && <><Button disabled={command.busy} onClick={() => edit(definition(mission))}>{t('plan.edit')}</Button>
        <Button disabled={command.busy} onClick={() => setPlanning(!planning)}>{t('plan.ask')}</Button></>}
    </div></div>
    {(error || command.error) && <p role="alert" className="dt-error">{command.error || error?.message}</p>}
    {planning && active && <form className="dt-mission-form" onSubmit={event => {
      event.preventDefault()
      void command.run({ operation: 'plan-request', guidance }, async requestId => {
        await call('POST missions/:id/plan-request', { id, body: { requestId, revision: mission.revision, instructions: guidance } })
        setPlanning(false); refresh()
      })
    }}><p>{t('plan.requestHint')}</p><label>{t('plan.guidance')}<textarea value={guidance} maxLength={10000} rows={3}
        onChange={event => setGuidance(event.target.value)} /></label>
      <Button type="submit" disabled={command.busy || !state || state.paused || !!state.setup.problem || !state.environment?.ready}>{t('plan.request')}</Button></form>}
    {draft && active && <PlanEditor key={draft.key} initial={draft.plan} busy={command.busy} cancel={() => setDraft(undefined)} submit={(plan, rationale) => {
      void command.run({ operation: 'propose', plan, rationale, baseVersion: draft.baseVersion }, async requestId => {
        const proposal = await call('POST missions/:id/proposals', { id, body: { requestId, plan, rationale, baseVersion: draft.baseVersion } })
        setDraft(undefined); setSelected(proposal); setNote(''); refresh()
      })
    }} />}
    {!!data?.proposals.length && <><h4>{t('plan.proposals')}</h4><ul className="dt-plan-list">{data.proposals.map(proposal => <li key={proposal.id}>
      <Button onClick={() => openProposal(proposal.id)}>{t(`plan.${proposal.status}`)} · {t('plan.base', { version: proposal.baseVersion })}</Button>
      <span>{proposal.author.role === 'worker' ? t('mission.agent') : t('mission.person')} · <When at={proposal.createdAt} /></span><p>{proposal.rationale}</p>
    </li>)}</ul></>}
    {selected && <section className="dt-plan-review"><h4>{t('plan.review')}</h4>
      <p>{selected.rationale}</p><p>{t(`plan.${selected.status}`)} · {t('plan.base', { version: selected.baseVersion })}</p>
      {selected.author.role === 'worker' && <Button onClick={() => navigate({ page: 'inbox', id: selected.author.role === 'worker' ? selected.author.ticketId : '' })}>{t('inbox.conversation')}</Button>}
      {selected.baseVersion !== mission.planVersion && selected.status === 'pending' && <p role="status">{t('plan.stale')}</p>}
      <div className="dt-plan-compare"><details><summary>{t('plan.current')}</summary><PlanPreview plan={definition(mission)} /></details>
        <div><h4>{t('plan.proposed')}</h4><PlanPreview plan={selected.plan} /></div></div>
      {selected.review && <p>{selected.review.note}</p>}
      {active && <Button disabled={command.busy} onClick={() => edit(selected.plan)}>{t('plan.useDraft')}</Button>}
      {selected.status === 'pending' && <form className="dt-mission-form" onSubmit={event => { event.preventDefault(); review('approve') }}>
        <p>{t('plan.approvalHint')}</p><label>{t('plan.reviewNote')}<textarea value={note} onChange={event => setNote(event.target.value)} required maxLength={12000} rows={2} /></label>
        <div className="dt-mission-buttons"><Button type="submit" disabled={command.busy || !active || !note.trim() || selected.baseVersion !== mission.planVersion}>{t('plan.approve')}</Button>
          <Button disabled={command.busy || !note.trim()} onClick={() => review('reject')}>{t('plan.reject')}</Button></div>
      </form>}
    </section>}
    <details><summary>{t('plan.history')}</summary><ul className="dt-plan-list">{data?.versions.map(version => <li key={version.version}>
      <Button onClick={() => { void call('GET missions/:id/plans/:version', { id, version: String(version.version) })
        .then(value => { setHistorical(value); setSelected(undefined) }).catch(failure => notify(errorText(failure))) }}>{t('plan.version', { version: version.version })}</Button>
      <span><When at={version.at} /> · {version.reason}</span>
    </li>)}</ul></details>
    {historical && <section><h4>{t('plan.version', { version: historical.version })}</h4><PlanPreview plan={historical.plan} />
      {active && <Button disabled={command.busy} onClick={() => edit(historical.plan)}>{t('plan.useDraft')}</Button>}</section>}
    <div className="dt-mission-buttons">{offset > 0 && <Button onClick={() => setOffset(Math.max(0, offset - 20))}>{t('mission.previous')}</Button>}
      {data?.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}</div>
  </section>
}

function PlanPreview({ plan }: { plan: PlanDefinition }) {
  const { t } = usePanel()
  return <div className="dt-plan-preview"><h4>{plan.title}</h4><p>{plan.objective}</p><strong>{t('mission.acceptance')}</strong><p>{plan.acceptance}</p>
    <ol>{plan.actions.map(action => <li key={action.id}><strong>{action.title} · {t(`mission.${action.owner}`)}</strong><p>{action.instructions}</p>
      {action.persona && <p>{t('persona.select')}: <code>{action.persona.id}</code> · {t('persona.version', { version: action.persona.version })}</p>}
      {!!action.dependsOn.length && <p>{t('mission.after', { actions: action.dependsOn.map(id => plan.actions.find(item => item.id === id)?.title ?? id).join(', ') })}</p>}</li>)}</ol>
  </div>
}

function PlanEditor({ initial, busy, submit, cancel }: { initial: PlanDefinition; busy: boolean; submit: (plan: PlanDefinition, rationale: string) => void; cancel: () => void }) {
  const { t } = usePanel(), [plan, setPlan] = useState(initial), [rationale, setRationale] = useState('')
  const change = (id: string, update: Partial<PlanDefinition['actions'][number]>) => setPlan(current => ({ ...current,
    actions: current.actions.map(action => action.id === id ? { ...action, ...update } : action) }))
  const save = (event: FormEvent) => { event.preventDefault(); submit(plan, rationale) }
  return <form className="dt-mission-form dt-plan-editor" onSubmit={save}>
    <h4>{t('plan.draft')}</h4><label>{t('mission.title')}<input required maxLength={160} value={plan.title} onChange={event => setPlan({ ...plan, title: event.target.value })} /></label>
    <label>{t('mission.objective')}<textarea required maxLength={12000} rows={3} value={plan.objective} onChange={event => setPlan({ ...plan, objective: event.target.value })} /></label>
    <label>{t('mission.acceptance')}<textarea required maxLength={12000} rows={3} value={plan.acceptance} onChange={event => setPlan({ ...plan, acceptance: event.target.value })} /></label>
    {plan.actions.map(action => <fieldset key={action.id}><legend>{action.title || t('mission.actionTitle')}</legend>
      <label>{t('mission.actionTitle')}<input required maxLength={160} value={action.title} onChange={event => change(action.id, { title: event.target.value })} /></label>
      <label>{t('mission.instructions')}<textarea required maxLength={12000} rows={3} value={action.instructions} onChange={event => change(action.id, { instructions: event.target.value })} /></label>
      <label>{t('mission.owner')}<select value={action.owner} onChange={event => change(action.id, { owner: event.target.value as 'person' | 'agent',
        ...(event.target.value === 'person' ? { persona: undefined } : {}) })}>
        <option value="agent">{t('mission.agent')}</option><option value="person">{t('mission.person')}</option></select></label>
      {action.owner === 'agent' && <PersonaSelector value={action.persona} change={persona => change(action.id, { persona })} />}
      <fieldset><legend>{t('mission.dependencies')}</legend>{plan.actions.filter(item => item.id !== action.id).map(dependency =>
        <label className="dt-mission-check" key={dependency.id}><input type="checkbox" checked={action.dependsOn.includes(dependency.id)}
          onChange={event => change(action.id, { dependsOn: event.target.checked ? [...action.dependsOn, dependency.id] : action.dependsOn.filter(id => id !== dependency.id) })} />{dependency.title}</label>)}</fieldset>
      <Button disabled={busy} onClick={() => setPlan(current => ({ ...current, actions: current.actions.filter(item => item.id !== action.id)
        .map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => id !== action.id) })) }))}>{t('plan.remove')}</Button>
    </fieldset>)}
    <Button disabled={busy || plan.actions.length >= 200} onClick={() => setPlan(current => ({ ...current, actions: [...current.actions,
      { id: crypto.randomUUID(), title: '', instructions: '', owner: 'agent', dependsOn: [] }] }))}>{t('plan.add')}</Button>
    <label>{t('plan.rationale')}<textarea required maxLength={12000} rows={3} value={rationale} onChange={event => setRationale(event.target.value)} /></label>
    <div className="dt-mission-buttons"><Button type="submit" disabled={busy}>{t('plan.submit')}</Button><Button disabled={busy} onClick={cancel}>{t('cancel')}</Button></div>
  </form>
}
