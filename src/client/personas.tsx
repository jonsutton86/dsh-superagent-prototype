import { useState, type FormEvent } from 'react'
import type { PersonaDefinition, PersonaRecord, PersonaRef, PersonaVersion } from '../personas/model.ts'
import { Button } from './controls.tsx'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { useOperatorCommand } from './operator-command.ts'
import { When } from './widgets.tsx'

const capabilities: PersonaDefinition['capabilities'] = ['read', 'write', 'commands', 'web', 'delegation', 'skills']
const initial: PersonaDefinition = { name: '', description: '', instructions: '', model: null, capabilities, skills: [] }
const reference = (value: PersonaRef) => `${value.id}:${value.version}`

/** Select an immutable version; catalog refreshes never replace an already selected reference with the latest version. */
export function PersonaSelector({ value, change }: { value?: PersonaRef; change: (value: PersonaRef | undefined) => void }) {
  const { call, t } = usePanel(), [q, setQuery] = useState(''), [offset, setOffset] = useState(0)
  const { data, error } = usePoll(() => call('GET personas', { query: { q, offset, active: 'true' } }), [call, q, offset])
  const selected = value ? reference(value) : ''
  return <div>
    <label>{t('persona.search')}<input type="search" value={q} maxLength={160} onChange={event => { setQuery(event.target.value); setOffset(0) }} /></label>
    <label>{t('persona.select')}<select value={selected} onChange={event => {
      const [id, version] = event.target.value.split(':'); change(id ? { id, version: Number(version) } : undefined)
    }}><option value="">{t('persona.default')}</option>
      {selected && !data?.items.some(item => reference(item) === selected) && <option value={selected}>{value!.id} · {t('persona.version', { version: value!.version })}</option>}
      {data?.items.map(item => <option key={item.id} value={reference(item)}>{item.name} · {t('persona.version', { version: item.version })}</option>)}
    </select></label>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {!!(offset || data?.nextOffset) && <div className="dt-mission-buttons"><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>{t('mission.previous')}</Button>
      <Button disabled={data?.nextOffset == null} onClick={() => setOffset(data!.nextOffset!)}>{t('mission.next')}</Button></div>}
    <p className="dt-hint">{t('persona.pinHint')}</p>
  </div>
}
function CommandError({ command }: { command: ReturnType<typeof useOperatorCommand> }) {
  const { t } = usePanel()
  return command.error ? <p role="alert" className="dt-error">{command.error}
    {command.retry && <Button disabled={command.busy} onClick={() => { void command.retry?.() }}>{t('environment.retry')}</Button>}</p> : null
}
function PersonaForm({ record, restored, saved, cancel }: { record?: PersonaRecord; restored?: PersonaDefinition; saved: (record: PersonaRecord) => void; cancel: () => void }) {
  const { call, t } = usePanel(), [definition, setDefinition] = useState<PersonaDefinition>(restored ?? record?.definition ?? initial)
  const command = useOperatorCommand(() => {})
  const model = (field: 'provider' | 'model' | 'reasoningEffort', value: string) => setDefinition(current => {
    const next = { provider: '', model: '', ...current.model, [field]: value }
    if (!next.reasoningEffort) delete next.reasoningEffort
    return { ...current, model: next.provider || next.model || next.reasoningEffort ? next : null }
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void command.run({ id: record?.id, revision: record?.revision, definition }, async requestId => {
      saved(record ? await call('PUT personas/:id', { id: record.id, body: { requestId, revision: record.revision, definition } })
        : await call('POST personas', { body: { requestId, definition } }))
    })
  }
  return <form className="dt-mission-form" onSubmit={submit}>
    <label>{t('persona.name')}<input value={definition.name} required maxLength={160} onChange={event => setDefinition({ ...definition, name: event.target.value })} /></label>
    <label>{t('persona.description')}<textarea value={definition.description} maxLength={2000} rows={2} onChange={event => setDefinition({ ...definition, description: event.target.value })} /></label>
    <label>{t('persona.instructions')}<textarea value={definition.instructions} required maxLength={12000} rows={5} onChange={event => setDefinition({ ...definition, instructions: event.target.value })} /></label>
    <fieldset><legend>{t('persona.model')}</legend><p className="dt-hint">{t('persona.modelHint')}</p>
      <label>{t('persona.provider')}<input value={definition.model?.provider ?? ''} required={!!definition.model} onChange={event => model('provider', event.target.value)} /></label>
      <label>{t('persona.modelId')}<input value={definition.model?.model ?? ''} required={!!definition.model} onChange={event => model('model', event.target.value)} /></label>
      <label>{t('persona.reasoning')}<input value={definition.model?.reasoningEffort ?? ''} onChange={event => model('reasoningEffort', event.target.value)} /></label>
    </fieldset>
    <fieldset><legend>{t('persona.capabilities')}</legend><p className="dt-hint">{t('persona.capabilityHint')}</p>
      {capabilities.map(capability => <label key={capability}><input type="checkbox" checked={definition.capabilities.includes(capability)}
        onChange={event => setDefinition({ ...definition, capabilities: event.target.checked ? [...definition.capabilities, capability] : definition.capabilities.filter(item => item !== capability) })} />{t(`persona.capability.${capability}`)}</label>)}
    </fieldset>
    <fieldset><legend>{t('persona.skills')}</legend>
      {definition.skills.map((skill, index) => <fieldset key={index}><legend>{skill.name || t('persona.skillName')}</legend>
        {(['name', 'description', 'content'] as const).map(field => <label key={field}>{t(field === 'name' ? 'persona.skillName' : field === 'description' ? 'persona.description' : 'persona.skillContent')}
          <textarea rows={field === 'content' ? 4 : 1} required maxLength={field === 'name' ? 64 : field === 'description' ? 300 : 12000} value={skill[field]}
            onChange={event => setDefinition({ ...definition, skills: definition.skills.map((item, i) => i === index ? { ...item, [field]: event.target.value } : item) })} /></label>)}
        <Button onClick={() => setDefinition({ ...definition, skills: definition.skills.filter((_, i) => i !== index) })}>{t('persona.removeSkill')}</Button>
      </fieldset>)}
      <Button disabled={!definition.capabilities.includes('skills') || definition.skills.length >= 32} onClick={() => setDefinition({ ...definition,
        skills: [...definition.skills, { name: '', description: '', content: '' }] })}>{t('persona.addSkill')}</Button>
    </fieldset>
    <CommandError command={command} />
    <Button type="submit" disabled={command.busy}>{t(record ? 'persona.saveVersion' : 'persona.create')}</Button><Button disabled={command.busy} onClick={cancel}>{t('cancel')}</Button>
  </form>
}
function PersonaPreview({ version }: { version: PersonaVersion }) {
  const { t } = usePanel(), { definition } = version
  return <div><h4>{definition.name} · {t('persona.version', { version: version.version })}</h4><p>{definition.description}</p>
    <p className="dt-mission-prose">{definition.instructions}</p><p>{t('persona.capabilities')}: {definition.capabilities.map(item => t(`persona.capability.${item}`)).join(', ') || t('persona.none')}</p>
    <p>{t('persona.model')}: {definition.model ? `${definition.model.provider}/${definition.model.model}` : t('persona.modelDefault')}</p>
    {definition.skills.map(skill => <details key={skill.name}><summary>{skill.name} · {skill.description}</summary><pre>{skill.content}</pre></details>)}
    <p className="dt-hint"><code>{version.digest}</code> · <When at={version.createdAt} /></p>
  </div>
}
function PersonaDetail({ id, changed }: { id: string; changed: () => void }) {
  const { call, t, navigate } = usePanel(), { data: record, error, reload } = usePoll(() => call('GET personas/:id', { id }), [call, id])
  const [editing, setEditing] = useState<{ key: string; record: PersonaRecord; definition?: PersonaDefinition }>(), [historical, setHistorical] = useState<PersonaVersion>(), [reason, setReason] = useState('')
  const command = useOperatorCommand(() => { void reload(); changed() })
  if (!record) return <p role={error ? 'alert' : 'status'}>{error?.message ?? t('loading')}</p>
  const archive = (event: FormEvent) => {
    event.preventDefault(); const body = { revision: record.revision, archived: !record.archived, reason }
    void command.run(body, requestId => call('POST personas/:id/archive', { id, body: { ...body, requestId } }))
  }
  const history = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const version = String(new FormData(event.currentTarget).get('version'))
    void command.run({ history: version }, async () => setHistorical(await call('GET personas/:id/versions/:version', { id, version })))
  }
  return <article className="dt-mission-card"><p><code>{id}</code> · {t(record.archived ? 'persona.archived' : 'persona.available')}</p>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    <PersonaPreview version={record} />
    <Button onClick={() => navigate({ page: 'usage', query: { scope: 'persona', subject: id } })}>{t('usage.limits')}</Button>
    {editing ? <PersonaForm key={editing.key} record={editing.record} restored={editing.definition} saved={() => { setEditing(undefined); void reload(); changed() }} cancel={() => setEditing(undefined)} />
      : <Button onClick={() => setEditing({ key: crypto.randomUUID(), record })}>{t('persona.edit')}</Button>}
    <form className="dt-mission-form" onSubmit={history}>
      <label>{t('persona.history')}<input type="number" name="version" min={1} max={record.version} defaultValue={record.version} required /></label>
      <Button type="submit" disabled={command.busy}>{t('persona.viewVersion')}</Button>
    </form>
    {historical && <section><PersonaPreview version={historical} /><Button onClick={() => setEditing({ key: crypto.randomUUID(), record, definition: historical.definition })}>{t('persona.restoreDraft')}</Button></section>}
    <form className="dt-mission-form" onSubmit={archive}><p className="dt-hint">{t('persona.archiveHint')}</p>
      <label>{t('persona.reason')}<textarea value={reason} onChange={event => setReason(event.target.value)} rows={2} required maxLength={2000} /></label>
      <Button type="submit" disabled={command.busy || !reason.trim()}>{t(record.archived ? 'persona.restore' : 'persona.archive')}</Button>
    </form><CommandError command={command} />
  </article>
}

