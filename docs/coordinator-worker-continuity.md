# Coordinator/worker continuity repair

## Observed incident

Read-only inspection of the live qualification database on 2026-11-12 found:

- Coordinator identity: `orchestrator-414092242527b8139e694d5e7d42e06d`, persisted under `master-id`; it is not the worker Session or this diagnostic Session.
- Upgrade ticket: `b12f58c6636606c0c1b47ce312201436`; assignment `1f6ff51d626e201d9a6f09c73f2872fb` remained running with a blocked report.
- Three undelivered inputs: `57994f222df013c423a4b619e5dc0749` (explicit continuation authorization), `18c970b309da7ca09de867a7592be7fa` (plugin discovery request), `c50a519ce282aff0c1d8bf42583a296c` (inventory note).
- The handoff at `2026-11-13T00:28:42.536Z` created descendants stop `df5eec69-771f-4f01-966c-991ef84ad89c`. It became unknown, revision 2, with no dispatch or proof: original local registry continuity unavailable. The later human authorization did not release this stop, correctly.

Admission captured the worker's jobs/subagents services, but stop request and continuity still compared them with fresh **host** service reads using raw identity. Cordis also wraps tracked services in fresh proxies. Thus an ordinary live handoff could not establish its original binding. Delivery respects that held stop, so no continuation reached the worker. Deferred `Later` effects do not increment ordinary failure attempts; zero attempts and no error did not mean successful delivery.

The active profile links this bundle from this checkout. The runtime-context installation root itself has no Git checkout or DSH source tree; no installed Harness package was patched.

## Repair and boundaries

- Ownership, stop binding and continuity share one exact Agent/Session/registration check plus canonical underlying worker-service identity (`cordis.original`). Replacing the actual service is still a loss of continuity.
- Bound job observation, child drain and job cancellation use the **captured original worker registries**, not a different host registry or an empty replacement.
- No cold-stop proof is inferred from an ended prior assignment, a never-dispatched retry or an unloaded worker. Removed a pre-existing working-tree auto-release shortcut that did so. Actual undispatched assignments can retain their own narrow undispatched proof; they cannot clear a prior unknown stop.
- Coordinator authority remains Session-identity based, independent of selected preset. Existing guards still reject direct and nested execution calls, including late local registrations. Legacy coordinator descendants retain their denial.
- A shared tool-authority binding filters advertised schemas using the same name predicate as its monotonic guard. It covers coordinator, denied coordinator descendants and persona capability exclusions. These scopes explicitly use native presentation so forbidden schemas are not embedded in a PTC transport description; unrelated worker presentation is unchanged. No tool descriptions or parameter schemas were enlarged. The late-tool coordinator regression advertises only `orchestrator_read` and `skill`, rather than forbidden local execution schemas; denied descendants advertise none. This is surface alignment, not a substitute for dispatch authorization.
- Test hosts now model inherited worker registries and native turn-start events instead of relying on disconnected empty contexts or executing without a turn boundary.

No live ticket, stop, authorization, profile configuration or process was modified. Other pre-existing dirty work remains; these tests do not qualify all of it.

## Validation

Focused command uses installed binaries because the installed `pnpm` rejects the existing workspace YAML (allowBuilds only, missing packages field):

```sh
env -u GIT_CONFIG_GLOBAL ./node_modules/.bin/vitest run tests/router-authority.spec.ts tests/personas-runtime.spec.ts tests/executor-stop.spec.ts tests/executor-failure.spec.ts tests/stop-http.spec.ts tests/stop-views.spec.ts tests/model-surface.spec.ts
env -u GIT_CONFIG_GLOBAL ./node_modules/.bin/vitest run tests/runtime-concurrency.spec.ts -t 'delivers authorized continuation inputs'
./node_modules/.bin/tsc --noEmit
git diff --check
```

59 focused tests and the continuation integration test passed (60 unrelated cases deselected in the latter command); typecheck and whitespace checks passed. Real Cordis tests cover fresh proxies, distinct host/worker services, jobs/descendants/selected-job control, actual replacement before and during stop, missing original admission, operator evidence refusing active original jobs, coordinator preset-independent denial, late schemas, persona exclusions, and unrelated worker isolation.

An expanded run of the two runtime suites is **not green**: seven runtime and eight concurrency failures remain (after clearing inherited GIT_CONFIG_GLOBAL); the initial PTC fixture failure was corrected and the focused suite rerun. Failures include old no-current-turn prompt assertions and restart/deleted-Session/unknown-stop expectations. Baseline equivalence has not been established; no full-suite pass or live upgrade recovery is claimed.

Final production build and declaration generation passed in isolated `/tmp/dsh-authority-final.WiVCf3`, leaving the live linked build untouched. Temporary build/test logs are `/tmp/dsh-authority-final-build.log` and `/tmp/dsh-authority-tests.log` (the latter expanded run is intentionally failing evidence). The final 59-test pass plus continuation integration pass, typecheck and whitespace check were repeated after the denied-descendant surface change.

## Activation and existing ticket recovery

The live profile loads built JavaScript, not these TypeScript edits. Rebuild this bundle with its normal tsdown build (or a compatible pnpm version running the build script), then perform a controlled restart of the existing `agentic-os` Harness host. No replacement server is needed. These are host-side changes; refreshing the browser alone cannot apply them. No DSH Web shell rebuild is required for this repair.

A restart loses process-local original-binding evidence. It is **not** a method of clearing the existing upgrade stop. Inspect that exact original receipt and validate original-bound stop/operator evidence using the supported stop controls; do not delete the receipt, edit SQLite, synthesize proof from an empty new registry, or reinterpret the continuation text as authority to bypass a stop. Once the original stop is legitimately released and the fixed host is active, use the normal ticket input/authorized retry path. Existing continuation input IDs remain queued for deduplicated delivery.
