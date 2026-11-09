# 056 Artifact and result evidence in held recovery

Prepared images now check the recorded library, host verification and completion relationships after core, connector and
workspace authority verification. The operation reads the exclusively held private Store and records an optional signed
`resultState` version 1. It does not execute commands, contact an execution provider, refresh a source, approve a result or
remove the restore hold.

## Content and provenance

Every library blob must match its SHA-256 and byte count. Records must match their physical scope/kind/expiry indexes,
content type and text encoding. Memory limits, original scoped sources and exact source hashes remain enforced. The stored
provenance edges and search projection must agree with the authoritative records and content. Missing or inconsistent
projections fail preparation; this increment does not repair them. Library command counts must agree with each record's
publication/archive revision, preserving the original replay receipts.

Worker authorship retains the original ticket, Trigger hash, assignment and stable Harness Session identity. Original
assignment locations are compared when present. Older records or assignments without execution bindings remain explicitly
legacy; a newer ticket location is never substituted. Superseded, expired and archived records remain historical data.
Reviewed reflection memories retain their proposal, original worker authorship, candidate content and captured provenance.
Reflection-approved plan versions are also recognized through their actual proposal journal, correcting the earlier
ordinary-planner-only lookup. Full reflection snapshots, read allowances and scheduling budgets remain separate graphs.

## Check and approval history

Check versions retain their exact definition hash. Configuration command receipts must form a complete revision history
and reproduce the current definition and enabled/worker flags. Each run retains its original artifact, version, execution
binding, assignment owner, command, request fingerprint and endpoint receipt when present. Snapshot manifests are checked
against their entries and totals. Successful checks and freshness captures use the same pure evidence predicates as normal
runtime approval. Local retained output is checked against its recorded byte count and, when complete, its output hash.
Truncated output retains the authenticated host hash but cannot independently reconstruct discarded bytes; partial streams
are counted explicitly. Remote output bytes remain at the original endpoint.

A later provider observation error does not erase a past complete host result. Current runtime approval still requires
current authority and availability; recovery only authenticates the historical evidence. Failed, pending and unknown runs
are preserved without turning them into success or concluding that an original process has stopped. Endpoint receipt
reconciliation remains the independent audit/application path. Local process reconciliation and deployment activation
remain required before running a restored system.

Reviews retain exact selected check evidence, grouped source snapshots and every original capture ID. An interrupted
attempt may have reserved a capture that was never submitted; recovery preserves that identity without dispatching it.
Seals must match the original check and completed source capture, including the recorded freshness window. The window is
not renewed against today's clock. Accepted action results must belong to that action's original tickets. Whole-mission
completion retains its original command, target, action list and closure-review evidence.

New successful review attempts now retain immutable evidence seals in their attempt history. Previously, an explicit repeat
review could replace the latest seals and lose the exact prior completion evidence. New attempts carry `evidenceVersion: 1`;
old attempts remain readable and missing historical seal evidence is counted explicitly rather than fabricated. New complete
history must reproduce a completion's exact evidence hash even after a later capture. PR freshness and provider publication
authority remain their existing runtime/independent-service checks; this increment does not grant merge or publication rights.

## Bounds and evidence

The signed summary records library/blob sizes, provenance edges, legacy binding counts, check/version/run counts,
successful and unsettled runs, reviews/seals, legacy review evidence, completion and reflection-promotion counts, partial
output streams and a deterministic SHA-256 over inspected rows/content. It contains no artifact text, commands or credentials.
Original-ID retry returns the same authenticated image. Old manifests remain readable without acquiring this new proof.

The validator yields during scanning and observes cancellation. It refuses more than 250,000 inspected records, 768 MiB of
inspected content/serialized values, 8 MiB per JSON row or two million relationships, with smaller content/schema bounds.
Repeated references count toward these limits; they are validation bounds rather than demonstrated deployment capacity.
Failure discards the unpublished image. Original/staged state and the execution hold remain unchanged apart from normal
preparation bookkeeping. No verification service is instantiated during recovery because its constructor has restart
behavior that must not run inside a read-only validation step.

Other product graphs, including persona/environment registries, recall and usage/speculation budgets, full reflection state
and publication cross-references, still require recovery qualification. Deployment binding/remapping, restored activation,
ownership handoff and clean-host failover remain open with the full architecture/product objective.

## Qualification

Tests use actual Library/Workspace transactions, Harness subprocess checks, freshness captures and the original remote
endpoint. They cover accepted/completed missions, repeated historical reviews, archived results, disabled definitions,
later observation failures, interrupted capture submission, legacy evidence, reflection memory/plan promotions, corruption
refusal without mutation, cancellation and bounded diagnostics. Pipeline tests cover signed original content, identical
image retrieval and cleanup after an authentic checkpoint contains contradictory blob bytes. Installed-Harness recovery
requires nonempty artifact, successful-check, review and mission-completion evidence with zero legacy review seals.

Local verification passed 1,893 tests (14 conditional skips), typechecking and all six builds. The final persisted-field
normalization regression passed with all 18 focused result/reflection tests. Runtime/test revision
`3731d1800633b6d2d6bf2fea8d7b0730ef383112` passed 1,900 tests (eight conditional skips), typechecking and all six builds
on Linux / Node 24 with native confinement in
[run 42669190774](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42669190774).
The exact revision passed the installed-Harness / DeepSeek Flash owned-managed recovery scenario in 206.85 seconds. Its
signed image contained nonempty artifact, successful-check, review and completed-mission evidence, with zero legacy review
seals. Original-ID retry retrieved the same authenticated held image. Inference used the configured real API; external
provider operations stayed on local contract servers. The original app remained running. These results qualify held
artifact/result evidence, not restored activation or completion of the full architecture/product objective.
