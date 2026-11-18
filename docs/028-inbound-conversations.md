# 028 Inbound task conversations

This increment extends [mission delivery](027-mission-delivery.md) with inbound replies to an explicitly selected existing
task. It retains DeepSeek Harness Sessions, the Engine, SQLite and the independently owned publication service. It does
not replace the broader article or [Agentic OS](010-agentic-os.md) implementation ledger.

## Operator flow

Configure a publisher destination, authorize delivery for a mission plan, and start the receiving action. In the mission's
**External task replies** section, select that action, enter exact allowed GitHub logins or Feishu/Lark `ou_` user IDs, and
authorize reception. New messages become task inputs and appear in Inbox. The worker can acknowledge the original trigger
and the router can answer through the task's original publication Channel. A completed task can resume; a human-stopped
task cannot. Incoming messages cannot originate tasks or select another recipient.

The panel shows the effective start time, participants, task, last successful check, read problems and provider conversation
links (GitHub opens the comment; Feishu/Lark opens the pinned chat). It supports checking immediately, rescanning since
authorization, replacing a listener and stopping incoming replies.
After a lost configuration acknowledgement, retry uses the original request ID and original revision. A definitive conflict
clears consent and requires reviewing the current state. Already admitted messages remain task inputs after reception stops.

## Authority and isolation

`ConversationInbox` binds an immutable request to one exact delivery grant, destination, task and participant allowlist.
The origin must belong to that mission and carry that grant. Current mission plan, delivery/source settings, original
mandate, execution world authority and human-stop status are checked again before ingestion. Only an owned coordinator can
read through the independently fenced publisher. Its `conversation.read` RPC verifies ownership both before and after
provider I/O; concurrent revocation is checked again inside the coordinator transaction.

Provider metadata establishes the sender and physical conversation. GitHub accepts `User` accounts, excludes the configured
agent account and GitHub App-attributed comments, and checks repository, issue/PR and review root. Feishu/Lark accepts only
user senders with open IDs in the pinned chat/root. Message text, mentions, embedded instructions and claimed identities do
not broaden access. This proves an account identity under the provider's authentication, not that a person manually wrote
the text or that a participant account is uncompromised.

`Engine.receiveForTicket` is a host-only operation. A persisted disposition recipient restricts fanout, manual routing,
worker context reads and acknowledgements. Evaluation cannot turn directed input into a new task or stop another task,
including after a handback or requeue. Directed reads filter before thread pagination. The original workspace mandate
remains the task's authority; inbound text never creates a new mandate. The router remains trusted to coordinate the
workspace; this does not claim information isolation from an administrator or the router.

An enabled listener reserves its physical conversation across missions, including while paused or temporarily unauthorized.
Disable it before binding that conversation elsewhere. Configuration aliases, display names and credential changes do not
create another conversation identity. At most 100 listeners can remain enabled and unrevoked.

## Storage, polling and failure behavior

`conversation_binding` retains configuration history, revisions, consent time, cursor state and safe status. The
`conversation_message` table retains native-message identity, sender, timestamp, content hash, destination URL and resulting
trigger or unsupported status. It never stores provider credentials. Successful receipt insertion, directed Engine input
and cursor advancement share one SQLite transaction. Native identity deduplication spans listener replacements and restarts;
editing an already recorded message does not execute it again. A new message is required for a correction.

Reception begins at the next whole UTC second after authorization to avoid interpreting a provider's rounded timestamp as
pre-consent authority. Ten native items form a page, at most four pages are read per poll, and the unfinished cursor survives
until the next poll. Polling is every 60 seconds, with failure backoff up to five minutes. A 60-second overlap and explicit
rescan handle repeated or late-indexed messages. Provider offset pagination, deletion, delayed indexing and provider retention
can still omit messages; this is not a lossless event subscription. A repeating cursor or more than 1,000 continuation pages
holds the read for operator attention. Request bodies and responses remain bounded.

Non-text Feishu/Lark content, malformed text, empty messages and messages over 16,000 UTF-16 code units receive visible
unsupported records instead of truncated executable input. At 50,000 stored inbound receipts, ingestion fails closed. Retention
and archival must preserve deduplication identity before that limit can be safely raised or old receipts removed.

The full SQLite checkpoint includes these tables. Staged restore still has its maintenance hold; active restore/failover
qualification is not implied. A read failure retains the last committed cursor and exposes a safe error without provider
credentials or raw diagnostics. No automatic write retry is added to outbound publication.

## Interfaces and provider contracts

Management routes under `/orchestrator/api/`:

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `missions/:id/inbound` | Listener state and latest 100 receipts |
| PUT | `missions/:id/inbound` | Original request ID, expected listener revision, enable/disable, grant, task and participants |
| POST | `missions/:id/inbound/poll` | Check now; optional `rescan: true` restarts from authorization time |

`conversation.read` is a private publisher RPC with exact destination ID/hash, ISO lower timestamp and optional opaque
cursor. It returns up to ten messages and a continuation cursor. It requires current ownership even though the provider call
is read-only, because its result may trigger work. Receipt observation remains separately available after ownership loss.

GitHub uses the official [issue comment](https://docs.github.com/en/rest/issues/comments) and
[review comment](https://docs.github.com/en/rest/pulls/comments) listing contracts. Its `since` filter is based on updates;
the adapter additionally filters creation time and uses native IDs for deduplication. Feishu/Lark uses message listing and
root inspection from the [official SDK contract](https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/im.ts).
It requests chronological bounded pages and checks actual sender ID type. Private provider credentials stay at the publisher;
the coordinator and worker receive only scoped messages and safe metadata.

## Acceptance and remaining scope

`tests/inbound.spec.ts` exercises actual Runtime and both HTTP boundaries with local provider servers: all three destination
kinds, unauthorized/bot messages, native deduplication, pagination, ambiguous read recovery, oversized content, wrong roots,
cross-task read/acknowledgement refusal, handbacks, and revocation during I/O. `tests/mission-inbound-ui.spec.tsx` exercises
rendered consent/retry, current receipt display, polling/rescans and stopping input against the actual Runtime API.
`tests/remote-harness.spec.ts` extends the opt-in installed-Harness qualification to resume the same task from a provider
reply, acknowledge through the publisher, retain its artifact, and preserve receipts/deduplication across coordinator restart.

Qualification on 2026-11-08: local `pnpm check` passed 1,457 tests, typechecking and all four builds. Both owned installed
Harness/DeepSeek Flash scenarios passed on the final build in 191.45 seconds. Code revision
`a558cdd5f6bf2de59512afb60373cff2465fb74b` passed 1,459 tests, typechecking and all builds with native Linux confinement in
[run 42546908912](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42546908912).
Local provider servers do not certify live GitHub, Feishu or Lark account permissions. macOS Harness composition and native
Linux confinement are separate checks.
Repository-wide event discovery, source-originated task admission, attachments/rich content, Git/PR mutations, provider event
subscriptions, retention, restored-state activation and the remaining full product capabilities remain open.
