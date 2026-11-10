/** Bounded metadata-only smoke check. Never echoes credentials, raw responses, error messages or request headers. */
import { ABLITERATION_BASE_URL, ABLITERATION_MODELS } from './abliteration-config.ts'

export type AbliterationSmoke = { status: 'not_configured' | 'invalid_credential' | 'request_failed' | 'invalid_response'; httpStatus?: number }
  | { status: 'catalog_received'; models: { id: string; listed: boolean; access: 'available' | 'locked' | 'unknown'; ready: boolean | null }[] }

export async function inspectAbliterationModels(key: string | undefined, request: typeof fetch = fetch): Promise<AbliterationSmoke> {
  if (!key?.trim()) return { status: 'not_configured' }
  if (key !== key.trim() || /[\s\x00-\x1f\x7f]/.test(key)) return { status: 'invalid_credential' }
  try {
    const response = await request(`${ABLITERATION_BASE_URL}/models`, { method: 'GET', headers: { Authorization: `Bearer ${key}` },
      redirect: 'error', signal: AbortSignal.timeout(15_000) })
    if (!response.ok) { await response.body?.cancel(); return { status: 'request_failed', httpStatus: response.status } }
    const reader = response.body?.getReader()
    if (!reader) return { status: 'invalid_response' }
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 1_048_576) { await reader.cancel(); return { status: 'invalid_response' } }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    const joined = new Uint8Array(bytes); let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
    const value: unknown = JSON.parse(new TextDecoder().decode(joined))
    if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data) || value.data.length > 10_000)
      return { status: 'invalid_response' }
    const data = value.data as unknown[]
    return { status: 'catalog_received', models: ABLITERATION_MODELS.map(id => {
      const found = data.find((item): item is Record<string, unknown> => !!item && typeof item === 'object' && 'id' in item && item.id === id)
      const access = found?.access && typeof found.access === 'object' ? found.access as Record<string, unknown> : undefined
      return { id, listed: !!found, access: access?.locked === true || access?.available === false ? 'locked'
        : access?.available === true ? 'available' : 'unknown', ready: typeof found?.is_ready === 'boolean' ? found.is_ready : null }
    }) }
  } catch { return { status: 'request_failed' } }
}
