/** Bounded, authenticated loopback transport; the watchdog never opens the orchestrator database. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { InterventionResultSchema, SnapshotSchema, type Intervention, type Snapshot } from './protocol.ts'

export type ObservationSet = Omit<Snapshot, 'nextOffset'>

/** Reads consistent pages and sends fenced commands without forwarding credentials across redirects. */
export class SupervisionClient {
  private readonly base: string
  constructor(url: string, private readonly tokenFile: string, private readonly lifetime: AbortSignal) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Watchdog URL must be an http://127.0.0.1:<port> origin')
    this.base = parsed.origin + '/orchestrator/api/supervision'
  }
  private async request<T>(path: string, schema: z.ZodType<T>, body?: Intervention, deadline?: AbortSignal): Promise<T> {
    const token = readFileSync(this.tokenFile, 'utf8').trim()
    if (token.length < 32) throw new Error('Watchdog token is missing or invalid')
    const response = await fetch(this.base + path, { method: body ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.any([this.lifetime, deadline ?? AbortSignal.timeout(10_000)]),
      headers: { 'x-orchestrator-request': '1', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Supervision HTTP ${response.status}`) }
    if (!response.body) throw new Error('Empty supervision response')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 1_048_576) throw new Error('Supervision response exceeds 1 MiB')
        chunks.push(chunk.value)
      }
      return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } finally { await reader.cancel() }
  }
  async observe(): Promise<ObservationSet> {
    const deadline = AbortSignal.timeout(10_000)
    const first = await this.request('', SnapshotSchema, undefined, deadline), tickets = [...first.tickets]
    let offset = first.nextOffset, pages = 1
    while (offset !== null) {
      if (pages++ >= 100) throw new Error('Supervision snapshot exceeds 100 pages; no incidents reconciled')
      const page = await this.request(`?offset=${offset}`, SnapshotSchema, undefined, deadline)
      if (page.instance !== first.instance || page.version !== first.version || page.paused !== first.paused
        || page.configured !== first.configured) throw new Error('Supervision changed during pagination; retry next poll')
      if (page.nextOffset !== null && page.nextOffset <= offset) throw new Error('Supervision pagination did not advance')
      tickets.push(...page.tickets); offset = page.nextOffset
    }
    if (new Set(tickets.map(ticket => ticket.id)).size !== tickets.length) throw new Error('Duplicate supervision observation')
    const { nextOffset: _, ...snapshot } = first
    return { ...snapshot, tickets }
  }
  intervene(request: Intervention) { return this.request('/intervene', InterventionResultSchema, request) }
}
