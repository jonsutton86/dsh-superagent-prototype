# 027 Mission delivery

Mission replies now use the independent [publication service](026-artifact-publication.md). An operator grants future
acknowledgement, answer, question and result delivery for one exact mission plan and destination. DeepSeek Harness retains
its Sessions, inference and tools; the existing Engine purpose checks and Outbox remain the dispatch path.

## Operator flow

Configure the publication service and ownership authority as described in the preceding document. Before starting an
action, open **Mission reply delivery** on its mission, select the exact destination and explicitly enable future replies.
This grants permission for agent-written messages without reviewing each message. Individual artifact delivery retains its
separate complete-content review. Destinations are chosen from host configuration; text in a task cannot choose an account,
recipient or thread.

Consent is bound to the mission's current `planVersion`. Plan changes invalidate it. Enabling or replacing a destination
requires the current mission and delivery revisions and no stoppable action. Stop active work before selecting a new
destination. Disabling delivery is available during work, including after a plan change. Re-enabling creates a new grant;
old tickets retain their original grant and cannot acquire the new destination implicitly.

A host-created workspace trigger carries an outbound `publication` Channel only when its plan has a live grant. Its source
and mandate remain `workspace`. Workers acknowledge through `orchestrator_ack`; they report results/questions through the
usual handoff, and the router uses `orchestrator_reply`. Existing purpose checks still refuse premature results and obsolete
questions. Delivery rechecks the ticket, original channel, mission, grant, plan, source settings and execution authorization.
An ended ticket stopped by a person cannot dispatch another reply.

## Destinations

Existing `github-comment` destinations remain compatible. Add these entries to the publication service's `destinations`
array; retain previous definitions and use a new ID when changing public metadata:

```yaml
- id: review-discussion
  name: Selected PR review thread
  kind: github-review
  repository: owner/project
  issue: 7
  comment: 123456
  login: agent-account
  maxBytes: 30000
  credentialFile: /private/agentic-os/github-account.token
- id: team-message
  name: Selected team conversation
  kind: feishu-reply
  brand: feishu
  appId: cli_application
  botId: ou_bot
  chatId: oc_chat
  messageId: om_rootmessage
  maxBytes: 15000
  credentialFile: /private/agentic-os/feishu-app.secret
```

