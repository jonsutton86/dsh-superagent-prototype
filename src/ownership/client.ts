import { z } from 'zod'
import { privateCredential } from '../environments/endpoint-files.ts'
import { OWNERSHIP_PATH, OwnershipError, type OwnershipRequest } from './protocol.ts'

export interface OwnershipConnection { url: string; authorityId: string; credentialFile: string; timeoutMs?: number }
const Envelope = z.object({ authorityId: z.string().uuid(), result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional() }).strict()

/** Bounded authenticated ownership calls. A lost response stays ambiguous; callers retry the same durable request identity. */
export class OwnershipClient {
  private readonly url: string
  constructor(readonly connection: OwnershipConnection, private readonly readCredential = () => privateCredential(connection.credentialFile)) {
    const url = new URL(connection.url)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1'))
      throw new Error('Ownership authority requires an HTTPS origin or a loopback HTTP origin through a secure tunnel')
    if (!connection.authorityId) throw new Error('Pin the ownership authority identity')
    this.url = url.origin + OWNERSHIP_PATH
  }
  withCredential(credential: string): OwnershipClient { return new OwnershipClient(this.connection, () => credential) }
  async call<T>(request: OwnershipRequest, signal?: AbortSignal): Promise<T> {
    const credential = this.readCredential()
    if (credential.length < 32 || credential.length > 1024 || /\s/.test(credential)) throw new Error('Invalid ownership credential')
    const response = await fetch(this.url, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(this.connection.timeoutMs ?? 5000), ...signal ? [signal] : []]),
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', 'x-dsh-authority': this.connection.authorityId },
      body: JSON.stringify(request) })
    if (!response.body) throw new Error('Ownership authority returned no body')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break
        bytes += chunk.value.length; if (bytes > 256 * 1024) throw new Error('Ownership response exceeds 256 KiB')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel() }
    const envelope = Envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (envelope.authorityId !== this.connection.authorityId) throw new OwnershipError(409, 'authority_mismatch', 'Ownership authority identity changed')
    if (envelope.error) throw new OwnershipError(response.status, envelope.error.code, envelope.error.message)
    if (!response.ok) throw new OwnershipError(response.status, 'http_error', 'Ownership request failed')
    return envelope.result as T
  }
}
