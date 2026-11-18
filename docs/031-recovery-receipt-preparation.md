# 031 Recovery receipt preparation

After a complete matched [receipt audit](030-recovery-receipt-audit.md), maintenance can apply independent observations to a
separate recovery image. Commands, file mutations, artifact publications and mission replies keep their original identities
and attribution. No command or publication is resent. The source checkpoint and staged state remain unchanged apart from
maintenance metadata. Both the source and prepared image retain an execution hold.

## Observations and state changes

Execution endpoints and publication services expose administrator-only `recovery.receipt` alongside `recovery.inventory`.
The request selects a kind, original ID and exact inventory revision. The response contains that same revision, resource
identity, quiescence, inventory item and a safe observation. It refuses changed revisions, unsupported kinds and missing IDs.
Endpoint observations omit arguments, environment, output, file contents, raw error diagnostics and reconciliation notes.
They retain owner, ownership stamp, phase, quiescence, command exit outcome, failure indication and reconciliation timestamp.
Publication observations use the existing receipt schema, including external receipt and independent reconciliation evidence;
publication text and account credentials are absent.

Preparation reauthenticates the encrypted checkpoint and original staged logical state under its writer lock. The exact
authority reservation must remain vacant, with the same epoch, recovery selection and complete enrolled resource set.
Every audit resource must remain quiescent at the recorded revision. All resources and the authority are checked before
observation and again immediately before publishing the image. A restart, new receipt, changed grant or changed ownership
invalidates preparation. These observations describe a past cut; they do not reserve future execution authority.

The new image copies the coordinator database, world journals and authenticated logical Session archives. Execution
observations are checked against original request fingerprints, grant/epoch, task/tool ownership and known results before
the existing effect journal applies them. Confirmed quiescent source records retain their established outcomes. Pending
records become recovered observations. Independent failure and reconciliation status is preserved with safe diagnostic
text. Settled execution is not a claim that a task succeeded.

Artifact and channel publication rows receive their exact independent terminal receipts. The original intent, ownership
attempts and withdrawn state remain. Channel receipt settlement uses the existing Outbox repository and original message
ID, preserving its idempotence and delivery ordering. Preparation does not finish tasks, invent model/tool Session events,
change source cursors or rewrite administrative command history. Session archive files remain unchanged; importing and
validating a live Session backend is specified in `035-session-backend-recovery.md` and is now required during preparation.

## Maintenance operation

Use the offline maintenance profile and private resource administrator connections documented in the receipt audit.
Keep the stopped source coordinator and watchdog stopped; independent authority, endpoints and publisher stay available.
Use `prepare-receipts` with the selected matched audit ID and a newly generated request UUID:

```yaml
- insert:
    - id: recovery
      name: dsh-superagent/recovery
      config:
        mode: prepare-receipts
        checkpoint: /private/backups/<checkpoint-uuid>
        keyFile: /private/recovery-keys/coordinator.key
        destination: /private/restores/selected
        receiptFile: /private/receipts/prepare-first.json
        preparation:
          requestId: <preparation-request-uuid>
          auditId: <selected-matched-audit-uuid>
        audit:
          authority:
            url: http://127.0.0.1:61000
            authorityId: <original-authority-uuid>
            coordinatorId: personal-agent
            credentialFile: /private/authority/admin.token
          endpoints:
            - url: http://127.0.0.1:62000
              endpointId: <original-endpoint-uuid>
              credentialFile: /private/endpoint/admin.token
          publication:
            url: http://127.0.0.1:63000
            serviceId: <original-publication-uuid>
            credentialFile: /private/publication/admin.token
```

Run `dsh --profile maintenance --patch prepare.yml --no-open`, then stop that maintenance host. Use the same complete
connection catalog as the audit; omit publication only when no original publisher exists. Administrator credentials must
remain private owned files outside every recorded execution workspace. The exported `prepareCheckpointReceipts` helper
provides the same operation; `verifyReceiptImage` authenticates an existing prepared image. No model tool or management
HTTP mutation exposes this maintenance capability.

Select the imported destination Session backend in the maintenance profile. Preparation now verifies its exact logical
history under exclusive Session writer handles; the exported helper requires `persistence`. See
`035-session-backend-recovery.md` for selection, catalog-race limits and the historical scope of original-ID retries.

