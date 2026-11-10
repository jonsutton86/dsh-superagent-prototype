/** Independent operator surface; no main Runtime dependency and no model-accessible operator mutation tools. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AcknowledgeSchema, WatchdogOperatorError, type RetentionPolicy } from './protocol.ts'
import type { WatchdogJournal } from './journal.ts'
import type { WatchdogAlerts } from './alerts.ts'

const query = z.object({ cursor: z.string().max(1024).optional(), state: z.enum(['open', 'unacknowledged', 'closed', 'all']).optional(),
  incident: z.string().min(1).max(200).optional() }).strict()
const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Agentic OS · Supervision</title></head><body><div id="watchdog-root"></div><script type="module" src="/watchdog/ui.js"></script></body></html>'

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > 16384) throw new WatchdogOperatorError(413, 'request_too_large')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new WatchdogOperatorError(400, 'invalid_json') }
}
export function watchdogHttp(journal: WatchdogJournal, options: {
  port: number; sessionId: string; mainUrl: string; pollMs: number; retention: RetentionPolicy; asset(): string; now?: () => number; active(): boolean;
  alerts?: WatchdogAlerts;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
    const origin = `http://127.0.0.1:${options.port}`
    if (req.headers.host !== `127.0.0.1:${options.port}` || (req.headers.origin && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: 'local_management_required' }); return }
    if (!options.active()) { json(503, { error: 'watchdog_stopping' }); return }
    try {
      const url = new URL(req.url ?? '/', origin), path = url.pathname
      if (req.method === 'GET' && !url.search && ['/watchdog', '/watchdog/', '/watchdog/ui.js'].includes(path)) {
        const body = path.endsWith('.js') ? options.asset() : HTML
        res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' })
        res.end(body); return
      }
      if (req.headers['x-orchestrator-request'] !== '1') { json(403, { error: 'local_management_required' }); return }
      // Reject duplicate keys instead of silently choosing one value for a bounded query.
      if (new Set(url.searchParams.keys()).size !== [...url.searchParams].length) throw new WatchdogOperatorError(400, 'duplicate_query')
      const params = query.parse(Object.fromEntries(url.searchParams))
      if (req.method === 'GET' && path === '/watchdog/api/alerts' && !params.incident && !params.state) {
        json(200, options.alerts?.list(params.cursor) ?? { routes: [], items: [], capacity: { used: 0, limit: 1000 }, cursor: null }); return
      }
      const alert = /^\/watchdog\/api\/alerts\/([a-f0-9-]{36})(?:\/(observe|retry|cancel))?$/.exec(path)
      if (alert && !url.search && options.alerts) {
        if (req.method === 'GET' && !alert[2]) { json(200, options.alerts.get(alert[1]!)); return }
        if (req.method === 'POST' && alert[2]) {
          if (!req.headers['content-type']?.startsWith('application/json')) throw new WatchdogOperatorError(415, 'json_required')
          z.object({}).strict().parse(await readBody(req))
          if (!options.active()) throw new WatchdogOperatorError(503, 'watchdog_stopping')
          const action = alert[2] as 'observe' | 'retry' | 'cancel'
          json(200, await options.alerts[action](alert[1]!)); return
        }
      }
      if (req.method === 'GET' && path === '/watchdog/api/status' && !url.search) {
        json(200, { sessionId: options.sessionId, mainUrl: options.mainUrl, pollMs: options.pollMs, now: (options.now ?? Date.now)(),
          monitor: journal.status() ?? null, counts: journal.counts(), retention: options.retention,
          incidents: journal.open().slice(0, 100).map(item => journal.view(item)), recent: journal.recent(30) }); return
      }
      if (req.method === 'GET' && path === '/watchdog/api/incidents' && !params.incident) {
        json(200, journal.incidents(params.state ?? 'open', params.cursor)); return
      }
      if (req.method === 'GET' && path === '/watchdog/api/history' && !params.state) {
        json(200, journal.history(params.incident, params.cursor)); return
      }
      const match = /^\/watchdog\/api\/incidents\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && match && !url.search) {
        const incident = journal.get(decodeURIComponent(match[1]!))
        if (!incident) throw new WatchdogOperatorError(404, 'incident_not_found')
        json(200, journal.view(incident)); return
      }
      if (req.method === 'POST' && path === '/watchdog/api/acknowledgements' && !url.search) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new WatchdogOperatorError(415, 'json_required')
        const body = AcknowledgeSchema.parse(await readBody(req))
        if (!options.active()) throw new WatchdogOperatorError(503, 'watchdog_stopping')
        json(200, journal.acknowledge(body, (options.now ?? Date.now)())); return
      }
      json(404, { error: 'unknown_watchdog_operation' })
    } catch (error) {
      if (error instanceof WatchdogOperatorError) json(error.status, { error: error.code })
      else if (error instanceof z.ZodError || error instanceof URIError) json(400, { error: 'invalid_request' })
      else json(500, { error: 'watchdog_request_failed' })
    }
  }
}
