/** Reviewed task execution choices. Polling never replaces an already selected persona version or default grant. */
import { useEffect } from 'react'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { PersonaSelector } from './personas.tsx'
import { WorldSelector } from './worlds.tsx'
import type { InboxExecution, InboxExecutionSelection } from '../workspace/inbox-model.ts'
import type { PersonaDefinition } from '../personas/model.ts'
import type { ExecutionGrant } from '../core/index.ts'
const sameGrant = (left: ExecutionGrant | undefined, right: ExecutionGrant) => !!left && left.environmentId === right.environmentId
  && left.revision === right.revision && left.epoch === right.epoch && left.world === right.world
function ModelPreference({ model }: { model: PersonaDefinition['model'] }) {
  const { t } = usePanel()
  return <>{model ? [model.provider, model.model].filter(Boolean).join(' / ') || t('persona.modelDefault') : t('persona.modelDefault')}</>
}
export function InboxTaskSettings({ value, change, disabled, ready }: { value: InboxExecutionSelection; change(value: InboxExecutionSelection): void;
  disabled: boolean; ready(value: boolean): void }) {
  const { call, t } = usePanel()
  const setup = usePoll(() => call('GET inbox/setup'), [call])
  const id = value.persona?.id, version = value.persona?.version
  const selection = usePoll(async () => {
    if (!id || !version) return undefined
    const [record, snapshot] = await Promise.all([call('GET personas/:id', { id }), call('GET personas/:id/versions/:version', { id, version: String(version) })])
    return { record, snapshot }
  }, [call, id, version])
  const persona = selection.data && selection.data.snapshot.id === id && selection.data.snapshot.version === version ? selection.data : undefined
  const current = setup.data?.defaultEnvironment
  const defaultReady = !setup.error && current?.available && sameGrant(value.expectedDefault, current.grant)
  const personaReady = !id || !!persona && !persona.record.archived && !selection.error
  useEffect(() => { ready(!!personaReady && (!!value.environment || !!defaultReady)) }, [ready, personaReady, value.environment, defaultReady])
  useEffect(() => {
    if (!disabled && !value.environment && !value.expectedDefault && current?.available && !setup.error)
      change({ ...value, expectedDefault: current.grant })
  }, [change, disabled, value, current, setup.error])
  return <fieldset className="dt-inbox-settings" disabled={disabled}><legend>{t('inbox.settings')}</legend>
    <PersonaSelector value={value.persona} change={persona => change({ ...value, persona })} />
    {id && !persona && !selection.error && <p role="status">{t('loading')}</p>}
    {persona && <div className="dt-inbox-selection"><strong>{persona.snapshot.definition.name} · {t('persona.version', { version: persona.snapshot.version })}</strong>
      <p>{t('persona.model')}: <ModelPreference model={persona.snapshot.definition.model} /></p>
      <p>{t('inbox.capabilities')}: {persona.snapshot.definition.capabilities.map(capability => t(`persona.capability.${capability}`)).join(', ') || t('inbox.noOptionalTools')}</p>
      {persona.record.archived && <p role="alert">{t('inbox.personaUnavailable')}</p>}
    </div>}
    <WorldSelector value={value.environment} change={environment => change({ ...value, environment,
      expectedDefault: !environment && current?.available ? current.grant : undefined })} />
    {!value.environment && <>
      {!current && !setup.error && <p role="status">{t('loading')}</p>}
      {current?.available ? <div className="dt-inbox-selection"><strong>{current.name}</strong><p>{current.root}</p>
        {value.expectedDefault && !sameGrant(value.expectedDefault, current.grant) && <p role="alert">{t('inbox.defaultChanged')}
          <Button onClick={() => change({ ...value, expectedDefault: current.grant })}>{t('inbox.useCurrentDefault')}</Button></p>}
      </div> : current && <p role="status">{t('inbox.chooseEnvironment')}</p>}
    </>}
    {(setup.error && !value.environment || selection.error && id) && <p role="alert">{setup.error && !value.environment ? setup.error.message : selection.error?.message}
      <Button onClick={() => { void Promise.allSettled([setup.reload(), selection.reload()]) }}>{t('mission.refresh')}</Button></p>}
    <p className="dt-hint">{t('inbox.settingsHint')}</p>
  </fieldset>
}
export function InboxExecutionDetails({ execution }: { execution: InboxExecution }) {
  const { t } = usePanel(), persona = execution.persona
  return <details className="dt-inbox-settings"><summary>{t('inbox.taskSettings')}</summary>
    <p>{t('persona.select')}: {persona ? `${persona.name} · ${t('persona.version', { version: persona.version })}` : t('persona.default')}</p>
    <p>{t('persona.model')}: <ModelPreference model={persona?.model ?? null} /></p>
    {persona && <p>{t('inbox.capabilities')}: {persona.capabilities.map(capability => t(`persona.capability.${capability}`)).join(', ') || t('inbox.noOptionalTools')}</p>}
    <p>{t('world.select')}: {execution.environment?.description?.name ?? t('inbox.environmentRecorded')}</p>
    <p>{t('inbox.workingDirectory')}: <code>{execution.directory}</code></p>
    <p className="dt-hint">{t('inbox.executedSettingsHint')}</p>
  </details>
}
