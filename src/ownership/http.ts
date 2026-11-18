import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { OwnershipAuthority } from './authority.ts'
import { OWNERSHIP_PATH, OwnershipError } from './protocol.ts'

/** Pinned host-to-host control RPC; browser origins and oversized input cannot reach ownership transitions. */
export function ownershipHandler(authority: OwnershipAuthority) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff')
    const send = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify({ authorityId: authority.id, ...value as object })) }
    try {
      if (req.method !== 'POST' || req.url !== OWNERSHIP_PATH) throw new OwnershipError(404, 'not_found', 'Ownership route not found')
      if (req.headers.origin || req.headers['sec-fetch-site']) throw new OwnershipError(403, 'browser_denied', 'Ownership RPC is not a browser endpoint')
      const principal = authority.authenticate(req.headers.authorization)
      const pinned = req.headers['x-dsh-authority'] === authority.id
      if (!pinned && principal.role !== 'admin') throw new OwnershipError(409, 'authority_mismatch', 'Pinned ownership authority differs')
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new OwnershipError(415, 'content_type', 'JSON required')
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of req) {
        const value = Buffer.from(chunk); bytes += value.length
        if (bytes > 65536) throw new OwnershipError(413, 'body_too_large', 'Ownership request exceeds 64 KiB')
        chunks.push(value)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!pinned && input?.op !== 'identity') throw new OwnershipError(409, 'authority_mismatch', 'Pin the ownership authority before changing state')
      const result = authority.rpc(principal, input)
      send(200, { result })
    } catch (error) {
      const status = error instanceof OwnershipError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500
      send(status, { error: { code: error instanceof OwnershipError ? error.code : status === 400 ? 'invalid_request' : 'authority_error',
        message: error instanceof OwnershipError ? error.message : status === 400 ? 'Invalid ownership request' : 'Ownership authority failed' } })
    }
  }
}
