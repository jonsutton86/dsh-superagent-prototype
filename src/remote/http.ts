import type { IncomingMessage, ServerResponse } from 'node:http'
import { FsError } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { RemoteError, RPC_PATH } from './protocol.ts'
import type { RemoteEndpoint } from './endpoint.ts'

/** Bounded authenticated RPC. The endpoint is pinned before payload processing; credentials never follow redirects. */
export function remoteHandler(endpoint: RemoteEndpoint) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff')
    const send = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)) }
    try {
      if (req.method !== 'POST' || req.url !== RPC_PATH) throw new RemoteError(404, 'not_found', 'RPC route not found')
      if (req.headers.origin || req.headers['sec-fetch-site']) throw new RemoteError(403, 'browser_denied', 'Execution RPC is not a browser endpoint')
      const principal = endpoint.journal.authenticate(req.headers.authorization)
      const pinned = req.headers['x-dsh-endpoint'] === endpoint.journal.id
      if (!pinned && principal.role !== 'admin') throw new RemoteError(409, 'endpoint_mismatch', 'Pinned endpoint identity does not match')
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RemoteError(415, 'content_type', 'JSON required')
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); size += bytes.length
        if (size > 2 * 1024 * 1024) throw new RemoteError(413, 'body_too_large', 'Execution request exceeds 2 MiB')
        chunks.push(bytes)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { op?: string }
      if (!pinned && input.op !== 'identity') throw new RemoteError(409, 'endpoint_mismatch', 'Pin the endpoint identity before changing state')
      send(200, { endpointId: endpoint.journal.id, result: await endpoint.rpc(principal, input) })
    } catch (error) {
      const status = error instanceof RemoteError ? error.status : error instanceof FsError ? 409 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500
      const code = error instanceof RemoteError || error instanceof FsError ? error.code : status === 400 ? 'invalid_request' : 'endpoint_error'
      send(status, { endpointId: endpoint.journal.id, error: { code, message: error instanceof Error ? error.message.slice(0, 4000) : 'Endpoint request failed' } })
    }
  }
}
