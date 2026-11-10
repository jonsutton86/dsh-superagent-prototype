import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { credentialDigest, privateCredential } from '../environments/endpoint-files.ts'
import type { OwnershipAccess } from '../ownership/protocol.ts'
import { PUBLICATION_PATH, PublicationError, type PublicationRpc } from './protocol.ts'

export interface PublicationConnection { url: string; serviceId: string; credentialFile: string; timeoutMs?: number }
export const PublicationConfig: s<Partial<PublicationConnection>, PublicationConnection> = s.object({ url: s.string().required(), serviceId: s.string().required(),
  credentialFile: s.string().pattern(/^\//).required(), timeoutMs: s.number().min(100).max(60_000).default(30_000) })
const Envelope = z.object({ serviceId: z.string().uuid(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() })
/** Bounded identity-pinned client. Mutations are never automatically retried after transport ambiguity. */
export class PublicationClient {
  private readonly url: string
  private readonly pin: string
  constructor(readonly config: PublicationConnection, private readonly ownership?: OwnershipAccess) {
    const url = new URL(config.url)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Publication service requires an HTTPS or tunneled loopback origin')
    z.string().uuid().parse(config.serviceId)
    this.url = url.origin + PUBLICATION_PATH; this.pin = credentialDigest(privateCredential(config.credentialFile))
  }
  async call<T>(request: PublicationRpc, signal?: AbortSignal): Promise<T> {
    const credential = privateCredential(this.config.credentialFile, this.pin)
    const response = await fetch(this.url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs ?? 30_000), ...signal ? [signal] : []]),
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'x-dsh-publication': this.config.serviceId,
        ...(['publish', 'conversation.read', 'pull.inspect', 'repository.prepare', 'repository.publish', 'repository.receipt.cancel', 'repository.transfer.begin', 'repository.transfer.chunk', 'repository.transfer.finish', 'repository.transfer.cancel'].includes(request.op)
          ? { 'x-dsh-owner': this.ownership?.proof() ?? '' } : {}) }, body: JSON.stringify(request) })
    if (!response.body) throw new Error('Publication service returned no response body')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length
      if (bytes > 2 * 1024 * 1024) throw new Error('Publication response exceeded its bound'); chunks.push(next.value) }
    } finally { await reader.cancel() }
    const envelope = Envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (envelope.serviceId !== this.config.serviceId) throw new PublicationError(409, 'service_changed', 'Publication service identity changed')
    if (envelope.error) throw new PublicationError(response.status, envelope.error.code, envelope.error.message)
    if (!response.ok) throw new Error('Publication transport failed')
    return envelope.result as T
  }
}
