import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { OwnershipError } from '../ownership/protocol.ts'
import { PUBLICATION_PATH, PublicationError } from './protocol.ts'
import type { PublicationService } from './service.ts'

/** Private host RPC. Browser-origin requests and unpinned execution are refused before reading publication content. */
export function publicationHandler(service: PublicationService) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff')
    const send = (status: number, value: object) => { res.writeHead(status); res.end(JSON.stringify({ serviceId: service.journal.id, ...value })) }
    try {
      if (req.method !== 'POST' || req.url !== PUBLICATION_PATH) throw new PublicationError(404, 'not_found', 'Publication route not found')
      if (req.headers.origin || req.headers['sec-fetch-site']) throw new PublicationError(403, 'browser_denied', 'Publication RPC is not a browser endpoint')
      const role = service.journal.authenticate(req.headers.authorization)
      if (req.headers['x-dsh-publication'] !== service.journal.id) throw new PublicationError(409, 'service_changed', 'Pin the publication service identity')
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new PublicationError(415, 'content_type', 'JSON required')
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of req) { const value = Buffer.from(chunk); bytes += value.length
        if (bytes > 384 * 1024) throw new PublicationError(413, 'body_too_large', 'Publication request exceeds 384 KiB'); chunks.push(value) }
      const result = await service.rpc(role, JSON.parse(Buffer.concat(chunks).toString('utf8')), typeof req.headers['x-dsh-owner'] === 'string' ? req.headers['x-dsh-owner'] : undefined)
      send(200, { result })
    } catch (error) {
      const known = error instanceof PublicationError || error instanceof OwnershipError
      const status = known ? error.status : error instanceof SyntaxError || error instanceof z.ZodError ? 400 : 500
      send(status, { error: { code: known ? error.code : status === 400 ? 'invalid_request' : 'publication_error',
        message: known ? error.message : status === 400 ? 'Invalid publication request' : 'Publication service failed; inspect the original receipt' } })
    }
  }
}
