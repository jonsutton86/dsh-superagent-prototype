import type { DestinationView } from '../publication/protocol.ts'

/** Human-readable, inert description of the exact configured recipient and account. */
export function destinationLabel(destination: DestinationView): string {
  return destination.kind === 'feishu-reply'
    ? `${destination.brand} · ${destination.chatId} · ${destination.messageId} · ${destination.appId}`
    : `${destination.repository} #${destination.issue}${destination.kind === 'github-review' ? ` · review ${destination.comment}` : destination.kind === 'github-pr-review' ? ` · ${destination.event}` : ''} · ${destination.login}`
}
