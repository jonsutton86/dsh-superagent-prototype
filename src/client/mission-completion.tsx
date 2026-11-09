import { useRef, useState } from 'react'
import type { MissionView } from '../workspace/model.ts'
import { usePanel } from './provider.tsx'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { EvidenceReviewStatus } from './verification.tsx'
import { errorText } from './text.ts'

export function MissionCompletionCard({ mission, changed }: { mission: MissionView; changed(value: MissionView): void }) {
  const { call, t } = usePanel(), records = usePoll(() => call('GET missions/:id/completions', { id: mission.id }), [call, mission.id, mission.revision])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [review, setReview] = useState(''), lock = useRef(false)
  const retry = async (id: string) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { changed(await call('POST mission-completions/:id/retry', { id })); await records.reload() }
    catch (failure) { setError(errorText(failure)); await records.reload() }
    finally { lock.current = false; setBusy(false) }
  }
  return <section aria-label={t('missionCompletion.title')}>
    <p>{t('missionCompletion.hint')}</p>
    {(error || records.error) && <p role="alert">{error || records.error?.message}</p>}
    {mission.completion && <p>{t('missionCompletion.recorded')} {new Date(mission.completion.at).toLocaleString()}</p>}
    {records.data?.items.map(attempt => <details key={attempt.id}><summary>{t(`missionCompletion.${attempt.status}`)} · {new Date(attempt.createdAt).toLocaleString()}</summary>
      <code>{attempt.id}</code>{attempt.problem && <p>{attempt.problem}</p>}
      {attempt.status !== 'completed' && <Button disabled={busy || mission.status !== 'active' || mission.revision !== attempt.command.revision || mission.completed !== mission.actions.length}
        onClick={() => { void retry(attempt.id) }}>{t('missionCompletion.resume')}</Button>}
      {attempt.reviews.map(item => <Button key={item.id} onClick={() => setReview(item.id)}>{mission.actions.find(action => action.id === item.actionId)?.title ?? item.actionId}</Button>)}
    </details>)}
    {review && <EvidenceReviewStatus id={review} />}
  </section>
}
