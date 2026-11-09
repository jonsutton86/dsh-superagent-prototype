# Host-captured verification execution

This increment supplies the execution and evidence layer for verified artifacts. It extends the existing authenticated,
ownership-fenced endpoint job protocol and DeepSeek Harness subprocess provider. It does not add another agent executor.
The endpoint advertises `snapshotVerification` only when the standalone snapshot helper is installed.

## Captured inputs and command evidence

A `job.spawn` request may include `verification.kind: 'check'` or `'capture'`. The complete request, grant generation,
ownership stamp and host attribution retain the existing durable job ID and fingerprint. Check requests support an exact
artifact path/SHA-256, expected snapshot digest and expected Git commit/tree. These are preconditions: a mismatch prevents
the check command from starting. Capturing alone never produces a command exit outcome or a passing check.

The helper reads actual files, hashes bytes and executable bits, and records canonical internal symlink targets. It copies
included inputs into a new endpoint-private directory outside the source. `.git` is omitted from that copy. When a Git
repository is present or required, commit, tree, branch and a porcelain-status digest are collected independently before
and after capture; observed changes fail capture. Global Git configuration, hooks and fsmonitor are disabled. The manifest
hash has canonical object-key ordering and excludes timestamps and storage location. Its schema, digest and totals are
validated after helper transport. These hashes establish integrity; authenticated host receipts establish provenance.

Capture rejects paths outside the source, escaped or excluded symlink targets, missing link targets, special files,
observed file/directory replacement and incomplete bounds. Defaults permit 10,000 paths, 256 MiB and 120 seconds per
capture; hard configurable maxima are 20,000 paths, 1 GiB and 300 seconds. A directory's immediate enumeration is also
bounded by the path allowance. Entry metadata is limited to 2 MiB. Explicit relative-path exclusions are part of the
manifest and its digest. A failed bounded capture never becomes a partially verified result.

The actual command runs against the copied source, followed by a second capture of that copy. A complete check requires
matching before/after input manifests, a zero exit code without timeout/cancellation/error, and confirmed managed-range
quiescence. Command start/finish times, the original argv/environment/stdin, manifest, optional artifact hash, exit/signal
outcome and SHA-256/byte totals for both output streams remain in the original receipt. Output hashes cover all observed
bytes; the existing bounded log API separately exposes retention gaps. An exit-zero signal trap cannot turn a timeout
into success. A failed command may have complete evidence; that is still a failed check.

The captured files prove which bytes were checked, not that a concurrently edited directory represented one atomic
filesystem instant or that the check establishes semantic correctness. A later source change does not alter historical
evidence. A new capture or an `expectedSnapshot`/`expectedRepository` precondition detects changes for a later decision.
Dirty working files are represented by their own hashes in addition to Git commit/tree identity.

## Confinement and lifecycle

On the production Linux endpoint, the capture helper receives a read-only source mount and one writable private output
mount. The check receives only a read-only copy, system runtime mounts and a private writable `/tmp`. The original
workspace, endpoint control state and endpoint credential mounts are absent. Network namespaces remain isolated even
when the original grant permits network access. `fs.read` and `process.spawn` are both required; normal command grants,
ownership checks, capacity, revocation and process cancellation continue to apply.

Preparation is checkpointed before creating storage, and each subprocess is checkpointed before dispatch. A restart
retains an interrupted attempt as unknown rather than repeating capture or the check. Original-ID retries return its
receipt. Unexpected existing snapshot storage also becomes unknown and is neither reused nor deleted. Confirmed process
quiescence permits private-copy removal; otherwise the storage reservation stays charged. Explicit reconciliation may
allow cleanup but never creates a successful check result. Cleanup failures remain charged and are retried by bounded
maintenance. Endpoint admission reserves up to a total 2 GiB using logical file limits plus per-path and metadata
allowances; this is admission accounting, not a filesystem quota on arbitrary scratch output.

The helper is a separate self-contained build, including its schema dependency. Existing generic commands and credential
mounting retain their prior behavior. Full job listing now observes a 6 MiB page budget so bounded manifests cannot make
the endpoint's 8 MiB response limit unusable. Administrative catalogs remain free of command payloads and file manifests.
Host consumers can use the exported `RemoteClient`, verification schemas and manifest validation from
`dsh-superagent/remote-client`; losing a response requires observing/retrying the original request ID.

## Qualification and remaining integration

Tests exercise real Harness process providers and authenticated HTTP for source changes during a check, Git empty commits,
artifact mismatches, capture-only receipts, output retention, failed commands, timeout traps, cancellation, reservations,
missing capabilities, restart uncertainty and reconciled storage cleanup. Native Linux cases check read-only inputs,
hidden originals, missing credential mounts and denied host-loopback connections. The opt-in dedicated installed-Harness
scenario runs a host-authored check against an actual DeepSeek-generated file and its library artifact, uses the built
snapshot helper, and checks unchanged receipts after coordinator restart. macOS fixture isolation is explicitly
`test-only-unconfined`; it does not qualify a production macOS security boundary.

This is the execution layer, not completion of the verified-delivery feature. Operator-authored versioned check definitions,
coordinator request/observation APIs, worker access to configured checks, local execution support, library/inbox evidence
surfaces, publication-time freshness gates and exact PR-head integration remain required. Generic recovery inventories
retain their existing command outcome projection; they do not import verification manifests as approval evidence. No
existing model-submitted library record is automatically relabeled verified, and publication rules are not weakened.
Dependency provisioning and check commands that need build outputs must use explicit scratch paths or later environment
preparation; immutable source mounts do not promise arbitrary repository test commands will work unchanged.
All remaining article and full Agentic OS requirements stay active.

Final local, native Linux and installed-Harness results are recorded in the implementation ledger after execution.
