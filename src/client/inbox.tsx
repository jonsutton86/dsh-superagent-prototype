/** Unified operator inbox and conversation reader over the existing Engine/Harness work path. */
import { useRef, useState, type FormEvent } from 'react'
import { ApiError, usePoll } from './api.ts'
import { Button, Pill } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import { MarkdownLite, When } from './widgets.tsx'
import { INBOX_FILTERS } from '../app/api.ts'
import type { ConversationMessage, InboxFilter, InboxItem, InboxExecutionSelection } from '../workspace/inbox-model.ts'
import { Dictation, SpeakReply, VoiceProvider } from './voice.tsx'
import { AttachmentCard, AttachmentPicker } from './attachments.tsx'
import { InboxTaskSettings, InboxExecutionDetails } from './inbox-settings.tsx'
import { StopHoldNotice } from './stop-recovery.tsx'

function Composer({ send, done, fresh = false, available = true }: {
  send: (text: string, requestId: string, attachments: string[], execution: InboxExecutionSelection) => Promise<InboxItem>; done: (item: InboxItem) => void; fresh?: boolean; available?: boolean
}) {
  const { t } = usePanel(), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const running = useRef(false)
  const [dictating, setDictating] = useState(false)
  const [unapplied, setUnapplied] = useState('')
  const [files, setFiles] = useState<string[]>([]), [uploading, setUploading] = useState(false), [resetUploads, setResetUploads] = useState(0)
  const [execution, setExecution] = useState<InboxExecutionSelection>({}), [settingsReady, setSettingsReady] = useState(!fresh)
  // Keep the original body/revision for ambiguous failures; a later poll must not turn a retry into a second message.
  const pending = useRef<{ fingerprint: string; send: () => Promise<InboxItem> }>()
  const fingerprint = JSON.stringify([text, files, execution]), retryOriginal = pending.current?.fingerprint === fingerprint
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (running.current || dictating || uploading || !text.trim() || (!available || !settingsReady) && !retryOriginal) return
    if (!pending.current || pending.current.fingerprint !== fingerprint) {
      const requestId = crypto.randomUUID(), submitted = text, attachments = [...files], choices = structuredClone(execution)
      pending.current = { fingerprint, send: () => send(submitted, requestId, attachments, choices) }
    }
    running.current = true; setBusy(true); setError('')
    try { const item = await pending.current.send(); pending.current = undefined; setText(''); setResetUploads(value => value + 1); done(item) }
    catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) pending.current = undefined
      setError(errorText(failure))
    } finally { running.current = false; setBusy(false) }
  }
  return <form className="dt-inbox-composer" onSubmit={event => { void submit(event) }}>
    <label>{t(fresh ? 'inbox.task' : 'inbox.reply')}<textarea value={text} onChange={event => setText(event.target.value)}
      required maxLength={12000} rows={3} disabled={busy} /></label>
    {error && <p className="dt-error" role="alert">{error}</p>}
    {fresh && <InboxTaskSettings value={execution} change={setExecution} ready={setSettingsReady} disabled={busy} />}
    {!available && <p role="status">{t('mission.executionUnavailable')}</p>}
    <Dictation disabled={busy} onBusy={setDictating} onText={spoken => {
      const combined = [text, spoken].filter(Boolean).join('\n')
      if (combined.length > 12000) setUnapplied(spoken)
      else { setText(combined); setUnapplied('') }
    }} />
    {unapplied && <label>{t('voice.draftFull')}<textarea readOnly value={unapplied} rows={3} /></label>}
    <AttachmentPicker disabled={busy} reset={resetUploads} onChange={(ids, active) => { setFiles(ids); setUploading(active) }} />
    <Button variant="primary" type="submit" disabled={busy || dictating || uploading || !text.trim() || (!available || !settingsReady) && !retryOriginal}>{t(fresh ? 'inbox.start' : 'inbox.send')}</Button>
  </form>
}

export function InboxPage({ id, filter = 'all', compose = false }: { id?: string; filter?: InboxFilter; compose?: boolean }) {
  return <VoiceProvider key={id ?? 'list'}>{id ? <ConversationPage id={id} /> : <ConversationList filter={filter} compose={compose} />}</VoiceProvider>
}
function ConversationList({ filter, compose }: { filter: InboxFilter; compose: boolean }) {
  const { t, call, navigate } = usePanel(), { state } = usePanelData()
  const [offset, setOffset] = useState(0), [search, setSearch] = useState(''), [query, setQuery] = useState(''), [creating, setCreating] = useState(compose)
  const { data, error, reload } = usePoll(() => call('GET inbox', { query: { filter, q: query, offset } }), [call, filter, query, offset])
  return <section className="dt-inbox">
    <div className="dt-mission-heading"><div><h2>{t('tab.inbox')}</h2><p>{t('inbox.intro')}</p></div>
      <Button variant="primary" onClick={() => { setCreating(!creating); if (compose) navigate({ page: 'inbox', query: { filter } }, true) }}>{t(creating ? 'cancel' : 'inbox.new')}</Button></div>
    {data && <p className="dt-hint">{t('inbox.counts', { unread: data.unread, questions: data.questions, review: data.review })}</p>}
    {creating && <><p className="dt-hint">{t('inbox.newHint')}</p>
      <Composer fresh available={!!state && !state.paused && !state.setup.problem && !!state.environment?.ready}
        send={(text, requestId, attachments, execution) => call('POST inbox', { body: { text, requestId, ...execution, ...(attachments.length ? { attachments } : {}) } })}
        done={item => navigate({ page: 'inbox', id: item.id })} /></>}
    <div className="dt-filters">{INBOX_FILTERS.map(value => <Pill key={value} active={value === filter}
      onClick={() => { setOffset(0); navigate({ page: 'inbox', query: { filter: value } }, true) }}>{t(`inbox.filter.${value}`)}</Pill>)}</div>
    <form className="dt-inbox-search" role="search" onSubmit={event => { event.preventDefault(); setOffset(0); setQuery(search.trim()) }}>
      <label>{t('inbox.search')}<input type="search" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} /></label>
      <Button type="submit">{t('inbox.find')}</Button></form>
    {error && <p className="dt-error" role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && !data.items.length && <div className="dt-mission-empty"><h3>{t('inbox.empty')}</h3><p>{t('inbox.emptyHint')}</p></div>}
    <ul className="dt-inbox-list">{data?.items.map(item => <li key={item.id}>
      <button className="dt-inbox-item" type="button" data-unread={item.unread} onClick={() => navigate({ page: 'inbox', id: item.id })}>
        <span className="dt-inbox-item-head"><strong>{item.title}</strong><span>{t(`inbox.status.${item.status}`)}</span></span>
        <span className="dt-inbox-preview">{item.stopHold ? t('stopHold.title') : item.preview}</span>
        <span className="dt-inbox-item-meta">{item.unread && <b>{t('inbox.unread')}</b>}<span>{item.source}</span><When at={item.at} />
          {item.mission && <span>{item.mission.title}</span>}</span>
      </button></li>)}</ul>
    <div className="dt-mission-buttons">{offset > 0 && <Button onClick={() => setOffset(Math.max(0, offset - 30))}>{t('mission.previous')}</Button>}
      {data?.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}</div>
  </section>
}

