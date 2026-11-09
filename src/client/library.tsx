import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { CreateRecordInput, LibraryContent, LibraryEntry, LibraryRead } from '../workspace/library-model.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { PublicationCard } from './publications.tsx'
import { RecallControls } from './recall.tsx'
import { CheckRegistry, VerificationCard } from './verification.tsx'

/** Library browsing and authoring use the same durable service as Harness worker tools. */
export function LibraryPage({ id, scope }: { id?: string; scope?: string }) {
  return id ? <RecordDetail key={id} id={id} scope={scope} /> : <RecordList key={scope ?? 'all'} scope={scope} />
}
function RecordFlags({ record }: { record: LibraryEntry }) {
  const { t } = usePanel()
  return <div className="dt-library-flags"><span>{t(`library.${record.kind}`)}</span>
    <span>{t(record.provenance.actor === 'worker' ? 'library.agentSubmission' : 'library.operatorSubmission')}</span>
    {(['archived', 'expired', 'superseded', 'conflicted'] as const).filter(flag => record[flag]).map(flag => <strong key={flag}>{t(`library.${flag}`)}</strong>)}
    {!!record.staleSources.length && <strong>{t('library.staleSources')}</strong>}
    {record.freshness && record.freshness.status !== 'current' && <strong>{t(`recall.freshness.${record.freshness.status}`)}</strong>}
  </div>
}
function RecordList({ scope }: { scope?: string }) {
  const { call, navigate, t } = usePanel()
  const [query, setQuery] = useState(''), [draft, setDraft] = useState(''), [kind, setKind] = useState<'memory' | 'artifact' | ''>('')
  const [inactive, setInactive] = useState(false), [offset, setOffset] = useState(0), [creating, setCreating] = useState(false)
  const [recall, setRecall] = useState(false), [checks, setChecks] = useState(false)
  const { data, error, reload } = usePoll(() => call('GET library', { query: { scope, q: query, kind: kind || undefined,
    includeInactive: inactive ? 'true' : 'false', offset } }), [call, scope, query, kind, inactive, offset])
  const open = (record: LibraryEntry) => navigate({ page: 'library', id: record.id, query: { scope } })
  return <section className="dt-library">
    <div className="dt-mission-heading"><div><p className="dt-hint">{t('mission.eyebrow')}</p><h2>{t('tab.library')}</h2>
      <p>{t('library.intro')}</p><p className="dt-hint">{scope ?? t('library.allScopes')}</p></div>
      <Button variant="primary" onClick={() => setCreating(!creating)}>{t(creating ? 'cancel' : 'library.new')}</Button></div>
    {creating && <RecordForm scope={scope ?? 'workspace'} onSaved={open} />}
    <Button aria-expanded={recall} onClick={() => setRecall(!recall)}>{t('recall.title')}</Button>
    {recall && <RecallControls />}
    <Button aria-expanded={checks} onClick={() => setChecks(!checks)}>{t('verification.registry')}</Button>
    {checks && <CheckRegistry />}
    <form className="dt-library-filters" onSubmit={event => { event.preventDefault(); setQuery(draft); setOffset(0) }}>
      <label>{t('library.search')}<input type="search" value={draft} maxLength={256} onChange={event => setDraft(event.target.value)} /></label>
      <label>{t('library.kind')}<select value={kind} onChange={event => { setKind(event.target.value as typeof kind); setOffset(0) }}>
        <option value="">{t('library.allKinds')}</option><option value="memory">{t('library.memory')}</option><option value="artifact">{t('library.artifact')}</option>
      </select></label>
      <label><input type="checkbox" checked={inactive} onChange={event => { setInactive(event.target.checked); setOffset(0) }} />{t('library.inactive')}</label>
      <Button type="submit">{t('library.search')}</Button>
    </form>
    {error && <p role="alert" className="dt-error">{error.message}<Button onClick={() => { void reload() }}>{t('mission.refresh')}</Button></p>}
    {!data && !error && <p role="status">{t('loading')}</p>}
    {data && !data.items.length && <div className="dt-mission-empty"><h3>{t('library.empty')}</h3><p>{t('library.emptyHint')}</p></div>}
    <div className="dt-mission-grid">{data?.items.map(record => <button type="button" key={record.id} className="dt-mission-card" onClick={() => open(record)}>
      <RecordFlags record={record} /><h3>{record.title}</h3><p>{record.summary}</p>
      <span className="dt-hint">{record.filename} · {Math.ceil(record.bytes / 1024)} KiB</span>
    </button>)}</div>
    <div className="dt-mission-buttons">
      {offset > 0 && <Button onClick={() => setOffset(Math.max(0, offset - 20))}>{t('mission.previous')}</Button>}
      {data?.nextOffset != null && <Button onClick={() => setOffset(data.nextOffset!)}>{t('mission.next')}</Button>}
    </div>
  </section>
}

