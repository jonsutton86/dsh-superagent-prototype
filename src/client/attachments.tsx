/** Resumable operator uploads and authenticated previews/downloads. Uploading never submits a task. */
import { useEffect, useRef, useState } from 'react'
import { Button } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import type { AttachmentCapabilities, AttachmentView, UploadView } from '../attachments/model.ts'

function bytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(new Error('Could not read the selected file')); reader.readAsArrayBuffer(blob) })
}
function base64(data: ArrayBuffer): string { let text = ''; for (const byte of new Uint8Array(data)) text += String.fromCharCode(byte); return btoa(text) }
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
interface Selection { id: string; file: File; received: number; ready?: UploadView; error?: string }
export function AttachmentPicker({ disabled, reset, onChange }: { disabled: boolean; reset: number; onChange(ids: string[], busy: boolean): void }) {
  const { t, call } = usePanel(), { restarts } = usePanelData(), [capabilities, setCapabilities] = useState<AttachmentCapabilities>()
  const [items, setItems] = useState<Selection[]>([]), [error, setError] = useState('')
  const mounted = useRef(true), selected = useRef(items), active = useRef(new Map<string, AbortController>()), changed = useRef(onChange)
  selected.current = items; changed.current = onChange
  const cancel = (id: string) => { active.current.get(id)?.abort(); active.current.delete(id); void call('POST uploads/:id/cancel', { id }).catch(() => {}) }
  useEffect(() => {
    let current = true
    void call('GET uploads').then(value => { if (current) setCapabilities(value) }).catch(() => {})
    return () => { current = false }
  }, [call, restarts])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const item of selected.current) cancel(item.id) } }, [call])
  useEffect(() => { for (const item of selected.current) cancel(item.id); selected.current = []; setItems([]); setError('') }, [reset])
  useEffect(() => changed.current(items.flatMap(item => item.ready ? [item.id] : []), items.some(item => !item.ready)), [items])
  const update = (id: string, patch: Partial<Selection>) => { if (mounted.current) setItems(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item)) }
  const upload = async (item: Selection) => {
    if (!capabilities || active.current.has(item.id)) return
    const controller = new AbortController(); active.current.set(item.id, controller); update(item.id, { error: undefined })
    try {
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await bytes(item.file)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      controller.signal.throwIfAborted()
      let state = await call('POST uploads', { body: { requestId: item.id, name: item.file.name, bytes: item.file.size, sha256: digest, mediaType: item.file.type || 'application/octet-stream' } })
      controller.signal.throwIfAborted()
      if (state.phase !== 'receiving' && state.phase !== 'ready') throw new Error(t('attachment.cancelled'))
      while (state.phase === 'receiving' && state.received < item.file.size) {
        const offset = state.received, data = base64(await bytes(item.file.slice(offset, offset + capabilities.chunkBytes)))
        controller.signal.throwIfAborted()
        state = await call('POST uploads/:id/chunks', { id: item.id, body: { offset, data } })
        controller.signal.throwIfAborted(); update(item.id, { received: state.received })
      }
      if (state.phase !== 'ready') state = await call('POST uploads/:id/finish', { id: item.id })
      controller.signal.throwIfAborted(); update(item.id, { ready: state, received: state.received })
    } catch (failure) { if (!controller.signal.aborted) update(item.id, { error: errorText(failure) }) }
    finally { if (active.current.get(item.id) === controller) active.current.delete(item.id); if (controller.signal.aborted) void call('POST uploads/:id/cancel', { id: item.id }).catch(() => {}) }
  }
  const add = async (files: File[]) => {
    if (!capabilities) return
    if (items.length + files.length > capabilities.perMessage || files.some(file => file.size > capabilities.fileBytes)
      || [...items.map(item => item.file), ...files].reduce((sum, file) => sum + file.size, 0) > capabilities.messageBytes) { setError(t('attachment.limit')); return }
    const next = files.map(file => ({ id: crypto.randomUUID(), file, received: 0 })); setError(''); selected.current = [...selected.current, ...next]; setItems(selected.current)
    // Hash and upload one file at a time to bound browser memory.
    for (const item of next) { if (!mounted.current) break; if (selected.current.some(value => value.id === item.id)) await upload(item) }
  }
  if (!capabilities?.available) return null
  return <div className="dt-attachments"><label>{t('attachment.add')}
    <input type="file" multiple disabled={disabled || items.some(item => !item.ready && !item.error)} onChange={event => {
      const files = Array.from(event.target.files ?? []); event.target.value = ''; void add(files)
    }} /></label>
    <p className="dt-hint">{t('attachment.hint', { count: capabilities.perMessage, size: size(capabilities.fileBytes) })}</p>
    {error && <p role="alert">{error}</p>}
    <ul>{items.map(item => <li key={item.id}><span>{item.file.name} ({size(item.file.size)}) — {item.ready ? t('attachment.ready') : `${Math.min(100, Math.floor(item.received / Math.max(1, item.file.size) * 100))}%`}</span>
      {item.error && <span role="alert">{item.error}<Button disabled={disabled || active.current.size > 0} onClick={() => { void upload(item) }}>{t('attachment.retry')}</Button></span>}
      <Button disabled={disabled} onClick={() => { cancel(item.id); selected.current = selected.current.filter(value => value.id !== item.id); setItems(selected.current) }}>{t('attachment.remove')}</Button>
    </li>)}</ul>
  </div>
}
export function AttachmentCard({ file }: { file: AttachmentView }) {
  const { t } = usePanel(), [preview, setPreview] = useState<string>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const controller = useRef<AbortController>(), objectUrl = useRef<string>(), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current) } }, [])
  const read = async (image: boolean) => {
    if (controller.current) return
    const abort = controller.current = new AbortController(); setBusy(true); setError('')
    try {
      const response = await fetch(`/orchestrator/api/uploads/${file.id}/${image ? 'image' : 'download'}`, { headers: { 'x-orchestrator-request': '1' }, signal: abort.signal })
      if (!response.ok) throw new Error(t('attachment.unavailable'))
      const content = await response.blob(); abort.signal.throwIfAborted()
      const url = URL.createObjectURL(content)
      if (image) { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = url; setPreview(url) }
      else { const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
    } catch (failure) { if (!abort.signal.aborted && mounted.current) setError(errorText(failure)) }
    finally { if (controller.current === abort) controller.current = undefined; if (mounted.current) setBusy(false) }
  }
  return <div className="dt-attachment-card"><span>{file.name} ({size(file.bytes)})</span>
    <Button disabled={busy} onClick={() => { void read(false) }}>{t('attachment.download')}</Button>
    {file.image && <Button disabled={busy} onClick={() => { void read(true) }}>{t('attachment.preview')}</Button>}
    {preview && <img src={preview} alt={file.name} />}{error && <p role="alert">{error}</p>}
  </div>
}
