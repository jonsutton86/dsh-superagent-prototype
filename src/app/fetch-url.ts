/** One bounded public GET. No credentials, no request body, and no redirect off the caller's allowlist. */
const LIMIT = 256 * 1024
const HOPS = 3
const TEXT = /^(text\/[a-z0-9.+-]*|application\/(json|xml|javascript|xhtml\+xml|yaml|x-yaml))(\s*;.*)?$/i

/** A public fetch the operator did not allow. The message is safe to show to the model. */
export class FetchRefused extends Error {}

export function httpsUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new FetchRefused('Fetch requires an https URL') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new FetchRefused('Fetch requires an https URL without credentials')
  return url
}

/** True when `url` is an allowlist prefix or the exact URL written in an operator message. */
export function fetchPermitted(url: URL, allowlist: readonly string[], operatorTexts: readonly string[]): boolean {
  const href = url.href
  if (allowlist.some(prefix => href.startsWith(prefix))) return true
  for (const text of operatorTexts) {
    for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
      try { if (new URL(match[0]).href === href) return true } catch { /* skip a fragment the message did not write as a URL */ }
    }
  }
  return false
}

export async function fetchPublic(input: string, allow: (url: URL) => boolean, signal?: AbortSignal): Promise<{ url: string; status: number; retrievedAt: string; content: string }> {
  let current = httpsUrl(input)
  if (!allow(current)) throw new FetchRefused('That URL is not on the operator allowlist and was not written in an operator message')
  const timeout = AbortSignal.timeout(15_000)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  for (let hop = 0; hop <= HOPS; hop++) {
    const response = await fetch(current, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: stop,
      headers: { accept: 'text/plain, text/markdown, application/json, application/xml' } })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel?.()
      if (!location || hop === HOPS) throw new FetchRefused('Fetch redirect is missing or too long')
      const next = httpsUrl(new URL(location, current).href)
      if (!allow(next)) throw new FetchRefused('Fetch redirect left the allowed URLs')
      current = next
      continue
    }
    const type = response.headers.get('content-type') ?? ''
    if (!TEXT.test(type)) throw new FetchRefused('Fetch only returns text')
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > LIMIT) { await reader.cancel(); throw new FetchRefused('Fetch response exceeds 256 KiB') }
        chunks.push(part.value)
      }
    }
    return { url: current.href, status: response.status, retrievedAt: new Date().toISOString(), content: Buffer.concat(chunks).toString('utf8') }
  }
  throw new FetchRefused('Fetch redirect is missing or too long')
}