const ACCEPTED_MIME = ['text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/json', 'image/png', 'image/jpeg', 'image/webp', 'application/pdf']
async function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}
function RecordForm({ scope, replaces, onSaved }: { scope: string; replaces?: LibraryRead; onSaved: (record: LibraryEntry) => void }) {
  const { call, t } = usePanel(), [kind, setKind] = useState<'memory' | 'artifact'>(replaces?.kind ?? 'memory')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false), pending = useRef<{ fingerprint: string; requestId: string }>()
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (lock.current) return
    const form = new FormData(event.currentTarget), file = form.get('file') as File | null
    lock.current = true; setBusy(true); setError('')
    try {
      if (file && file.size > 512 * 1024) throw new Error(t('library.fileLimit'))
      const hasFile = kind === 'artifact' && file && file.size > 0
      const mime = hasFile ? (ACCEPTED_MIME.includes(file.type) ? file.type : file.name.endsWith('.md') ? 'text/markdown' : 'application/octet-stream') : 'text/markdown'
      const body: Omit<CreateRecordInput, 'requestId'> = { scope, kind, title: String(form.get('title') ?? ''), summary: String(form.get('summary') ?? ''),
        content: hasFile ? await encodeFile(file) : String(form.get('content') ?? ''), encoding: hasFile ? 'base64' : 'utf8',
        filename: hasFile ? file.name : 'document.md', mime: mime as CreateRecordInput['mime'],
        sources: replaces ? [{ id: replaces.id, relation: 'supersedes' }] : [] }
      const fingerprint = JSON.stringify(body)
      if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() }
      const record = await call('POST library', { body: { ...body, requestId: pending.current.requestId } })
      pending.current = undefined; onSaved(record)
    } catch (failure) { setError(errorText(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <form className="dt-mission-form" onSubmit={event => { void save(event) }}>
    <p className="dt-hint">{t(scope === 'workspace' ? 'library.sharedScope' : 'library.privateScope')}</p>
    {error && <p role="alert" className="dt-error">{error}</p>}
    <label>{t('library.kind')}<select value={kind} disabled={!!replaces} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="memory">{t('library.memory')}</option><option value="artifact">{t('library.artifact')}</option>
    </select></label>
    <label>{t('library.title')}<input name="title" required maxLength={160} defaultValue={replaces?.title} /></label>
    <label>{t('library.summary')}<textarea name="summary" required rows={2} maxLength={500} defaultValue={replaces?.summary} /></label>
    <label>{t('library.content')}<textarea name="content" rows={6} maxLength={65536} /></label>
    {kind === 'artifact' && <label>{t('library.file')}<input type="file" name="file" /><span className="dt-hint">{t('library.fileLimit')}</span></label>}
    <Button type="submit" variant="primary" disabled={busy}>{t('library.save')}</Button>
  </form>
}

/** HTML previews have no script, network, forms, same-origin access or navigation permissions. */
export function sandboxDocument(html: string): string {
  // Parsing inside a template is inert. Remove navigation/resource-bearing tags before any preview is mounted.
  const template = document.createElement('template'); template.innerHTML = html
  const tags = new Set('div p span h1 h2 h3 h4 h5 h6 table tr td th tbody thead tfoot img ol ul li dl dt dd pre code blockquote br hr section article header footer main strong b em i u s small sup sub figure figcaption caption colgroup col style'.split(' '))
  const attributes = new Set('class style id title alt width height colspan rowspan'.split(' '))
  for (const node of template.content.querySelectorAll('*')) {
    if (!tags.has(node.localName)) { node.remove(); continue }
    for (const attribute of [...node.attributes]) {
      const image = node.localName === 'img' && attribute.name === 'src' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(attribute.value)
      if (!attributes.has(attribute.name) && !image) node.removeAttribute(attribute.name)
    }
  }
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">${template.innerHTML}`
}
function ContentPreview({ content, title }: { content: LibraryContent; title: string }) {
  const { t } = usePanel(), [url, setUrl] = useState('')
  const value = useMemo(() => Uint8Array.from(atob(content.data), char => char.charCodeAt(0)), [content.data])
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([value], { type: content.mime }))
    setUrl(objectUrl); return () => URL.revokeObjectURL(objectUrl)
  }, [value, content.mime])
  const text = content.mime.startsWith('text/') || content.mime === 'application/json' ? new TextDecoder().decode(value) : undefined
  return <div className="dt-library-preview">
    {url && <a href={url} download={content.filename}>{t('library.download')}</a>}
    {content.mime === 'text/html' ? <iframe title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxDocument(text ?? '')} />
      : content.mime.startsWith('image/') && url ? <img src={url} alt={title} />
      : text !== undefined ? <pre>{text}</pre> : <p>{t('library.noPreview')}</p>}
  </div>
}
function RecordDetail({ id, scope }: { id: string; scope?: string }) {
  const { call, navigate, t, openSession, notify } = usePanel()
  const { data: record, error, reload } = usePoll(() => call('GET library/:id', { id }), [call, id])
  const [content, setContent] = useState<LibraryContent>(), [failure, setFailure] = useState(''), [busy, setBusy] = useState(false)
  const [replacing, setReplacing] = useState(false), command = useRef<{ fingerprint: string; requestId: string }>(), lock = useRef(false)
  const archive = async () => {
    if (!record || lock.current) return
    lock.current = true; setBusy(true); setFailure('')
    const body = { revision: record.revision, archived: !record.archived }, fingerprint = JSON.stringify(body)
    if (command.current?.fingerprint !== fingerprint) command.current = { fingerprint, requestId: crypto.randomUUID() }
    try { await call('PUT library/:id', { id, body: { ...body, requestId: command.current.requestId } }); command.current = undefined; await reload() }
    catch (error) { setFailure(errorText(error)) }
    finally { lock.current = false; setBusy(false) }
  }
  const preview = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true); setFailure('')
    try { setContent(await call('GET library/:id/content', { id })) }
    catch (error) { setFailure(errorText(error)) }
    finally { lock.current = false; setBusy(false) }
  }
  const link = (target: string) => navigate({ page: 'library', id: target, query: { scope } })
  return <section className="dt-library">
    <Button variant="ghost" onClick={() => navigate({ page: 'library', query: { scope } })}>{t('tab.library')}</Button>
    {(error || failure) && <p role="alert" className="dt-error">{failure || error?.message}</p>}
    {!record && !error && <p role="status">{t('loading')}</p>}
    {record && <><RecordFlags record={record} /><h2>{record.title}</h2><p>{record.summary}</p>
      <p className="dt-hint">{t('library.unverified')}</p>
      <div className="dt-mission-buttons">
        <Button disabled={busy} onClick={() => { void preview() }}>{t('library.preview')}</Button>
        <Button disabled={busy} onClick={() => { void archive() }}>{t(record.archived ? 'library.restore' : 'mission.archive')}</Button>
        <Button onClick={() => setReplacing(!replacing)}>{t(replacing ? 'cancel' : 'library.replace')}</Button>
        {record.scope.startsWith('mission:') && <Button onClick={() => navigate({ page: 'missions', id: record.scope.slice(8) })}>{t('tab.missions')}</Button>}
        {record.provenance.ticketId && <Button onClick={() => navigate({ page: 'execution', id: record.provenance.ticketId! })}>{t('mission.execution')}</Button>}
        {record.reflectionReview && <Button onClick={() => navigate({ page: 'reflections', id: record.reflectionReview!.runId })}>{t('reflection.review')}</Button>}
        {record.provenance.sessionId && <Button onClick={() => { void openSession(record.provenance.sessionId!).catch(error => notify(errorText(error))) }}>{t('mission.chat')}</Button>}
      </div>
      {replacing && <RecordForm scope={record.scope} replaces={record} onSaved={next => link(next.id)} />}
      {content ? <ContentPreview content={content} title={record.title} /> : record.content !== null && <pre className="dt-library-excerpt">{record.content}</pre>}
      {!content && record.nextOffset !== null && <p className="dt-hint">{t('library.excerpt')}</p>}
      {record.kind === 'artifact' && <PublicationCard key={`${record.id}:${record.revision}:${record.hash}`} record={record} />}
      {record.kind === 'artifact' && <VerificationCard key={`verification:${record.id}:${record.revision}:${record.hash}`} record={record} />}
      <details className="dt-library-provenance"><summary>{t('library.provenance')}</summary>
        {record.freshness && <><p>{t(`recall.freshness.${record.freshness.status}`)} · {record.freshness.checked} {t('recall.nodes')}</p>
          <ul>{record.freshness.issues.map((issue, index) => <li key={`${issue.id}:${issue.reason}:${index}`}>
            <Button onClick={() => link(issue.id)}>{t(`recall.reason.${issue.reason}`)}</Button></li>)}</ul></>}
        <dl><dt>{t('library.scope')}</dt><dd>{record.scope}</dd><dt>SHA-256</dt><dd>{record.hash}</dd>
          <dt>{t('library.created')}</dt><dd>{new Date(record.createdAt).toLocaleString()}</dd>
          {record.expiresAt && <><dt>{t('library.expires')}</dt><dd>{new Date(record.expiresAt).toLocaleString()}</dd></>}
          <dt>{t('library.origin')}</dt><dd>{record.provenance.triggerId ?? t('library.operatorSubmission')}</dd>
          {record.provenance.triggerHash && <><dt>{t('library.originHash')}</dt><dd>{record.provenance.triggerHash}</dd></>}
        </dl>
        <h3>{t('library.sources')}</h3><ul>{record.sources.map((edge, index) => <li key={`${edge.id}-${index}`}>
          <Button onClick={() => link(edge.id)}>{edge.relation} · {edge.id}</Button><code>{edge.hash}</code></li>)}</ul>
        <h3>{t('library.related')}</h3><ul>{record.incoming.map((edge, index) => <li key={`${edge.id}-${index}`}>
          <Button onClick={() => link(edge.id)}>{edge.relation} · {edge.id}</Button></li>)}</ul>
        {record.incomingTruncated && <p>{t('library.linkLimit')}</p>}
      </details>
    </>}
  </section>
}