function ConversationPage({ id }: { id: string }) {
  const { t, call, navigate, openSession } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET inbox/:id', { id }), [call, id])
  const [older, setOlder] = useState<ConversationMessage[]>([]), [cursor, setCursor] = useState<string | null>()
  const item = data?.item, next = cursor === undefined ? data?.nextBefore : cursor
  const mark = useAction(async () => {
    if (item) await call('POST inbox/:id/read', { id, body: { revision: item.revision } })
  }, { reload })
  const full = useAction(async () => { if (item?.sessionId) await openSession(item.sessionId) })
  const earlier = useAction(async () => {
    if (!next) return
    const page = await call('GET inbox/:id', { id, query: { before: next } })
    setOlder(previous => [...page.messages, ...previous]); setCursor(page.nextBefore)
  })
  const messages = [...new Map([...older, ...data?.messages ?? []].map(message => [message.id, message])).values()]
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  return <section className="dt-inbox">
    <Button variant="ghost" onClick={() => navigate({ page: 'inbox' })}>{t('inbox.all')}</Button>
    {error && <p className="dt-error" role="alert">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && item && <>
      <div className="dt-mission-heading"><h2>{item.title}</h2><span>{t(`inbox.status.${item.status}`)}</span></div>
      <StopHoldNotice hold={item.stopHold} ticketId={id} link />
      {item.execution && <InboxExecutionDetails execution={item.execution} />}
      <div className="dt-mission-buttons">
        {item.unread && <Button disabled={mark.busy} onClick={() => { void mark.run() }}>{t('inbox.markRead')}</Button>}
        {item.mission && <Button onClick={() => navigate({ page: 'missions', id: item.mission!.id })}>{t('inbox.mission')}</Button>}
        <Button onClick={() => navigate({ page: 'library', query: { scope: item.mission ? `mission:${item.mission.id}` : `ticket:${id}` } })}>{t('library.missionRecords')}</Button>
        {item.sessionId && <Button disabled={full.busy} onClick={() => { void full.run() }}>{t('inbox.fullSession')}</Button>}
        <Button onClick={() => navigate({ page: 'execution', id })}>{t('mission.execution')}</Button>
      </div>
      {item.question && <aside className="dt-inbox-question" aria-label={t('inbox.question')}><h3>{t('inbox.question')}</h3><MarkdownLite text={item.question} /></aside>}
      {!data.historyAvailable && <p role="status">{t('inbox.historyUnavailable')}</p>}
      {next && <Button disabled={earlier.busy} onClick={() => { void earlier.run() }}>{t('inbox.earlier')}</Button>}
      <ol className="dt-inbox-messages">{messages.map(message => <li key={message.id} className={`dt-inbox-message dt-inbox-message-${message.role}`}>
        <div className="dt-inbox-item-meta"><strong>{t(`inbox.role.${message.role}`)}</strong><When at={message.at} />
          {message.pending && <span>{t('inbox.pending')}</span>}</div>
        <MarkdownLite text={message.text} />{message.truncated && <p className="dt-hint">{t('inbox.truncated')}</p>}
        {!!message.attachments?.length && <div className="dt-attachments">{message.attachments.map(file => <AttachmentCard key={file.id} file={file} />)}</div>}
        {message.role === 'agent' && <SpeakReply id={message.id} text={message.text} />}
      </li>)}</ol>
      {!!data.artifacts.length && <section><h3>{t('library.missionRecords')}</h3><ul>{data.artifacts.map(artifact => <li key={artifact.id}>
        <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'library', id: artifact.id })}>{artifact.title}</button>
      </li>)}</ul></section>}
      {item.canReply ? <Composer send={(text, requestId, attachments) => call('POST inbox/:id/reply', { id, body: { text, requestId, revision: item.revision, ...(attachments.length ? { attachments } : {}) } })}
        done={() => { void reload() }} /> : <p className="dt-hint">{t('inbox.readOnly')}</p>}
    </>}
  </section>
}
