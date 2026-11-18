/** Creative workspace: publish Markdown artifacts through the existing library and review recent ones. */
import { useState } from 'react'
import { Button, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { usePoll } from './api.ts'
import { Hint, Section } from './widgets.tsx'

export function CreativePage() {
  const { t, call, notify } = usePanel(), [version, setVersion] = useState(0)
  const [title, setTitle] = useState(''), [summary, setSummary] = useState(''), [content, setContent] = useState(''), [busy, setBusy] = useState(false)
  const { data, error } = usePoll(() => call('GET library', { query: { kind: 'artifact', limit: 20 } }), [call, version])
  const publish = async (event: { preventDefault(): void }) => {
    event.preventDefault()
    if (!title.trim() || !summary.trim() || !content.trim() || busy) return
    setBusy(true)
    try {
      await call('POST library', { body: { requestId: crypto.randomUUID(), kind: 'artifact', scope: 'workspace',
        title: title.trim(), summary: summary.trim(), mime: 'text/markdown', filename: 'creative.md', encoding: 'utf8', content } })
      setTitle(''); setSummary(''); setContent(''); setVersion(value => value + 1)
    } catch (failure) { notify(String(failure)) } finally { setBusy(false) }
  }
  return <div className="dt-page">
    <Section title={t('creative.publish')}>
      <form onSubmit={publish}>
        <label>{t('creative.title')}<Input value={title} maxLength={160} onChange={event => setTitle(event.target.value)} /></label>
        <label>{t('creative.summary')}<Input value={summary} maxLength={500} onChange={event => setSummary(event.target.value)} /></label>
        <label>{t('creative.content')}<textarea value={content} rows={12} onChange={event => setContent(event.target.value)} /></label>
        <Button type="submit" disabled={busy || !title.trim() || !summary.trim() || !content.trim()}>{t('creative.save')}</Button>
      </form>
    </Section>
    <Section title={t('creative.recent')} count={data?.items.length}>
      {error && <p className="dt-error" role="status">{String(error)}</p>}
      {!data && !error && <Hint>{t('loading')}</Hint>}
      {data && !data.items.length && <Hint>{t('creative.empty')}</Hint>}
      {!!data?.items.length && <ul className="dt-list">{data.items.map(item => <li key={item.id} className="dt-row">
        <div className="dt-row-main"><div className="dt-row-title">{item.title}</div>
          <div className="dt-row-meta"><span>{item.filename}</span><span>{item.bytes} {t('repositoryExport.bytes')}</span><span>{item.createdAt}</span></div>
          <p className="dt-hint">{item.summary}</p></div></li>)}</ul>}
    </Section>
  </div>
}
