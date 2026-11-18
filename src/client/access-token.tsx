/** Operator entry for the management bearer used by this browser; stored only in this origin's localStorage. */
import { useState } from 'react'
import { Button, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Hint } from './widgets.tsx'

const KEY = 'dsh-admin-token'
const read = (): string => { try { return typeof localStorage === 'undefined' ? '' : localStorage.getItem(KEY) ?? '' } catch { return '' } }

export function AdminToken({ onChanged }: { onChanged: () => Promise<unknown> }) {
  const { t } = usePanel(), [value, setValue] = useState(''), [present, setPresent] = useState(() => read().length > 0)
  const save = async () => {
    const token = value.trim()
    if (!token) return
    try { localStorage.setItem(KEY, token) } catch { return }
    setValue(''); setPresent(true); await onChanged()
  }
  const clear = async () => {
    try { localStorage.removeItem(KEY) } catch { /* Storage is optional. */ }
    setPresent(false); await onChanged()
  }
  return <div data-admin-token>
    <Hint>{t('access.tokenHint')}</Hint>
    <p role="status">{present ? t('access.configured') : t('access.notConfigured')}</p>
    <Input type="password" autoComplete="off" value={value} aria-label={t('access.adminToken')} placeholder={t('access.adminToken')}
      onChange={event => setValue(event.target.value)} />
    <Button size="sm" disabled={!value.trim()} onClick={() => void save()}>{t('access.save')}</Button>
    {present && <Button size="sm" variant="outline" onClick={() => void clear()}>{t('access.clear')}</Button>}
  </div>
}
