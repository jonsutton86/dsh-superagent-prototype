# 026 Artifact publication

Operator-reviewed text artifacts can be delivered as GitHub issue or PR top-level comments through a separate Harness
service. It holds account credentials and its own delivery journal; the coordinator holds only a restricted service
credential. Every new send uses the [Runtime ownership](025-runtime-ownership.md) lease and the independent authority's
all-resource handoff barrier. DeepSeek Harness continues to own inference, tools and Sessions.

## Deployment

Enroll a publication resource alongside all execution endpoints with the
[ownership authority](024-ownership-fencing.md). Give the publication process that resource's credential. Start the
publication service before starting the coordinator: all enrolled resources must acknowledge preparation before activation.
An unreachable publication service therefore prevents coordinator acquisition, even if the next task does not publish.

Use a separate Harness profile with the main coordinator disabled and a dedicated loopback web server. Example patch:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 61002
- id: dsh-superagent
  disabled: true
- insert:
    - id: publication
      name: dsh-superagent/publication
      config:
        stateDir: /private/agentic-os/publication
        ownership:
          url: http://127.0.0.1:61000
          authorityId: <pinned-authority-uuid>
          coordinatorId: personal-agent
          resourceId: publication
          credentialFile: /private/agentic-os/publication-resource.token
        destinations:
          - id: project-updates
            name: Project updates
            kind: github-comment
            repository: owner/project
            issue: 7
            login: agent-account
            maxBytes: 30000
            credentialFile: /private/agentic-os/github-account.token
```

Use owned private regular credential files with no symlinks or additional hard links. The state directory must be private
and canonical. Keep its authority/resource/admin credentials and GitHub account token inaccessible to the coordinator and
workers. The account token must support authenticated-user lookup and comment creation for the selected repository;
GitHub App installation tokens are not supported by this account-verification path. The service checks the account login
and exact issue before its final owner check. Credential contents are pinned within each process; rotation requires a
controlled restart and must preserve the account identity.

The service logs its stable UUID and generates `client.token` and `admin.token` in its state directory. Securely provision
only the client token to the coordinator, outside every execution workspace. Configure the existing coordinator plugin:

```yaml
publication:
  url: http://127.0.0.1:61002
  serviceId: <pinned-publication-uuid>
  credentialFile: /private/agentic-os/publication-client.token
  timeoutMs: 30000
