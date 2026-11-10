# Independent repository publication

Status: implementation resumed on 2026-11-10. This document begins with the observed contract at checkpoint
`5c487b6729acd0ac931499d5fd6844a647cc8304`; coordinator/UI and recovery integration are implemented. Full qualification is in progress.
DeepSeek Harness remains the runtime. The [reviewed export](074-repository-exports.md) is its input.

## Evidence and baseline

Codegraph 1.6.2 indexed 509 files, 13,249 nodes and 48,646 edges. REA 6.8.0, running on Node 24.22.1,
statically analyzed 13 selected sources across coordinator, export, publisher, review and ownership boundaries.
The [compact evidence record](evidence/075-publication-baseline.json) preserves the source revision, file hashes,
REA evidence/node IDs, source ranges, coverage limitations and baseline checks. The complete 34 MB local evidence bundle
is under ignored `.artifacts/resume-2026-11-10/`; the graph database is local and excluded from Git.

A second [integrated-source evidence record](evidence/075-integrated-source.json) captures eight implemented coordinator,
observation, recovery and provider modules, their exact SHA-256 digests and REA evidence identity. All eight parsed;
304 other inventoried sources were unselected. This remains static evidence, paired with the executed tests below.

The selected sources parsed without failures. REA reports partial graph coverage: 290 inventoried files were unselected,
and dynamic calls have explicit unknowns. Its syntax observations do not prove runtime ordering or absence of other paths.
Codegraph provides current source and relationships; the contract below combines those observations with code inspection
and executed local contract tests. Native binary decompilation is unnecessary for these available TypeScript boundaries.

The exact saved checkpoint passed `pnpm typecheck` and 42 tests across `repository-publication.spec.ts`,
`publication.spec.ts` and `remote-repository.spec.ts` in 22.55 seconds on macOS / Node 25.9.0.
This establishes a new baseline; it does not substitute for targeted coverage of the five late edit groups or full qualification.
The tests use an authenticated local Git server and simulated GitHub API; no live Git provider or model was called.

## Actual contract at the checkpoint

| Stage | Observed persisted state and operation | Recovery boundary |
| --- | --- | --- |
| Export approval | `RepositoryExports.prepare` writes the original request, checks, source/world/assignment, and deterministic command ID into `repository_export` before its job | Same ID with changed content is refused; restart holds the original request |
| Export transfer | `execute` records bundle metadata, then commits each `repository_export_chunk` and received offset atomically | Original job and byte offsets survive retry; stored bytes are verified in order and against the whole bundle hash |
| Export review | `VerificationReviews.prepare` records its original request and capture attempts in `verification_review` before scanning | Existing unsettled capture IDs are observed, not replaced; a fresh capture must match the checked source before the export becomes ready |
| Publisher transfer | `repository.transfer.begin/chunk/finish` records an immutable transfer hash, owner history, bounded chunks and digest in the independent journal | Explicit begin resumes the same transfer under a new owner; changed bytes or intent are refused |
| Private import | `repository.prepare` accepts one immutable publication intent, records `preparing`, imports the bundle, and holds it with an ephemeral prepared-process cache | Restart loses the cache and requires explicit preparation; it does not push anything |
| Branch dispatch | `repository.publish` checks fresh seals and owner, then `boundary` durably records a branch attempt before calling Git | An empty expected-ref lease conditions creation on the branch being absent; uncertain results become `unknown` |
| PR dispatch | The confirmed branch result is saved before another account/branch check and independently recorded PR attempt | A lost PR response cannot repeat the branch or automatically resend the PR |
| Observation | `repository.receipt.observe` looks for the original branch or exact PR only after a matching recorded dispatch | A confirmed branch holds before explicit PR continuation; missing results remain unknown; an unsettled local import cannot be adopted as an external push |
| Cancellation | `repository.receipt.cancel` cancels an inactive undispatched next step and discards its private preparation cache | It preserves a previously created branch; uncertain, working and published operations cannot be cancelled into apparent non-delivery |