## Original-request retries and atomic publication

`KV.recovery.preparation` persists the request and selected audit before contacting resources or building state. Only one
preparation request is accepted per staged restore. A changed request, audit ID or bound connection request is refused.
A later audit does not replace the captured selection. After failure, retry the original request only while its resource
revisions still match. If a newer cut is required, stage and review a separate restore rather than replacing the intent.

All updates occur in a private temporary directory. SQLite databases are closed without WAL dependencies. Every member is
hashed and synced. `prepared.json` authenticates the file set, hashes/sizes, source checkpoint digest, request/audit,
reservation, resource revisions and observation counts with a domain-separated HMAC-SHA256 using the recovery key. The
complete directory is atomically renamed to `destination/prepared-<requestId>` and its parent is synced before recording
completion. The completion receipt includes that path, manifest and `executionOwnership: false`.

The prepared image contains private plaintext state, like a staged restore; it is not an encrypted backup. Keep it under
the same private filesystem controls. The signed manifest contains no credential values, original command/file payloads
or publication text. Verification checks private regular files, rejects extra/unlisted files and validates all member bytes.

A lost completion acknowledgement is recovered by authenticating the already published original image. This returns the
same historical result even if resources are later unavailable or changed, and grants no execution permission. A missing
previously completed image or a changed image is refused. An interrupted empty private target reservation may be retried;
nonempty or linked targets are never overwritten. Cancellation and ordinary failures remove unpublished temporary state.
A process crash can leave private `.prepare-*` scratch directories; those are not completed images and are never adopted.

## Acceptance and remaining work

The deterministic HTTP tests cover all three publication providers, pending command/file acknowledgements, withdrawn
channel observation and Outbox settlement, original-state preservation, continued Runtime refusal, administrator scope,
payload exclusion, blocked/unselected audits, immutable request selection, offline retry, interrupted target reservation,
lost completion acknowledgement, revision changes before and after collection, attribution mismatch, cancellation and
tampered manifests/members/file sets. The installed-Harness qualification exercises preparation and repeated verification
on a matched managed checkpoint, and refusal on the dedicated checkpoint with intentionally unrecorded publication probes.

This completes the held receipt-application step. Administrative command/configuration reconciliation, authoritative
input/state recovery, actual Session-backend validation, world/workspace and credential remapping, activation and clean-host
crash/failover drills remain required. The prepared hold is distinct from the source staged hold and cannot pass the staged
checkpoint maintenance path. The Runtime checks either hold through a read-only connection before opening the writable Store, preserving prepared-image bytes even after a refused startup. The full article and Agentic OS implementation ledgers remain
active; neither a matched audit nor a prepared image proves that no later input or in-memory decision was lost.

Local verification on 2026-11-08 passed 1,495 tests, typechecking and all four builds; seven opt-in/platform cases were
skipped. All 27 recovery audit/preparation cases passed. The native mission cancellation fixture now waits for observed
process output before cancelling, because an accepted endpoint receipt precedes process dispatch; its 30 local remote tests
passed separately. The source-consumer timeout fixture waits for a positive PID rather than reading a briefly empty file.
Code `66b28a49f5a81dc08c6c5f19b0d31a5cfb66ba1e` also passed both owned installed-Harness/DeepSeek Flash scenarios in
201.43 seconds. The managed checkpoint produced and authenticated its held prepared image twice through the installed
maintenance plugin. Original command and publication counts, world/Session coverage, channel observations and the prepared
hold were checked. The dedicated case's four independent unrecorded publication probes caused the installed maintenance
plugin to refuse preparation and create no image. Model calls used the configured provider; all message-provider traffic
stayed on local contract servers. Actual restored activation and live GitHub/Feishu account acceptance remain open.

The same code passed 1,497 tests, typechecking and all four builds on Ubuntu 22.04/Node 24 with native confinement in
[run 42554537411](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42554537411). Five opt-in cases
were skipped; all 27 receipt audit/preparation tests passed. The full Linux test phase took 124.06 seconds. These results
qualify held preparation and the existing execution boundary, not cross-host restored activation.
