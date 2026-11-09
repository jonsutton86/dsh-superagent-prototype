/** Explicit-commit PR reviews. Provider credentials and head observations stay on the independent publication host. */
import { z } from 'zod'
import { credentialDigest, privateCredential } from '../environments/endpoint-files.ts'
import { fingerprint } from '../remote/journal.ts'
import { PublicationError, type DestinationConfig, type ExternalReceipt, type Publication } from './protocol.ts'
import { contentHash, DeliveryRefused, publicationMarker, type PublicationAdapter, type PreparedPublication } from './github.ts'
import { GitObject, PullBinding, RepositoryName } from './pull-model.ts'

type Destination = Extract<DestinationConfig, { kind: 'github-pr-review' }>
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const repository = z.looseObject({ id: integer, full_name: RepositoryName })
const branch = z.looseObject({ repo: repository, ref: z.string().min(1).max(1024), sha: GitObject })
const Pull = z.looseObject({ id: integer, number: integer, url: z.string(), user: z.looseObject({ login: z.string() }),
  head: branch, base: branch, state: z.enum(['open', 'closed']), draft: z.boolean(), merged: z.boolean() })
const Review = z.looseObject({ id: integer, body: z.string(), user: z.looseObject({ login: z.string() }),
  state: z.enum(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']), commit_id: GitObject, pull_request_url: z.string(), submitted_at: z.string().datetime() })
const states = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' } as const
export const pullReviewBody = (request: Publication) => `${request.text}\n\nReviewed commit: \`${request.pull!.head.sha}\`\n\n<!-- ${publicationMarker(request)} -->`
const requireDestination = (destination: DestinationConfig): Destination => {
  if (destination.kind !== 'github-pr-review') throw new Error('PR review destination required')
  return destination
}

/** Fixed-origin review adapter with read-only head inspection and a single explicit-commit POST. */
export class GithubPullPublication implements PublicationAdapter {
  private readonly pins = new Map<string, string>()
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private credential(destination: Destination): string {
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
      if (data && [401, 403, 404, 410, 422, 429].includes(response.status)) throw new DeliveryRefused(`GitHub refused review (HTTP ${response.status})`)
      throw new Error(`GitHub request failed (HTTP ${response.status})`)
    }
    if (data && response.status !== 200) throw new Error('GitHub did not confirm review submission')
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async inspectPull(input: DestinationConfig, signal: AbortSignal): Promise<PullBinding> {
    const destination = requireDestination(input), credential = this.credential(destination)
    const account = z.looseObject({ login: z.string() }).parse(await this.request('user', credential, signal))
    if (account.login.toLowerCase() !== destination.login.toLowerCase()) throw new PublicationError(409, 'account_changed', 'PR review account changed')
    const prefix = `repos/${destination.repository}/pulls/${destination.issue}`
    const value = Pull.parse(await this.request(prefix, credential, signal))
    if (value.number !== destination.issue || value.base.repo.full_name.toLowerCase() !== destination.repository.toLowerCase()
      || value.url.toLowerCase() !== `https://api.github.com/${prefix}`.toLowerCase()) throw new PublicationError(409, 'pull_changed', 'Provider returned a different pull request')
    const commit = z.looseObject({ sha: GitObject, tree: z.looseObject({ sha: GitObject }) })
      .parse(await this.request(`repos/${value.head.repo.full_name}/git/commits/${value.head.sha}`, credential, signal))
    if (commit.sha !== value.head.sha) throw new PublicationError(409, 'pull_changed', 'Provider returned a different commit')
    this.credential(destination)
    const normalize = (value: z.infer<typeof branch>) => ({ repository: { id: value.repo.id, name: value.repo.full_name.toLowerCase() }, ref: value.ref, sha: value.sha })
    return PullBinding.parse({ id: value.id, number: value.number, author: value.user.login.toLowerCase(),
      head: { ...normalize(value.head), tree: commit.tree.sha }, base: normalize(value.base), state: value.state, draft: value.draft, merged: value.merged })
  }
  async check(destination: DestinationConfig, signal: AbortSignal): Promise<void> { await this.inspectPull(destination, signal) }
  private receipt(destination: Destination, publication: Publication, input: unknown, observing: boolean): ExternalReceipt | undefined {
    const parsed = Review.safeParse(input); if (!parsed.success || !publication.pull) return
    const value = parsed.data
    if (value.body !== pullReviewBody(publication) || value.user.login.toLowerCase() !== destination.login.toLowerCase()
      || value.commit_id !== publication.pull.head.sha || value.pull_request_url.toLowerCase() !== `https://api.github.com/repos/${destination.repository}/pulls/${destination.issue}`.toLowerCase()
      || value.state !== states[destination.event] && !(observing && value.state === 'DISMISSED')) return
    return { id: String(value.id), url: `https://github.com/${destination.repository}/pull/${destination.issue}#pullrequestreview-${value.id}`,
      bodyHash: contentHash(value.body), review: { commit: value.commit_id, state: value.state } }
  }
  async prepare(input: DestinationConfig, publication: Publication, signal: AbortSignal): Promise<PreparedPublication> {
    const destination = requireDestination(input)
    if (!publication.pull || !publication.artifact || publication.message) throw new PublicationError(409, 'pull_required', 'PR reviews require a checked artifact and an approved head')
    const verify = async (signal: AbortSignal) => {
      const current = await this.inspectPull(destination, signal)
      if (fingerprint(current) !== fingerprint(publication.pull) || current.state !== 'open' || current.merged || current.draft && destination.event === 'APPROVE')
        throw new PublicationError(409, 'pull_changed', 'Pull request changed or is not eligible for this review; inspect and approve its current head')
    }
    await verify(signal)
    const credential = this.credential(destination)
    return { verify, send: async signal => {
      const result = await this.request(`repos/${destination.repository}/pulls/${destination.issue}/reviews`, credential, signal,
        { body: pullReviewBody(publication), commit_id: publication.pull!.head.sha, event: destination.event })
      const receipt = this.receipt(destination, publication, result, false)
      if (!receipt) throw new Error('Provider response did not confirm the exact review')
      return receipt
    } }
  }
  async observe(input: DestinationConfig, publication: Publication, signal: AbortSignal, externalId?: string): Promise<ExternalReceipt | undefined> {
    const destination = requireDestination(input), credential = this.credential(destination), prefix = `repos/${destination.repository}/pulls/${destination.issue}/reviews`
    // Never inspect today's head before recovering the receipt of an already attempted review.
    if (externalId) {
      if (!/^[1-9][0-9]*$/.test(externalId)) throw new Error('GitHub review ID required')
      return this.receipt(destination, publication, await this.request(`${prefix}/${externalId}`, credential, signal), true)
    }
    for (let page = 1; page <= 20; page++) {
      const rows = z.array(z.unknown()).max(100).parse(await this.request(`${prefix}?per_page=100&page=${page}`, credential, signal))
      const matches = rows.flatMap(row => { const value = this.receipt(destination, publication, row, true); return value ? [value] : [] })
      if (matches.length > 1) throw new Error('Multiple matching reviews require operator reconciliation')
      if (matches[0]) return matches[0]
      if (rows.length < 100) return
    }
    throw new Error('Review observation reached its page limit; supply the external review ID')
  }
}
