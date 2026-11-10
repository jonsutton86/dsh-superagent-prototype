# Paused work: independent repository publication

**Status: INCOMPLETE / NOT RELEASE-READY / PROJECT PAUSED.**

Saved on 2026-11-10 (America/New_York) at the owner's request to preserve unfinished work on GitHub.
This checkpoint does not resume development, complete milestone 075, qualify a deployment, or complete Agentic OS.
The full standalone architecture continues to retain DeepSeek Harness; Kun is not its runtime.

- Repository: `jonsutton86/dsh-superagent-prototype`
- Branch: `feat/full-superagent-architecture`
- Last completed increment: [074 Reviewed repository exports](074-repository-exports.md).
- Last completed source/documentation checkpoint: `e29fa1026738e3369aa4a1113fcbd314d793178d`.
- Full scope and earlier validation: [implementation tracker](IMPLEMENTATION.md) and [Agentic OS architecture](010-agentic-os.md).

## Work preserved in this checkpoint

The unfinished publisher accepts the reviewed Git bundles from increment 074. Its intended sequence is resumable private
upload, private Git import, fresh approval, branch creation, then pull-request creation. Each external write has a separate
durable receipt so an unknown outcome can be observed before any further action. The code currently exposes private service
RPCs; it is not yet an end-to-end feature in the Agentic OS workspace.

| Files | Work in progress |
| --- | --- |
| `src/publication/repository-model.ts` | Repository destinations, transfers, publication intents, receipts and bounded RPC contracts |
| `src/publication/repository-journal.ts` | SQLite transfer chunks, immutable intents, ownership history and restart handling |
| `src/publication/repository-git.ts` | Paired Harness subprocess execution, private bare import, bundle/object checks and branch creation conditioned on the ref being absent |
| `src/publication/repository-provider.ts` | Fixed-origin GitHub account/repository checks, PR creation and observation of original results |
| `src/publication/repository-publisher.ts` | Separately journaled branch/PR steps, evidence checks, ownership fencing, preparation cache, cancellation and explicit reconciliation |
| `src/publication/client.ts`, `protocol.ts`, `plugin.ts`, `service.ts` | Private RPC, Harness provider wiring and independent service integration |
| `src/ownership/inventory.ts`, `src/recovery/audit.ts` | Repository resource inventory; recovery refuses unrecorded repository effects |
| `tests/fixtures/git-server.ts`, `tests/fixtures/repository-publication.ts`, `tests/repository-publication.spec.ts` | Authenticated local Git push, simulated GitHub API, lost-reply and upload-integrity scenarios |

The fixture uses generated credentials and a local HTTPS Git server. Its evidence seals are contract fixtures, not proof
that the coordinator-to-publisher approval workflow is integrated. No live GitHub branch or PR was created by these tests.
The Git transport may retry an HTTP exchange internally; the tests distinguish wire requests from actual ref updates and
check that replaying the application request does not dispatch a second publication.

## Exact validation boundary

Before the last code edits, the following focused run passed **42 tests in 3 files** in **21.16 seconds**:

```sh
pnpm exec vitest run tests/repository-publication.spec.ts tests/publication.spec.ts tests/remote-repository.spec.ts
```

The new repository test file contained four cases: original Git history/PR publication, lost Git acknowledgement,
lost PR acknowledgement across publisher restart, and resumed/corrupted upload handling. Typechecking also passed on an
earlier working-tree revision. These results do **not** validate the exact code saved in this checkpoint.

The final edits added or changed the following and have **not been typechecked or tested since those changes**:

- Cancellation RPC and current-owner attribution for transfer cancellation.
- Service-level semantic validation of returned branch and PR receipts.
- Capacity accounting for in-flight imports and cleanup of expired preparation caches.
- Refusal to infer an external publication from an unsettled local import with no recorded dispatch.
- Subprocess executable resolution before creating its temporary import directory.

No full macOS suite, native Linux suite, build, installed-Harness publication qualification or live provider acceptance
has been completed for this increment. No new application tests were run merely to make this preservation checkpoint.
The module/test inventory in `docs/007-architecture.md` has not yet been updated for the new files, so the existing
documentation inventory checks are expected to need updates before the full suite can pass.

The earlier milestone's GitHub Actions dispatch was rejected with HTTP 422 because repository Actions was disabled.
That historical CI result is not a CI result for this checkpoint. No Actions or billing settings were changed.

## Remaining implementation and review

1. Review and test the final edits above, including concurrent prepares, cancellation, stale caches, ownership changes,
   mismatched provider receipts and unknown local subprocess outcomes. Verify that uncertainty cannot be mistaken for
   success or permission to replay an external write.
2. Add collision/race tests proving an existing branch cannot be overwritten; test wrong accounts/repositories,
   changed intents, stale/mismatched evidence, service-response loss, definitive PR refusal and lease loss between steps.
   Test ownership handoff and administrator reconciliation while uncertain effects remain outstanding.
3. Integrate with the coordinator: persist original publication intents before RPCs, transfer the actual reviewed export,
   recover partial uploads, prepare the private import before requesting fresh evidence, and retain original IDs after
   response loss. Keep publisher credentials outside worker workspaces.
4. Add workspace controls for destination/title/body/draft review, preparation status, fresh approval, observation,
   explicit continuation and cancellation. Private RPC availability is not a finished user-facing publication feature.
5. Complete recovery authority and receipt graphs for these coordinator records. Extend held receipt application and
   configuration verification. The current audit intentionally rejects unrecorded repository transfers/publications;
   do not treat adding inventory types as completed restore/failover support.
6. Finish lifecycle/storage policy: prepared import cleanup after interruption, retained bundle/chunk capacity and
   terminal receipt retention. Recheck process quiescence and ownership metadata across restart and cancellation.
7. Update the architecture inventory and write the completed increment guide only after the feature's actual scope and
   validation are established. Run appropriate focused tests, typecheck/build, full macOS and native Linux qualification,
   and installed-Harness publication checks. Record the exact tested revision and any skipped boundaries.
8. Broader repository work remains: fork targets, CI/branch policies, merge authorization, live provider acceptance,
   submodule/LFS provisioning and other items in the full implementation tracker. This checkpoint currently targets
   publication back to the same configured GitHub repository.

Cloud-host provisioning, physical cross-machine acceptance and clean-host recovery remain separate unfinished work.
No hosting purchase, provision, deployment, application restart or merge is part of saving this checkpoint.

## Resume boundary

Leave the project paused until the owner explicitly requests continuation. On resume, start from this saved branch and
review the work-in-progress code and the validation gaps above. Preserve the independent ownership and recovery barriers.
Do not report this checkpoint as a completed increment or use its earlier test figures as verification of later edits.