/** Operator management for immutable persona versions, model preferences, optional tool capabilities and embedded skills. */
export function PersonasPage() {
  const { call, t } = usePanel(), [offset, setOffset] = useState(0), [q, setQuery] = useState(''), [creating, setCreating] = useState(false), [selected, setSelected] = useState<string>()
  const { data, error, reload } = usePoll(() => call('GET personas', { query: { offset, q } }), [call, offset, q])
  return <section className="dt-missions"><h2>{t('tab.personas')}</h2><p>{t('persona.intro')}</p>
    <Button onClick={() => setCreating(!creating)}>{t(creating ? 'cancel' : 'persona.new')}</Button>
    {creating && <PersonaForm saved={record => { setCreating(false); setSelected(record.id); void reload() }} cancel={() => setCreating(false)} />}
    <label>{t('persona.search')}<input type="search" maxLength={160} value={q} onChange={event => { setQuery(event.target.value); setOffset(0) }} /></label>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    <div className="dt-mission-buttons">{data?.items.map(item => <Button key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
      {item.name} · {t('persona.version', { version: item.version })} {item.archived && `· ${t('persona.archived')}`}</Button>)}</div>
    {!!(offset || data?.nextOffset) && <div className="dt-mission-buttons"><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>{t('mission.previous')}</Button>
      <Button disabled={data?.nextOffset == null} onClick={() => setOffset(data!.nextOffset!)}>{t('mission.next')}</Button></div>}
    {selected && <PersonaDetail key={selected} id={selected} changed={() => { void reload() }} />}
  </section>
}
