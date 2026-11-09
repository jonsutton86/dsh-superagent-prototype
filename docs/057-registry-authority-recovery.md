# Registry authority in held recovery images

This increment extends [result evidence recovery](056-result-evidence-recovery.md) with read-only verification of persona
history, execution-environment generations, managed-world bindings and their original worker/Session references. The
DeepSeek Harness still owns Session persistence, model selection and execution services. Recovery constructs no Agent,
persona service, environment service or world pool, opens no execution credential, performs no filesystem probe and never
removes the restore hold.

## Persona history

Each persona's current record, immutable versions, command responses and event history must agree. Version digests cover
the original definition, including instructions, model preference, capabilities and embedded skills. Commands reconstruct
their exact create/update/archive request fingerprints and form a contiguous revision history. Versions are contiguous;
every saved snapshot and event is associated with its original command. Repeated archive commands remain distinct revisions.
Persisted data must already match its schema: admission defaults, trimming or unknown-field removal cannot manufacture
missing historical evidence.

Committed mission plans resolve their exact persona versions. Schedule admission only validates template shape; unresolved
future persona/world selections are counted explicitly and remain unadmitted until mission creation. A worker's full snapshot must match
both its original workspace Trigger and the immutable registry version. Updating or archiving today's catalog does not
replace an existing worker's persona. Recovery validates identity before constructing the inference check; Harness's
durable model selection remains authoritative for an existing Session, including a later explicit model selection.

## Execution generations

Enrolled environments retain their original configured and canonical roots. Event histories start with enrollment and
preserve enabled state, revisions and epochs. A no-op grant command creates another event without advancing its generation;
revocation, reauthorization and replacement retain their actual transitions. A replacement retires the old ID. Local
identity markers are validated as recorded metadata, without claiming the original filesystem is present or trusted now.

Managed worlds must agree with the original independent world journal: endpoint, grant, generation, root, permissions and
credential-version bindings. The saved activation grant must contain the original paired-service permissions. The original
revocation request and its command fingerprint are retained. Renewable lease/revision observations do not create a different
world identity. Revoked worlds remain revoked.

Task mandates, executions and assignment snapshots resolve their historical grants. The admitted generation must have been
enabled, and its original directory and execution mode must match its enrollment. Managed work remains attached to its
selected world. Later revocation does not invalidate the historical record or authorize a replacement. Older local work
without a complete immutable grant is counted explicitly; recovery does not pin it to today's enrollment.

Environment and managed-world command tables historically retain only request hashes and result IDs. Recovery checks hash
shape, catalog references and the minimum receipt count implied by the event history. The initial managed revocation is
reconstructable and checked exactly. Other requests cannot be reconstructed from their hashes; the signed summary calls
these `opaqueCommandReceipts`. It does not claim to prove those missing request payloads. Complete endpoint-registration
history and administration-to-activation cross-references remain separate work; existing independent administrative receipt
verification and private execution-configuration checks still apply.

## Session ownership

Authenticated Harness headers establish the immutable parent chain. Memoized bounded traversal verifies deep descendants
without treating a stored persona-owner anchor as independent proof of ancestry. Digest and owner pins must agree with the
original task. Remote presets and saved world pins must identify that task's world; a remote worker root also retains its
original working directory. Router descendants cannot claim worker ownership. Local directory comparison permits the
original configured-root/canonical-root alias, without probing either path.

Root pins written before Session creation can remain pending. A descendant header can commit before its decoration writes
the persona pin and lineage anchor; missing child pins are counted as incomplete historical bindings while ancestry and the
original task snapshot remain verified. A contradictory existing pin, missing parent, cycle or substituted worker persona
refuses preparation. New persona-bound root Sessions require the pins written before their creation. No missing pin is
created during recovery.

## Signed evidence and bounds

The optional `registryState` summary includes catalog/version/command/reference counts, environment events, managed worlds,
opaque command receipts, unresolved template references, execution and historical/legacy grant counts, Session pins and missing/pending bindings, plus a
deterministic SHA-256 over inspected rows and authenticated metadata. Historical grant counts count inspected relationships,
not distinct grants. The summary contains no definitions, prompts, credentials or filesystem paths. Older prepared manifests
remain readable without acquiring this additional proof. Original-ID retry returns the original signed image.

Scanning is limited to 250,000 charged records, 256 MiB of inspected serialized data, 8 MiB per charged value and two million
relationships. Repeated inspections count against the bound. The validator yields and observes cancellation; bounds are
validation limits, not measured deployment capacity. Contradiction discards the unpublished prepared image, leaving the
staged checkpoint and execution hold intact.

## Qualification and remaining work

Tests exercise actual persona, workspace, environment, endpoint and world-pool transactions; archived versions, no-op grants,
revocation/reauthorization/replacement, symlink enrollment, deep descendants, interrupted decoration, pending root pins,
legacy grants, corruption refusal without mutation, cancellation and oversized-state rejection. Pipeline tests exercise
signed archived history, original-ID retrieval, old-manifest compatibility and refusal before inference. Installed-Harness
recovery requires nonempty persona-version/worker/world evidence and historical grants with zero legacy task grants.

Full-suite, native Linux and installed-Harness qualification results will be recorded after this increment is verified.
Recall and usage/speculation budgets, full reflection state, remaining publication and registry cross-references, deployment
binding/remapping, actual restored activation/ownership handoff and clean-host failover remain open. The full standalone
Agentic OS scope is unchanged.
