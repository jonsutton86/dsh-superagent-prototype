# Artifact checks and operator evidence

This increment integrates the [host verification executor](046-host-verification.md) with immutable check definitions,
the artifact library, worker tools and operator UI. DeepSeek Harness remains the executor. New checks are disabled by
default and require explicit operator authority; a model can select an authorized version but cannot supply executable
commands, source provenance, exit outcomes or passing evidence through a check tool.

## Original execution and immutable definitions

The Engine copies directory, execution mode and environment generation into each new assignment. New worker library
submissions capture that assignment's location, assignment ID and Session ID. A retry creates a separate assignment and
cannot move a historical artifact to its new environment. Reviewed reflection artifacts retain their original assignment
when available; historical records without a captured location stay unbound. Worker submissions refuse a disagreement
between the current execution and original assignment. No historical path or environment is backfilled by inference.

Operator definitions pin argv, allowed non-secret environment overrides, stdin, artifact-relative path, source-capture
settings, timeout and minimum isolation. Scope is workspace-wide or one library scope. Every edit creates an immutable,
hashed version; authority switches apply across all its versions. Workers need both enabled and worker authority, access
to their own artifact, and their original live assignment. Operators may check a historical artifact at its original
location, subject to current artifact freshness, definition authority and environment availability. Per-definition
concurrency and UTC-day limits use current limits across all historical versions; a freshness capture consumes a run.

Registry mutations use optimistic revisions and durable request-ID receipts. A lost response returns the original result;
using the same ID for different input is refused. New definitions default to Linux isolation, disabled execution and no
worker requests. Definitions are bounded to 64,000 characters, 1,000 definitions, 1,000 versions per definition and 64 MiB
of registry/version/command metadata. Capacity rejection rolls the entire mutation back.

## Execution and evidence

Admission binds the immutable check version/hash, exact artifact revision/hash, scope, original assignment/Session,
environment generation and canonical source directory before dispatch. A durable pending run and original Harness job
ID precede execution. Remote runs use the original RemoteWorld and authenticated endpoint; missing or revoked worlds
cannot fall back to the coordinator host. The original job is attributed to the artifact's assignment in the execution
effect journal. Endpoint capability, request fingerprint, grant, generation, ownership continuity and receipt evidence
are validated before accepting a result. Lists omit manifest entries; detailed receipts retain the full manifest.

Local mode uses the same Harness subprocess provider and snapshot runner. Linux-required definitions refuse hosts without
the required confinement. The explicitly selected `host-process` mode clears ambient environment variables, uses private
scratch storage and checks a copied input tree, but is **not a filesystem, network or OS sandbox**. Commands can access
other host paths and network resources. This mode is for trusted operator commands and inputs, and is labelled as such in
the UI and evidence. Local execution is unavailable for profiles requiring an owned remote world.

A pass requires a complete valid host manifest, exact artifact bytes and source path, unchanged checked inputs, required
confinement, zero exit without a signal, output digests, finished timestamps, quiescence and no cancellation/error. It
proves what that command established for those inputs; it does not establish factual correctness. Historical successful
evidence remains historical after edits. A freshness request captures the original source again against the successful
manifest digest and artifact hash. It does not execute the check command, has no command outcome and is labelled
`captured`, never `passed`. It detects included file, executable-bit, symlink and recorded Git-state changes.

The service permits 8 active runs, 10,000 retained runs, a 512 MiB metadata/local-output envelope with 6 MiB reserved per
active run, and 2 GiB of local snapshot reservations. These are admission bounds, not filesystem quotas. Each local
stdout/stderr stream retains 1 MiB and exposes explicit retention gaps; host hashes cover the full observed output.
Remote output stays at its original endpoint and is read through bounded, validated windows. Control receipts are
limited to 20,000 entries and 64 MiB. Retention and operator archival remain future work.

## Cancellation, recovery and operator workflows

Cancellation persists its original ID and reason before requesting termination. An unknown run keeps its reservation;
restarting the coordinator never replays a command. Remote recovery observes the original job ID and original world.
Local recovery requires operator confirmation of actual process-range quiescence; a retained live handle must also
confirm exit. Reconciliation may release storage but cannot turn an unknown result into a pass. Cleanup only occurs
after quiescence. Shutdown aborts local checks, attempts bounded original-world cancellations and retains ambiguous
execution for observation. Observing existing receipts remains available when mutation authority is lost.

The Library exposes check creation, immutable editing and authority controls. Artifact details allow check-version
selection, history, exact evidence, Git commit/tree, execution location, output windows, original-job observation,
cancellation, explicit local quiescence review and fresh source capture. Stable command IDs survive lost responses;
deliberately requesting another check creates a new ID. English and Chinese controls use the same typed management API.
Worker tools expose only own-artifact list/request/read/output/cancel operations; reflection workers cannot request checks.

## Acceptance and remaining integration

Focused tests exercise actual local Harness subprocess execution and Linux endpoint execution, immutable definitions,
request deduplication, assignment retries, environment refusal, output hashes/retention, timeouts, cancellation, authority
withdrawal, unknown restart, source freshness and real operator HTTP/DOM flows. The installed-Harness qualification uses
an actual DeepSeek-created file and library artifact through coordinator check APIs and preserves check and capture
receipts across restart. Non-Linux live qualification explicitly uses the production host-process runner; native Linux
qualification supplies independent confinement evidence. Exact final qualification results are recorded after running.

This increment does **not** yet make a selected check mandatory for external publication or mission result acceptance.
The next integration must bind the operator's selected check and original source/Git/environment state to the approval,
capture freshness immediately before any new publication, and observe already accepted effects before considering a new
dispatch. Source capture and external publication are separate operations and do not provide an atomic filesystem/remote
transaction. Exact PR-head checks require real repository/PR integration; the current GitHub destination sends comments,
not a PR approval or merge. The remaining article/Agentic OS scope, including recovery activation/failover, managed machine
launch, supervision, voice, packaging, onboarding and long-horizon evaluation, remains open.
