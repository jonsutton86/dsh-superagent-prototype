# PR reviews bound to verified commits

This increment retains DeepSeek Harness and adds a distinct `github-pr-review` publication destination. It submits a
whole-pull-request `COMMENT`, `APPROVE`, or `REQUEST_CHANGES` review for an explicitly selected commit. Existing
`github-review` destinations still reply to an inline review comment. This does not implement merging, automatic
branch-policy evaluation, or completion of the full Agentic OS objective.

## Operator and host contract

Configure the destination on the independent publication host, whose private account credential remains outside worker
worlds. Repository, PR number, account, review event and destination ID are immutable once persisted; changing them
requires a new destination identity. The management panel supports English and Chinese.

```json
{
  "id": "checked-pr-7",
  "name": "Review PR 7",
  "kind": "github-pr-review",
  "repository": "owner/repository",
  "issue": 7,
  "login": "review-account",
  "event": "APPROVE",
  "maxBytes": 30000,
  "credentialFile": "/private/publication/github.token"
}
```

The artifact publication screen explicitly reads the current PR through the independent host. The host verifies its
account and provider response identity, then reads the exact head commit's tree. The observation binds numeric PR and
repository identities, author, head repository/ref/commit/tree, base repository/ref/commit, open/closed state, draft and
merged flags. Fork heads are supported when their repository and Git commit metadata remain accessible. Bot-authored
PRs are accepted. The current destination account contract uses a GitHub login matching letters, digits and hyphens.

The operator sees the configured review event, content, source and target branches, commit/tree IDs and observation time.
Only selected successful host checks whose commit and captured files match that head qualify. Inspecting a head again
clears consent and check selections. The client sends the expected observation hash; it cannot substitute provider facts.
The coordinator rereads the head, verifies selections and persists the exact binding before fresh source capture.

The publisher requires checked artifact evidence for every PR review, including operator-origin artifacts. Messages and
mission reply grants cannot use PR review destinations. It checks evidence at admission and immediately before dispatch,
after provider preparation and final head/account verification. Closed or merged PRs cannot receive new reviews through
this path; draft PRs cannot receive `APPROVE`. Ordinary comments and requested changes can target open drafts.

## Actual file proof

Git commit/tree metadata and an empty `git status` are insufficient: index flags can conceal changed working files.
Snapshot capture now computes `repository.contentTree` from the actual captured file bytes, executable modes and canonical
copied symlink text. It reconstructs Git blob/tree objects with Git ordering, supporting SHA-1 and SHA-256 repositories,
without deriving file content from the Git index or local object store. The selected check must bind all of:

- Local commit equals the observed PR head commit.
- Recorded commit tree and computed captured-content tree both equal the provider's head tree.
- Captured Git status is empty, and the original-world freshness capture still matches the checked snapshot.

Empty directories remain in the snapshot manifest but do not create Git tree entries. Extra included files, excluded
tracked files, submodules/gitlinks and symlinks whose text is rewritten during safe copying cannot establish this exact
tree proof. A repository using those cases needs an explicit future representation/support extension; this increment does
not silently treat a partial checkout as the full checked commit. The check runs in the captured source copy, so excluded
dependencies are not automatically present. Git filters or line-ending conversions that change working bytes also prevent
matching the committed tree. Snapshot/check bounds and the 60-second publisher freshness window from 046–048 remain.

Historical manifests and evidence seals remain readable. New Git captures include `contentTree`, so new checks are
required for Git-based approval after upgrade. Older checks cannot provide the new exact-content proof. Update coordinator,
publication host and execution/snapshot bundles together; discovery advertises optional `pullReviews: true`, and the
coordinator refuses PR approvals without it. This is not a mixed-version rolling-upgrade guarantee.

## Submission, races and recovery

The publisher sends one review POST with explicit `commit_id`, configured `event`, reviewed artifact text, visible commit
context and the original publication marker. It checks the returned account, PR URL, exact body, commit and review state;
review creation returns HTTP 200. Source: [GitHub's review API](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2026-03-10).

GitHub review creation has no expected-current-head compare-and-swap. The last head read reduces the race window but
cannot make head verification and POST atomic. If a push races with submission, the review remains on the explicitly
approved older commit. A sent receipt means that review was delivered, not that the PR's latest head is approved, that
branch protection is satisfied, or that it may merge. Merge uses a different API and head precondition and is not added
here. Source: [GitHub's pull-request API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10).

Lost acknowledgements retain the original intent and ID. Receipt observation runs before current artifact/head/freshness
gates; an old review can be recovered after head changes, source changes, archival or restart without a new capture or POST.
Observation requires the exact marker/body, account, target and commit. A dismissed review can confirm historical delivery
and is explicitly recorded as `DISMISSED`. Sent receipts are historical observations, not continuous monitoring of review
state. Unknown outcomes block replacement. New checked heads can receive separately approved reviews after the previous
review settles; held approvals never retarget themselves. Provider scans are bounded to 20 pages of 100 reviews, with
explicit review-ID observation available for reconciliation beyond that bound.

## Qualification and remaining work

Runtime revision `94f41c6911e7e0b49038358f9a96775b35352c7f` passed 1,806 local tests with 12 intentional skips,
typechecking and all five builds; the suite took 109.92 seconds. Linux / Node 24 passed 1,812 tests with seven skips,
typechecking and all builds in 151.80 seconds in
[run 42626886664](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42626886664).
This includes an actual native confined remote check, original-world freshness capture and matching PR review receipt.

The dedicated installed-Harness / DeepSeek Flash scenario passed in 61.74 seconds. The owned dedicated scenario also
passed, including actual checked review submission, lost-reply recovery and installed independent-publisher PR inspection.
The initial owned managed run passed the review path but failed a later recovery-fixture assertion: the fixture expected
one destination while the new PR review destination correctly made two. Test-only follow-up
`ca58691eee61977b6fe57943af2bbb59572368df` supplies the actual configured destination count; typechecking and seven
documentation/class checks passed. The owned managed rerun passed in 189.33 seconds, including its complete recovery path.
The follow-up revision passed typechecking, all five builds and 1,812 native Linux tests (seven skips) in 212.05 seconds
in [run 42627757241](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42627757241).
Runtime code is unchanged by this fixture correction.

Tests cover real Git trees, hidden file changes, all three review events, head races, account/identity changes, source
freshness, original receipt recovery, dismissal, capability/ownership refusal, unknown replacement blocking and rendered
approval. All provider effects use local HTTP contract fixtures. Installed-Harness qualification uses actual model-authored
artifacts and checked Git source through the coordinator. No real GitHub account review or merge is submitted. The original
app process remains running.

The broader delivery scope still includes mission-level repository/PR association and closure rules, remote repository
provisioning, CI/branch-policy integration, merge receipts/head preconditions, continuous freshness and a fresh whole-mission
closure policy. Every remaining architecture/product requirement in 010 and IMPLEMENTATION stays open.