The existing `Publications` coordinator class records `workspace_publication` intents for comments/reviews. It does not
call the new `repository.*` workflow at this checkpoint. `RepositoryExports.download` exposes reviewed bytes, but no
coordinator publication intent connects those bytes to a destination/title/body/draft approval. There is consequently
no existing end-to-end coordinator-to-repository-publisher workflow to claim as complete.

The missing integration must persist the approved export, destination snapshot, original publication/transfer/review IDs
and owner attempts before RPC delivery. It must upload/resume and prepare the private import before requesting new fresh
seals, validate returned receipts against that intent, and observe the original operation after an ambiguous response.
Provider credentials remain at the independent publisher. The UI must make preparation, approval, observation and
continuation distinct actions and preserve the original submitted ID after transport failure.

## Persistence consolidation decision

The apparent parallel tiers do not currently prove redundant storage authority:

| State | Owner and purpose | Decision |
| --- | --- | --- |
| Export intent, bytes and source review | Coordinator Store; binds user-selected checks to the original execution and checkpointed artifact | Retain |
| Transfer bytes and publication intent/receipt | Independent publisher; can recover and reconcile effects while the coordinator is unavailable | Retain the independent copy; it is not interchangeable with the coordinator's copy |
| Branch and PR attempts | Already co-located in one `repository_publication` record in the existing `PublicationJournal` SQLite database | No extra database or event store is needed |
| Ownership authority and resource floor | Independent authority grants a writer generation; each resource fences stale generations | Retain separate authority; a receipt cannot grant ownership |
| Inventory/audit | Derived resource metadata and revision-bound comparisons, not another execution dispatcher | Retain; missing coordinator intents must remain an audit failure |
| Prepared imports | Ephemeral private cache, not a persistent source of permission | Rebuild explicitly after restart; never infer a dispatch from cache existence |

The version-pinned Fabric `review_design` and `review_code` patterns, with `prompts/operations/EVIDENCE.md` wrapper v1,
were applied to these responsibilities, failure boundaries and source observations; no inference provider was changed.

Shared implementation existed in the bounded chunk readers of `RepositoryExports.chunks` and `RepositoryJournal.chunks`:
both check negative offsets, contiguous ranges, per-chunk SHA-256, total size and whole-file SHA-256. This is a candidate for
a shared verification primitive. It is now extracted into `repository-chunks.ts`, with each store retaining its own tables,
transactions, capacity, lifetime and error contract. Read-only recovery also verifies partial transfers and charges an
independent audit budget; its different contract was not collapsed into the complete-bundle reader.
No consolidation of authority-bearing persistence is justified by the captured evidence. A migration that erases either
side's original intent would weaken response-loss and independent-recovery behavior rather than remove redundancy.

## Coordinator and workspace integration

`RepositoryPublications` adds one `workspace_repository_publication` record in the existing coordinator Store. It retains
the original export fingerprint, destination snapshot, complete transfer/publication intent, owner history and every explicit
approval ID. It adds no provider credentials to the coordinator or worker. The transfer and publication share the original
request UUID; freshness captures retain their separate explicit approval UUIDs in `verification_review`.

Preparation uploads original verified chunks from the received offset, finishes the independent transfer, and confirms a
private import. It does not push a branch. Publication rechecks that import before collecting fresh evidence, records the
approved seals and `dispatched` boundary before RPC, and validates returned branch/PR receipts against the retained intent.
Replaying a dispatched approval only observes its original result. A new explicit approval may continue a known held next
step; unknown results remain blocked. Refresh is observation-only and remains available after local ownership loss.
Restart holds private readiness because the independent process cache is not durable permission.

Cancellation records its request before contacting the service, waits for an active local operation, and preserves any
existing branch. It cannot turn an unknown result into non-delivery. Referenced exports cannot be cancelled into missing
recovery evidence. Existing count/byte/history limits remain enforced; this increment does not silently garbage-collect
terminal authority receipts. Independent publisher transfers referenced by any publication retain their original bytes.

