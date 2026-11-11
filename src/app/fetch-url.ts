/**
 * One bounded public GET. The URL must be on the operator allowlist or written in an operator message.
 * No credentials, no POST, and no redirect that leaves that set. The body stops at 256 KiB.
 */
const MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 15_000
const HOPS = 3
const URLS = /https:\/\/[^\s<>"')\]]+/g

export interface PublicFetch { url: string; status: number; retrieved_at: string; text: string; truncated: boolean; content_type?: string }

/** An https URL with no userinfo, or undefined. */
export function httpsUrl(value: string): URL | undefined {
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined
  url.hash = ''
  return url
}

/** https URLs written in operator text, without a trailing punctuation mark. */
export function urlsIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(URLS)) {
    const url = httpsUrl(match[0].replace(/[.,;:]+$/, ''))
    if (url) found.add(url.href)
  }
  return [...found]
}

function allowed(url: URL, allowlist: readonly string[], operatorUrls: readonly string[]): boolean {
  if (operatorUrls.includes(url.href)) return true
  return allowlist.some(prefix => {
    const base = httpsUrl(prefix)
    if (!base) return false
    if (url.href === base.href) return true
    const stem = base.href.endsWith('/') ? base.href : `${base.href}/`
    return url.href.startsWith(stem)
  })
}

function textual(type: string | null): boolean {
  if (!type) return true
  const mime = type.split(';')[0]!.trim().toLowerCase()
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'application/javascript'
    || mime.endsWith('+json') || mime.endsWith('+xml') || mime === 'application/xhtml+xml'
}

export async function fetchPublic(input: {
  url: string
  allowlist: readonly string[]
  operatorUrls: readonly string[]
  fetch: (url: string, init: RequestInit) => Promise<Response>
  signal?: AbortSignal
  now?: () => string
}): Promise<PublicFetch> {
  let current = httpsUrl(input.url)
  if (!current) throw new Error('Only an https URL with no userinfo can be fetched')
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...input.signal ? [input.signal] : []])
  let response: Response | undefined
  for (let hop = 0; hop < HOPS; hop++) {
    if (!allowed(current, input.allowlist, input.operatorUrls)) throw new Error('This URL is not on the fetch allowlist and was not written in an operator message')
    response = await input.fetch(current.href, { method: 'GET', redirect: 'manual', signal, headers: { accept: 'text/plain, text/html, application/json' } })
    if (response.status < 300 || response.status >= 400) break
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!location) break
    const next = httpsUrl(new URL(location, current).href)
    if (!next) throw new Error('The redirect is not an https URL with no userinfo')
    if (!allowed(next, input.allowlist, input.operatorUrls)) throw new Error('The redirect leaves the allowlist and the operator-supplied URLs')
    current = next
    response = undefined
  }
  if (!response) throw new Error('Too many redirects')
  const retrieved_at = (input.now ?? (() => new Date().toISOString()))()
  const contentType = response.headers.get('content-type')
  if (!textual(contentType)) {
    await response.body?.cancel()
    return { url: current.href, status: response.status, retrieved_at, text: '', truncated: false, ...contentType ? { content_type: contentType } : {} }
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  if (reader) {
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      const value = step.value
      if (!value?.byteLength) continue
      const room = MAX_BYTES - total
      if (value.byteLength > room) {
        chunks.push(value.slice(0, room))
        total += room
        truncated = true
        await reader.cancel()
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { url: current.href, status: response.status, retrieved_at, text: new TextDecoder().decode(bytes), truncated, ...contentType ? { content_type: contentType } : {} }
}
