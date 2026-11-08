import { useRef, useState } from 'react'
import { ApiError } from './api.ts'
import { errorText } from './text.ts'

/** Preserve the submitted revision and request ID when a response is lost after a commit. */
export function useOperatorCommand(changed: () => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), pending = useRef<{ key: string; send: () => Promise<unknown> }>()
  const execute = async () => {
    if (lock.current) return
    if (!pending.current) return
    lock.current = true; setBusy(true); setError('')
    try { await pending.current.send(); pending.current = undefined; changed() }
    catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) pending.current = undefined
      setError(errorText(failure))
    } finally { lock.current = false; setBusy(false) }
  }
  const run = async (identity: unknown, send: (requestId: string) => Promise<unknown>) => {
    if (lock.current) return
    const key = JSON.stringify(identity)
    if (pending.current?.key !== key) { const id = crypto.randomUUID(); pending.current = { key, send: () => send(id) } }
    await execute()
  }
  return { busy, error, run, retry: pending.current ? execute : undefined }
}