GitHub review delivery uses the [review comment API](https://docs.github.com/en/rest/pulls/comments). The configured
`comment` must be a top-level review comment on the configured pull request. Preparation verifies the account, PR and
parent; dispatch sends one reply to that exact comment. It does not create a new review or fall back to the issue discussion.
Receipts and observation require the exact body, author, parent and pull-request identity.

Feishu/Lark delivery supports self-built apps. The private credential file contains the app secret. `brand: lark` selects
the fixed international API origin; `feishu` selects the fixed mainland origin. Tenant access tokens remain in process
memory. The configured bot must match the application's bot identity and the existing root message must belong to the
configured chat. Deployment must provide app permissions and bot membership sufficient to read that message/history and
send replies. Qualify those permissions against the actual tenant before relying on delivery.

The adapter uses Feishu's [reply operation](https://open.feishu.cn/document/server-docs/im-v1/message/reply) and the official
[SDK message contracts](https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/im.ts), with plain text,
`reply_in_thread: true` and the immutable intent UUID. App authentication follows the official
[token manager](https://github.com/larksuite/node-sdk/blob/main/client/token-manager.ts). A visible receipt marker is appended
to Feishu/Lark text; GitHub uses an HTML comment. Exact confirmation checks content, app sender, chat and parent. The receipt
link opens the Feishu/Lark chat, not an exact message permalink. Rich cards, edits and attachments are outside this adapter.

## Durable delivery

The coordinator records the original message and publication UUID before transport. The independent service records
acceptance and start before its single provider POST. Ambiguous sends remain unknown and block ownership handoff. A retry
resubmits the same immutable intent; it does not issue another POST for an already journaled request. The guarantee depends
on retaining the independent journal; provider UUID deduplication is not treated as permanent exactly-once delivery.

Revoking a grant stops new admission. An already dispatched request may still arrive. Receipt observation runs before
source/permission checks for existing intents, so disabling a source or stopping work cannot falsely discard a possible
send. Withdrawing an attempted Outbox message retains the pending record, records the withdrawal and cancels its effect;
only receipt observation remains available. Later messages on that ticket/conversation stay behind the unresolved original,
even after repeated errors or withdrawal. Other conversations remain independent.

Unknown provider outcomes require exact read-only observation or independent administrator evidence as defined in the
publication document. Missing/edited messages and exhausted searches remain unknown. Feishu observation searches at most
20 pages of 50 messages, preferring the root's thread when available. The service administrator can supply a direct external
message ID. A nonzero Feishu send response is conservatively unknown; this version has no definitive-refusal allowlist.

API routes under `/orchestrator/api/`:

| Method and path | Contract |
| --- | --- |
| `GET missions/:id/delivery` | Current plan grant and up to 100 delivery metadata records |
| `PUT missions/:id/delivery` | Immutable `requestId`, delivery `revision`, `missionRevision`, `enabled`, and exact destination ID/hash when enabled |
| `POST deliveries/:id/refresh` | Read-only original receipt recovery, including after ownership loss |
| `POST deliveries/:id/retry` | Original immutable intent, requiring current ownership and still-valid, unwithdrawn authority |

Lost configuration acknowledgements retain the exact request and revisions in the UI. Replaying an old configuration
returns current state and cannot revive a revoked grant. `delivery_grant` preserves grant history; `channel_publication`
preserves private original messages, ownership attempts and receipts. Management responses omit original message content
and credentials. The independent service protocol accepts exactly one artifact or message subject; old artifact receipts
retain their existing shape and hash. This protocol extension requires upgrading the service before the coordinator.

## Qualification and remaining work

Deterministic tests use real HTTP at the ownership, execution and publication boundaries with synthetic local provider
servers. Runtime tests invoke worker/router tools through the actual Engine and Outbox. Rendered React tests use actual
management routes. Provider tests cover review/Feishu restart recovery, substituted sender/parent/body rejection and account
or chat mismatch. No test sends a real external message.

The opt-in installed-Harness suite requests a real DeepSeek worker acknowledgement, checks its original receipt after
coordinator restart, and loads the actual publication plugin with GitHub issue/review and Feishu/Lark destinations. A
test-only transport shim targets local provider servers. This establishes composition and receipt behavior, not live
GitHub/Feishu credentials, tenant permissions, browser accessibility or cross-host deployment.

Owned profiles still disable the old account-CLI GitHub/Feishu inbound sources and repository execution mode. This increment
adds outbound mission delivery, not a complete inbound connector gateway or git/PR mutation service. Those integrations,
host-verified deliverables, restore reconciliation, clean-host activation/failover and the full Agentic OS product ledger
remain required. Checkpoint imports retain the maintenance hold; new delivery tables do not authorize restored activation.

On 2026-11-08, the final local `pnpm check` passed typechecking, 1,437 tests (7 opt-in tests skipped) and all four builds on
Node 25.9.0. Both owned installed-Harness/DeepSeek Flash scenarios passed separately in 169.68 seconds, including real worker
acknowledgements, retained receipts after coordinator restart and the dedicated publication plugin's four-destination
restart checks. The live qualification on macOS substitutes the endpoint confinement identity; native Linux confinement
requires its separate CI result. The user's existing application process was not restarted or replaced.

Exact code revision `3bf6a280f992c2e8621f6ec388879785f7827598` subsequently passed typechecking, all four builds and
1,439 tests (5 opt-in tests skipped) under native Linux confinement in
[run 42543761724](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42543761724).
That result includes the managed execution, mission delivery and rendered-control tests. Live external account deployment,
inbound connector integration and the rest of the full architecture remain unqualified by this increment.
