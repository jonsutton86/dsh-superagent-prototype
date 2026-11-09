import { createHash } from 'node:crypto'
import { z } from 'zod'
import { credentialDigest, privateCredential } from '../environments/endpoint-files.ts'
import { PublicationError, type DestinationConfig, type ExternalReceipt, type Publication } from './protocol.ts'

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex')
export interface PreparedPublication { send(signal: AbortSignal): Promise<ExternalReceipt> }
export interface PublicationAdapter {
  prepare(destination: DestinationConfig, publication: Publication, signal: AbortSignal): Promise<PreparedPublication>
  observe(destination: DestinationConfig, publication: Publication, signal: AbortSignal, externalId?: string): Promise<ExternalReceipt | undefined>
}
/** A complete provider rejection whose documented status establishes that no comment was created. */
export class DeliveryRefused extends Error {}
const Comment = z.looseObject({ id: z.number().int().positive(), body: z.string(), issue_url: z.string().optional(), user: z.looseObject({ login: z.string() }) })
const ReviewComment = Comment.extend({ pull_request_url: z.string(), in_reply_to_id: z.number().int().positive().optional() })
export const publicationMarker = (request: Publication) => `dsh-publication:${request.id}:${request.hash}:${request.artifact?.id ?? 'message-' + request.message!.id}`
const body = (request: Publication) => `${request.text}\n\n<!-- ${publicationMarker(request)} -->`
type GithubDestination = Exclude<DestinationConfig, { kind: 'feishu-reply' }>

/** Fixed-origin GitHub comment publisher. Prepare is read-only; send is exactly one POST and never follows redirects. */
export class GithubPublication implements PublicationAdapter {
  private readonly pins = new Map<string, string>()
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private credential(destination: DestinationConfig): string {
    const value = privateCredential(destination.credentialFile, this.pins.get(destination.credentialFile))
    this.pins.set(destination.credentialFile, credentialDigest(value)); return value
  }
  private async request(path: string, credential: string, signal: AbortSignal, data?: object): Promise<unknown> {
    const response = await this.fetcher(`https://api.github.com/${path}`, { method: data ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { accept: 'application/vnd.github+json',
        authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'x-github-api-version': '2026-03-10', 'user-agent': 'dsh-superagent-publication' },
      ...(data ? { body: JSON.stringify(data) } : {}) })
    if (!response.body) throw new Error('Provider returned no response body')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length
      if (bytes > 2 * 1024 * 1024) throw new Error('Provider response exceeded its bound'); chunks.push(next.value) }
    } finally { await reader.cancel() }
    if (!response.ok) {
      if (data && [401, 403, 404, 410, 422, 429].includes(response.status)) throw new DeliveryRefused(`GitHub refused publication (HTTP ${response.status})`)
      throw new Error(`GitHub request failed (HTTP ${response.status})`)
    }
    if (data && response.status !== 201) throw new Error('GitHub did not return a creation receipt')
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  private receipt(destination: GithubDestination, publication: Publication, input: unknown, requireTarget: boolean): ExternalReceipt | undefined {
    const parsed = (destination.kind === 'github-review' ? ReviewComment : Comment).safeParse(input)
    if (!parsed.success) return
    const value = parsed.data
    if (value.user.login.toLowerCase() !== destination.login.toLowerCase() || value.body !== body(publication)) return
    if (destination.kind === 'github-review') {
      const review = ReviewComment.parse(value)
      if (review.in_reply_to_id !== destination.comment || review.pull_request_url.toLowerCase() !== `https://api.github.com/repos/${destination.repository}/pulls/${destination.issue}`.toLowerCase()) return
      return { id: String(value.id), url: `https://github.com/${destination.repository}/pull/${destination.issue}#discussion_r${value.id}`, bodyHash: contentHash(value.body) }
    }
    if (requireTarget && value.issue_url?.toLowerCase() !== `https://api.github.com/repos/${destination.repository}/issues/${destination.issue}`.toLowerCase()) return
    return { id: String(value.id), url: `https://github.com/${destination.repository}/issues/${destination.issue}#issuecomment-${value.id}`, bodyHash: contentHash(value.body) }
  }
  async prepare(destination: DestinationConfig, publication: Publication, signal: AbortSignal): Promise<PreparedPublication> {
    if (destination.kind === 'feishu-reply') throw new Error('GitHub destination required')
    const credential = this.credential(destination)
    const account = z.looseObject({ login: z.string() }).parse(await this.request('user', credential, signal))
    if (account.login.toLowerCase() !== destination.login.toLowerCase()) throw new PublicationError(409, 'account_changed', 'Publication account differs from the pinned destination account')
    await this.request(`repos/${destination.repository}/issues/${destination.issue}`, credential, signal)
    if (destination.kind === 'github-review') {
      const root = ReviewComment.parse(await this.request(`repos/${destination.repository}/pulls/comments/${destination.comment}`, credential, signal))
      if (root.id !== destination.comment || root.in_reply_to_id || root.pull_request_url.toLowerCase() !== `https://api.github.com/repos/${destination.repository}/pulls/${destination.issue}`.toLowerCase())
        throw new Error('The configured review root is not in the pinned pull request')
    }
    // All credential loading, account verification and target discovery finish before the service's final owner verification.
    return { send: async signal => {
      const path = destination.kind === 'github-review' ? `pulls/${destination.issue}/comments/${destination.comment}/replies` : `issues/${destination.issue}/comments`
      const result = await this.request(`repos/${destination.repository}/${path}`, credential, signal, { body: body(publication) })
      const receipt = this.receipt(destination, publication, result, false)
      if (!receipt) throw new Error('GitHub response did not confirm the exact publication')
      return receipt
    } }
  }
  async observe(destination: DestinationConfig, publication: Publication, signal: AbortSignal, externalId?: string): Promise<ExternalReceipt | undefined> {
    if (destination.kind === 'feishu-reply') throw new Error('GitHub destination required')
    const credential = this.credential(destination), prefix = `repos/${destination.repository}`
    const resource = destination.kind === 'github-review' ? 'pulls' : 'issues'
    if (externalId) {
      if (!/^[1-9][0-9]*$/.test(externalId)) throw new Error('GitHub comment ID required')
      return this.receipt(destination, publication, await this.request(`${prefix}/${resource}/comments/${externalId}`, credential, signal), true)
    }
    for (let page = 1; page <= 20; page++) {
      const comments = z.array(z.unknown()).parse(await this.request(`${prefix}/${resource}/${destination.issue}/comments?per_page=100&page=${page}`, credential, signal))
      const matches = comments.flatMap(value => { const match = this.receipt(destination, publication, value, false); return match ? [match] : [] })
      if (matches.length > 1) throw new Error('Multiple provider comments match this publication; operator reconciliation is required')
      if (matches[0]) return matches[0]
      if (comments.length < 100) return
    }
    throw new Error('Publication observation reached its page limit; supply the external comment ID')
  }
}
