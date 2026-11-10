/** Fixed-origin GitHub repository delivery; each returned mutation is invoked only after its durable service boundary. */
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { credentialDigest, privateCredential, privateDirectory } from '../environments/endpoint-files.ts'
import { RepositoryGit, type RepositoryGitTransport } from './repository-git.ts'
import { RepositoryBranch, RepositoryPull, type RepositoryDestinationConfig, type RepositoryPublication, type RepositoryTransferReceipt } from './repository-model.ts'
import { fingerprint } from '../remote/journal.ts'
import { contentHash, DeliveryRefused } from './github.ts'

export interface PreparedRepositoryBranch { push(signal: AbortSignal): Promise<z.infer<typeof RepositoryBranch>>; close(): Promise<void> }
export interface RepositoryAdapter {
  check(destination: RepositoryDestinationConfig, signal: AbortSignal): Promise<void>
  branch(destination: RepositoryDestinationConfig, branch: string, signal: AbortSignal): Promise<z.infer<typeof RepositoryBranch> | undefined>
  prepare(destination: RepositoryDestinationConfig, transfer: RepositoryTransferReceipt, chunks: Iterable<Buffer>, branch: string, signal: AbortSignal): Promise<PreparedRepositoryBranch>
  createPull(destination: RepositoryDestinationConfig, publication: RepositoryPublication, transfer: RepositoryTransferReceipt, branch: string, signal: AbortSignal): Promise<RepositoryPull>
  observePull(destination: RepositoryDestinationConfig, publication: RepositoryPublication, transfer: RepositoryTransferReceipt, branch: string, signal: AbortSignal, number?: number): Promise<RepositoryPull | undefined>
}
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha = z.string().regex(/^[a-f0-9]{40}$/)
const repository = z.looseObject({ id: integer, full_name: z.string() }), branch = z.looseObject({ ref: z.string(), sha, repo: repository })
const Pull = z.looseObject({ id: integer, number: integer, html_url: z.string(), title: z.string(), body: z.string().nullable(), user: z.looseObject({ login: z.string() }),
  head: branch, base: branch, draft: z.boolean(), state: z.enum(['open', 'closed']), merged: z.boolean().optional(), merged_at: z.string().nullable().optional() })
export const repositoryPullBody = (request: RepositoryPublication, transfer: RepositoryTransferReceipt) =>
  `${request.body}\n\nReviewed commit: \`${transfer.bundle.head}\`\n\n<!-- dsh-repository:${request.id}:${fingerprint(request)}:${transfer.bundle.sha256} -->`
