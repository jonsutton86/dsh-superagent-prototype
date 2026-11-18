import { GithubPublication, type PublicationAdapter } from './github.ts'
import { FeishuPublication } from './feishu.ts'
import { GithubPullPublication } from './github-pull.ts'
import { PublicationError } from './protocol.ts'
import type { ConversationRead, DestinationConfig, Publication } from './protocol.ts'

/** Selects a fixed-origin provider from a host-pinned destination, never from model-supplied URLs. */
export class PublicationProviders implements PublicationAdapter {
  private readonly github: GithubPublication
  private readonly feishu: FeishuPublication
  private readonly pulls: GithubPullPublication
  constructor(fetcher: typeof fetch = fetch) { this.github = new GithubPublication(fetcher); this.feishu = new FeishuPublication(fetcher); this.pulls = new GithubPullPublication(fetcher) }
  private provider(destination: DestinationConfig) { return destination.kind === 'feishu-reply' ? this.feishu : destination.kind === 'github-pr-review' ? this.pulls : this.github }
  check(destination: DestinationConfig, signal: AbortSignal) { return this.provider(destination).check(destination, signal) }
  prepare(destination: DestinationConfig, publication: Publication, signal: AbortSignal) { return this.provider(destination).prepare(destination, publication, signal) }
  observe(destination: DestinationConfig, publication: Publication, signal: AbortSignal, externalId?: string) { return this.provider(destination).observe(destination, publication, signal, externalId) }
  read(destination: DestinationConfig, request: ConversationRead, signal: AbortSignal) {
    if (destination.kind === 'github-pr-review') throw new PublicationError(409, 'artifact_only', 'PR reviews are checked-artifact destinations, not conversation channels')
    return (destination.kind === 'feishu-reply' ? this.feishu : this.github).read(destination, request, signal)
  }
  inspectPull(destination: DestinationConfig, signal: AbortSignal) { return this.pulls.inspectPull(destination, signal) }
}
