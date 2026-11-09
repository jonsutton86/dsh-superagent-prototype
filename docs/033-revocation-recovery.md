# 033 Original world-revocation recovery

An execution endpoint can remove a grant's authority and commit the original revocation receipt before the coordinator
receives its acknowledgement. A checkpoint then contains a `revoking` world while the independent endpoint already has the
disabled successor generation. Recovery now confirms that original receipt and applies it to the separate held image.
It also handles a saved acknowledgement whose process range was not yet quiescent when captured.

This extends [receipt audit](030-recovery-receipt-audit.md), [held preparation](031-recovery-receipt-preparation.md) and
[administrative recovery](032-administrative-recovery.md). The existing `audit-receipts` and `prepare-receipts` operations
perform the checks automatically. They do not resend `grant.revoke`, cancel processes, renew a lease or issue a credential.

## Independent proof

Administrator-only `recovery.revocation` requires the exact inventory revision, original request ID and fingerprint. The
fingerprint includes the original grant principal (`id` and `epoch`) and original `grant.revoke` request, including its reason.
The endpoint reads the existing `remote_receipt`; it never reconstructs a receipt from the current disabled grant alone.
Observation does not require active coordinator ownership, because it cannot dispatch an effect.

The safe response contains the original receipt's grant ID, epoch and timestamp; public current grant metadata; the complete
resource's quiescence; and a separate observation that the original generation's commands and file mutations are quiescent.
No grant token, credential value/digest, command argument/environment/output or file-edit payload is returned. Both receipt
and resource reads occur synchronously after the inventory revision check. Existing receipt writes already invalidate that
revision, including changes that do not add an inventory item.

Recovery requires all of the following:

- The exact original request ID, principal and fingerprint match.
- The historical receipt identifies the original grant generation.
- The current grant is disabled at exactly the successor epoch, with a later revision and unchanged root identity,
  owner, workspace, operations and credential bindings.
- The resource and original process/file generation are confirmed quiescent.
- Any acknowledgement already saved in the checkpoint matches the independent historical identity and timestamp.

An original revocation that was never dispatched, or whose receipt is missing, produces `revocation_missing`. Conflicting
requests, receipts, generations, authority bindings or quiescence produce `revocation_mismatch`. Either blocks preparation.
Transport/protocol failures fail the audit. A later enabled or otherwise replaced grant is not adopted as old-world
authority. Resource revisions and the vacant checkpoint reservation are revalidated before publishing an image.

## Held application

The source world remains byte-for-byte unchanged. Preparation re-observes each original receipt and writes only the separate
world copy: its phase becomes `revoked`, the original intent is preserved, and its original receipt records confirmed
quiescence. The historical grant binding stays unchanged; no provider or Session is activated. Original command and file
receipts are independently reconciled as before. A managed-world catalog's existing disabled flag and revocation intent
are preserved in the coordinator copy.

A world with an original revocation intent may retain historical credential bindings after catalog rotation or revocation
only when the independent revocation proof succeeds. Active worlds still require the matching enabled credential versions.
Missing or conflicting revocation evidence never makes an active world eligible for this exemption.

Prepared manifests authenticate `revocations: { verified, recovered }`. `recovered` counts worlds with an absent or
not-yet-quiescent acknowledgement at capture. Older images remain verifiable without this optional field; original-ID retries
return their original authenticated image. Absence of revocation evidence is not clearance for later activation.
Both source and prepared execution holds remain enforced.
Older endpoint versions that lack this observation operation cannot qualify these revocations; recovery fails and stays held.

## Acceptance and remaining work

The real HTTP recovery suite covers lost acknowledgements after commit, later quiescence, catalog rotation after revoked
authority, source preservation, original-ID image retries, private-payload exclusion, administrator scope, unsent/missing
intents, changed request fingerprints, historical acknowledgements, grant epochs/bindings, unsettled work and inventory races.
It verifies that recovery submits only observation operations. The installed-Harness managed scenario also loses both live
client acknowledgements for the same original revocation, then checks recovery makes no further revocation calls.

Private credential/runtime configuration validation, authoritative input/state recovery, actual Session-backend validation,
world/workspace remapping, restored activation and clean-host crash/failover acceptance remain open, alongside the full article
and Agentic OS ledger. A local intent with no independently committed receipt remains held for explicit resolution.

Local verification passed 1,521 tests, typechecking and all four builds, with seven opt-in/platform cases skipped.
The focused recovery suite covers 49 cases; the final recovery/documentation run passed all 56 cases.
Code `8c1a66445b89b328ebcbdad61260b147505a10a2` passed both owned installed-Harness / DeepSeek Flash scenarios
in 195.07 seconds. The managed case lost the original revocation acknowledgements after commit, prepared the held world
as revoked, authenticated and retried the same image, and verified no further revocation requests occurred during recovery.
The dedicated case retained its expected refusal for unrecorded publication effects.

The same code passed 1,523 tests with native Linux confinement (five skipped), typechecking and all four builds in
[run 42559418182](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42559418182).
Provider-message traffic used local contract servers. The original app remained running. Restored activation, private
configuration and authoritative state recovery remain unqualified by this increment.