export class GithubRepositoryPublication implements RepositoryAdapter {
  private readonly pins = new Map<string, string>()
  private readonly root: string
  constructor(private readonly subprocess: SubprocessRuntime, root: string, private readonly fetcher: typeof fetch = fetch,
    private readonly transport: (repository: string) => RepositoryGitTransport = repository => ({ url: `https://github.com/${repository}.git` })) { this.root = privateDirectory(root) }
  private credential(destination: RepositoryDestinationConfig) {
    const value = privateCredential(destination.credentialFile, this.pins.get(destination.credentialFile)); this.pins.set(destination.credentialFile, credentialDigest(value)); return value
  }
  private async request(path: string, credential: string, signal: AbortSignal, data?: unknown, missing = false): Promise<unknown> {
    const response = await this.fetcher('https://api.github.com/' + path, { method: data === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { authorization: 'Bearer ' + credential, accept: 'application/vnd.github+json',
        'content-type': 'application/json', 'x-github-api-version': '2026-03-10', 'user-agent': 'dsh-superagent-publication' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    if (missing && response.status === 404) { await response.body?.cancel(); return undefined }
    if (!response.body) throw new Error('Repository provider returned no body')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 2097152) throw new Error('Repository response exceeded bound'); chunks.push(next.value) } }
    finally { await reader.cancel() }
    if (!response.ok) {
      if (data !== undefined && [401, 403, 404, 410, 422, 429].includes(response.status)) throw new DeliveryRefused('Provider explicitly refused repository publication')
      throw new Error('Repository provider did not confirm the operation')
    }
    if (data !== undefined && response.status !== 201) throw new Error('Repository provider did not confirm PR creation')
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async check(destination: RepositoryDestinationConfig, signal: AbortSignal) {
    const credential = this.credential(destination)
    const account = z.looseObject({ login: z.string() }).parse(await this.request('user', credential, signal))
    const target = repository.extend({ archived: z.boolean(), disabled: z.boolean(), permissions: z.looseObject({ push: z.boolean() }) })
      .parse(await this.request(`repos/${destination.repository}`, credential, signal))
    if (account.login.toLowerCase() !== destination.login.toLowerCase() || target.id !== destination.repositoryId
      || target.full_name.toLowerCase() !== destination.repository.toLowerCase() || target.archived || target.disabled || !target.permissions.push)
      throw new Error('Repository account or target differs from configuration')
    const base = await this.branch(destination, destination.baseRef, signal); if (!base) throw new Error('Configured base branch is missing')
    this.credential(destination)
  }
  async branch(destination: RepositoryDestinationConfig, name: string, signal: AbortSignal) {
    const value = await this.request(`repos/${destination.repository}/git/ref/heads/${name.split('/').map(encodeURIComponent).join('/')}`, this.credential(destination), signal, undefined, true)
    if (value === undefined) return
    const result = z.looseObject({ ref: z.string(), object: z.looseObject({ type: z.literal('commit'), sha }) }).parse(value)
    if (result.ref !== 'refs/heads/' + name) throw new Error('Provider returned another branch')
    return RepositoryBranch.parse({ repository: destination.repository, repositoryId: destination.repositoryId, ref: name, sha: result.object.sha })
  }
  async prepare(destination: RepositoryDestinationConfig, transfer: RepositoryTransferReceipt, chunks: Iterable<Buffer>, name: string, signal: AbortSignal): Promise<PreparedRepositoryBranch> {
    if (![ `https://github.com/${destination.repository}`, `https://github.com/${destination.repository}.git` ].includes(transfer.source)) throw new Error('Bundle source is outside the configured repository')
    await this.check(destination, signal)
    if (await this.branch(destination, name, signal)) throw new Error('Publication branch already exists; never adopt or overwrite it')
    const imported = await RepositoryGit.prepare(this.subprocess, this.root, transfer, chunks, this.transport(destination.repository), () => this.credential(destination), signal)
    return { close: () => imported.close(), push: async current => {
      current.throwIfAborted(); await imported.push(name, transfer.bundle.head)
      const result = await this.branch(destination, name, current)
      if (!result || result.sha !== transfer.bundle.head) throw new Error('Provider did not confirm the reviewed branch')
      return result
    } }
  }
  private pull(destination: RepositoryDestinationConfig, request: RepositoryPublication, transfer: RepositoryTransferReceipt, name: string, input: unknown, observing: boolean): RepositoryPull | undefined {
    const parsed = Pull.safeParse(input); if (!parsed.success) return
    const value = parsed.data, text = repositoryPullBody(request, transfer)
    if (value.title !== request.title || value.body !== text || value.user.login.toLowerCase() !== destination.login.toLowerCase()
      || value.head.repo.id !== destination.repositoryId || value.base.repo.id !== destination.repositoryId
      || value.head.repo.full_name.toLowerCase() !== destination.repository.toLowerCase() || value.base.repo.full_name.toLowerCase() !== destination.repository.toLowerCase()
      || value.head.ref !== name || value.head.sha !== transfer.bundle.head || value.base.ref !== destination.baseRef
      || value.html_url !== `https://github.com/${destination.repository}/pull/${value.number}` || !observing && (value.state !== 'open' || value.draft !== request.draft)) return
    const convert = (value: z.infer<typeof branch>) => ({ repository: destination.repository, repositoryId: value.repo.id, ref: value.ref, sha: value.sha })
    return RepositoryPull.parse({ id: value.id, number: value.number, url: value.html_url, repositoryId: destination.repositoryId, head: convert(value.head), base: convert(value.base),
      bodyHash: contentHash(text), title: value.title, draft: value.draft, state: value.state, merged: value.merged ?? !!value.merged_at })
  }
  async createPull(destination: RepositoryDestinationConfig, request: RepositoryPublication, transfer: RepositoryTransferReceipt, name: string, signal: AbortSignal) {
    const value = await this.request(`repos/${destination.repository}/pulls`, this.credential(destination), signal,
      { title: request.title, body: repositoryPullBody(request, transfer), head: name, base: destination.baseRef, draft: request.draft, maintainer_can_modify: false })
    const result = this.pull(destination, request, transfer, name, value, false)
    if (!result) throw new Error('Provider did not confirm the exact PR'); return result
  }
  async observePull(destination: RepositoryDestinationConfig, request: RepositoryPublication, transfer: RepositoryTransferReceipt, name: string, signal: AbortSignal, number?: number) {
    await this.check(destination, signal)
    if (number !== undefined) return this.pull(destination, request, transfer, name, await this.request(`repos/${destination.repository}/pulls/${number}`, this.credential(destination), signal), true)
    const matches: RepositoryPull[] = []
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({ state: 'all', head: destination.repository.split('/')[0] + ':' + name, base: destination.baseRef, per_page: '100', page: String(page) })
      const values = z.array(z.unknown()).max(100).parse(await this.request(`repos/${destination.repository}/pulls?${query}`, this.credential(destination), signal))
      for (const value of values) { const match = this.pull(destination, request, transfer, name, value, true); if (match) matches.push(match) }
      if (matches.length > 1) throw new Error('Multiple pull requests match the original publication')
      if (values.length < 100) return matches[0]
    }
    throw new Error('PR observation reached its bound; supply the original pull request number')
  }
}