```

The coordinator must also have its existing ownership configuration. Cross-host clients require HTTPS or a secure tunnel
terminating on loopback. Do not expose the raw loopback listener. Generated dedicated profiles carry this connection
configuration and credential path, never the credential value. Managed worlds check control credential separation before
mounting their execution roots. The independent publication service identity and authority/coordinator/resource binding
cannot be replaced in existing state. Destination metadata is immutable: retain previous definitions and use a new ID
for a changed repository, issue, account or limit. Credential paths may change during controlled rotation.

## Operator flow

Open a text artifact in the Library. Expand **Review and send this artifact**, select a configured destination, load the
complete content, and check the approval box before sending. The review identifies repository, issue and account. The
server checks the exact artifact revision, content hash and destination hash again; it refuses archived, expired,
superseded, conflicting or source-stale records. Delivery approval does not certify the task's correctness.

The coordinator persists the full intent before transport. Its management API returns metadata and receipts without the
private intent text or credentials. It rejects a new request ID for the same artifact/content/destination while an existing
delivery is pending, unknown or sent. A lost UI response preserves the approval ID. **Check original delivery** performs
read-only observation; **Retry original delivery request** resubmits the same immutable ID and content. It never asks the
provider to create the same journaled intent again. A refused, cancelled or independently reconciled non-delivery requires
a new deliberate approval to attempt delivery under a new ID.

Management routes under `/orchestrator/api/`:

| Method and path | Contract |
| --- | --- |
| `GET publication/destinations` | Configured public targets and their hashes |
| `GET library/:id/publications` | Up to 100 recent artifact delivery records |
| `POST library/:id/publications` | `requestId`, artifact `revision`/`hash`, `destination`/`destinationHash` |
| `POST publications/:id/refresh` | Observe the original provider receipt, including after local ownership loss |
| `POST publications/:id/retry` | Retry the original transport intent with current ownership and artifact eligibility |

## Delivery and ownership semantics

The independent journal records `accepted` before provider preparation and `started` before the single provider POST.
Account lookup and target discovery are read-only. Ownership is verified again after those asynchronous operations and
immediately before dispatch. A definitive creation receipt produces `sent`; a complete documented refusal produces
`failed`. Ambiguous transport or response content produces `unknown`. On restart, undispatched accepted work becomes
`cancelled`, while started work becomes `unknown`. An existing ID always returns its original receipt or rejects changed
content; restart, handoff and transport retries cannot produce a second POST for that journaled intent.

The adapter uses GitHub's [issue comment REST API](https://docs.github.com/en/rest/issues/comments), including PR
top-level comments, with API version `2026-03-10`. It appends an invisible request/content/artifact marker. Observation
requires the exact body and account, and the target for direct comment lookup. It searches at most 20 pages of 100 comments;
an administrator can supply an external comment ID for direct inspection. Edited or deleted comments, an inaccessible
target or an exhausted search remain unresolved. Absence is never proof that a delayed provider request cannot still commit.
There is no claim of provider-native exactly-once delivery: the guarantee is one POST per intent in the retained journal.

Resource handoff waits for in-flight operations and all started/unknown receipts to settle. Local cancellation or a closed
HTTP connection cannot prove external quiescence. Receipt observation remains usable without a live coordinator lease,
allowing an operator to resolve a committed comment while a successor is waiting for activation.

The separate admin credential permits `receipt.resolve` with a nonempty explanatory `note` and independent `evidence`.
This is an explicit trusted-administrator assertion of settled non-delivery, not an automated inference from a missing
comment. It must establish that the old request cannot commit later. The client credential cannot make this assertion.
The journal preserves the reconciliation and returns `not_delivered` on later retries; it never resets the old ID.
Host-only RPC uses `POST /publication/v1`, bearer authentication and `x-dsh-publication` identity pinning. `publish` also
requires `x-dsh-owner`. Browser-origin requests are refused. `PublicationClient`, exported by the plugin, implements these
headers, bounded responses and private credential reads for host-side tools.

## Persistence and boundaries

The service uses a single-writer local SQLite journal with full synchronous commits and a process lock. Preserve that
journal across service restart. Cloning it into independently running publication services, rolling it back, losing it,
or restoring the ownership authority are not supported recovery procedures. The current 50,000-intent capacity limit
fails closed; production retention/archival must preserve deduplication history.

Coordinator checkpoints contain its publication intents and receipts, plus the referenced claimant/client credential file
paths. They do not copy credential contents or snapshot the independent publication journal. The
[checkpoint maintenance hold](023-checkpoint-recovery.md) remains mandatory. An older coordinator checkpoint may lack an
already accepted publication; activation must reconcile the independent journals before any new intents are allowed.
This increment does not supply restored-state activation or clean-host failover.

The implemented route is operator-approved text artifact delivery. Existing Source Outbox messaging is not rerouted
through it. Owned profiles retain their workspace-only Source and reject account CLI/repository mode. Feishu, review-thread
replies, git pushes/PR mutations, automatic mandate-bound publication and host-collected verification evidence remain
required work in the full architecture. A successful comment receipt is delivery evidence, not task verification.

## Qualification

The publication service tests use real HTTP boundaries with a local GitHub contract server. They cover lost service and
provider responses, late provider commits after local cancellation, restart, original-ID recovery, final owner checks,
handoff blocked by unknown outcomes, wrong account/content/destination refusal and separate administrator reconciliation.
Runtime and rendered React tests cover exact artifact review, concurrent duplicate approval, lost panel responses and
receipt observation after ownership loss. They do not send external messages.

The opt-in installed-Harness tests extend owned dedicated and managed real-model missions through artifact delivery,
unknown receipt observation and unchanged delivery after coordinator restart. The dedicated case also loads the actual
publication plugin in another Harness process and restarts it against the retained journal. A test-only fetch shim points
that child at the local contract server; production does not accept a provider-origin override. This qualifies Harness
composition and recovery behavior, not a live GitHub account deployment or browser layout/accessibility.

On 2026-11-08, `pnpm check` passed typechecking, 1,418 tests (7 opt-in tests skipped) and all four builds on Node 25.9.0.
Both owned installed-Harness/DeepSeek Flash scenarios passed separately in 191.34 seconds, including the dedicated
publication plugin restart. Exact code revision `fd058c95ad6046751fd0429a6046c1bb1e151316` also passed typechecking,
all four builds and 1,420 tests (5 opt-in tests skipped) with native Linux confinement in
[run 42540908750](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42540908750).
This is increment qualification; external account deployment and the remaining architecture are still open.