| Workspace API | Meaning |
| --- | --- |
| `GET repository-publication/destinations` | Independently configured repository/base/account identities |
| `GET/POST repository-exports/:id/publications` | Retained intents / private preparation of one exact reviewed export |
| `GET repository-publications/:id` | Original intent and observed status |
| `POST repository-publications/:id/retry` | Resume only the original private preparation |
| `POST repository-publications/:id/publish` | Explicit approval UUID, fresh source evidence, then next known external steps |
| `POST repository-publications/:id/refresh` | Observe the original transfer/branch/PR; never dispatch |
| `POST repository-publications/:id/cancel` | Cancel the undispatched remainder; never delete an existing branch |

The workspace shows the reviewed commit/base, destination identity/account, title/body/draft mode, upload status and
separate branch/PR results. Preparation does not imply approval. Explicit fresh consent is invalidated when the reviewed
intent or external progress changes. A lost submission retains its request ID. An uncertain result exposes observation;
an unconfirmed cancellation can be confirmed again using the same retained operation.

Held recovery validates each intent against its ready export, original checks/captures, service binding, destination hash,
owner history and dispatched approvals. Exhaustive independent inventory and same-revision observations must agree.
Missing private work is recoverable only where no historical receipt or dispatch says it must exist; it becomes held,
never ready or published. Previously observed or dispatched records cannot disappear. Repository-only publisher profiles
also receive read-only account/repository checks at the audited inventory revision.

These changes are not yet a deployment qualification. Current tests exercise real local Git, host captures and authenticated
publisher transport, with explicit fixture-only local-to-GitHub URL mapping. They do not demonstrate live GitHub acceptance.

## Outstanding validation and integration

Eleven targeted tests passed in 15.71 seconds, with typechecking, before the chunk-reader extraction. They cover
cancellation/current-owner attribution, returned-receipt binding, concurrent import capacity and expired caches,
unsettled-import observation refusal, executable-resolution failure before temporary directory creation, a competing branch
between preflight and push, and owner handoff between branch and PR. No production defect was found in those five edit groups.
The shared chunk verifier subsequently passed 21 tests across publication, boundary and export suites (46.85 seconds),
with typechecking. These checks precede the coordinator integration above.
Six coordinator integration tests subsequently passed (63.49 seconds); the final added ownership-loss observation assertion
passed separately (11.86 seconds). Fifteen UI/locale/publication tests passed, including four new repository UI scenarios.
Current work preserves the independently merged Git branch-name fix `3d62647a5e1d558b3c614d06701cdd8fa2bd264f`.
An observed fixture timing failure was corrected by using one clock sample for capture and expiry; the production 60-second
freshness constraint remains unchanged. Final full-suite qualification must name the later committed source revision.
The installed Harness 0.2.1-rc.3 publication test passed (68.66 seconds), including actual paired private Git import,
one create-only push, a lost PR acknowledgement, hard restarts and original-result observation. It uses local contract
transports and synthetic seals; the coordinator suite separately qualifies actual host evidence. Hard restart respects the
existing 30-second single-writer stale-lock interval; an uncertain result must be observed before ownership takeover.

Full encrypted checkpoint recovery also passed: original Harness Session events were persisted through real JSONL, encrypted,
staged and reconciled into an authenticated held image. A substituted observation was refused, then the original preparation
ID recovered the published receipt without a second push/POST. Review found and corrected queued cancellation overtaking
and missing reconciliation metadata. Their focused regressions passed; final full-suite checks follow.

Native Linux, full-suite qualification and live provider acceptance remain open at this source checkpoint. Terminal receipt
garbage collection, fork destinations, broader Git provisioning, CI/branch-policy and merge authorization remain separate
architecture work. The remaining full architecture from
[Agentic OS](010-agentic-os.md) is unchanged.
