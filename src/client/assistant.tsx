import { Button } from './controls.tsx'
import { ConfirmButton } from './widgets.tsx'
import { usePanel } from './provider.tsx'

/**
 * Action bar for the JARVIS assistant cockpit in the DSH panel.
 *
 * Provides safe navigation to Inbox compose and Missions, opens the master
 * session when available, and uses the confirmed pause/resume control for
 * processing.
 */
export function AssistantActions({ paused, masterId, onChanged }: {
  paused: boolean
  masterId?: string
  onChanged: () => Promise<unknown>
}): JSX.Element {
  const { t, call, navigate, openSession, notify } = usePanel()
  const activeMasterId = typeof masterId === 'string' && masterId.length > 0 ? masterId : undefined

  const openMaster = async () => {
    if (!activeMasterId) return
    try { await openSession(activeMasterId) } catch (error) { notify(String(error)) }
  }

  const togglePaused = async () => {
    await call('POST executor/pause', { body: { paused: !paused } })
    await onChanged()
  }

  return (
    <div className="dt-row-meta" data-assistant-actions>
      <Button variant="ghost" size="sm" onClick={() => navigate({ page: 'inbox', query: { compose: true } })}>{t('inbox.new')}</Button>
      <Button variant="ghost" size="sm" onClick={() => navigate({ page: 'missions' })}>{t('mission.new')}</Button>
      {activeMasterId ? <Button variant="ghost" size="sm" onClick={() => void openMaster()}>{t('openMaster')}</Button> : null}
      <ConfirmButton
        label={t(paused ? 'resumeProcessing' : 'pauseProcessing')}
        title={t(paused ? 'resumeProcessing' : 'pauseProcessing')}
        message={t(paused ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={togglePaused}
        variant="outline"
      />
    </div>
  )
}
