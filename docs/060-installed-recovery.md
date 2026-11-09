# Installed recovery and Runtime ownership handoff

This increment carries a fully prepared recovery image into the actual DeepSeek Harness Runtime. It retains the Engine,
worker Sessions, original grants, independent endpoint/publication services and their existing ownership protocol. It does
not start a second orchestrator implementation. The original checkpoint and held preparation remain unchanged.

## Installation

After checkpoint verification, Session import, ownership reservation, a matched receipt audit and receipt preparation,
mount `dsh-superagent/recovery` in the offline maintenance profile with `mode: install`. Supply the same `checkpoint`,
`keyFile`, staged `destination` and `audit` resource connections. The additional configuration is:

```json
{
  "installation": {
    "requestId": "<new UUID retained for retries>",
    "preparationId": "<the completed preparation request UUID>",
    "target": "/private/operator/restored-deployment",
    "credentials": []
  }
}
```

`credentials` accepts explicit `{ "from": "/old/private/path", "to": "/new/private/path" }` mappings. The destination
must contain the original credential; stored pins still apply. This is relocation, not credential rotation or enrollment.
Endpoint URLs can be supplied through the selected resource/world connections; original resource, grant and coordinator
identities remain mandatory. Revoked worlds retain their original journal and credential for receipt observation.

Installation publishes a private directory containing `state/orchestrator.sqlite`, `worlds/<binding>/world.sqlite`,
logical Session evidence in `archive`, copied credentials in `control`, and an authenticated `installation.json`. It refuses
worker-visible destinations, redirected parents, another request's target, incomplete prepared proofs and missing private
credentials. Original-ID retries return the same installation. Installation alone leaves execution held.

The manifest contains paths, credential hashes and identity/proof metadata, never credential values. Retained command
registration snapshots, grant identities, publication approvals, plan bindings and Session IDs are not rewritten. Separate
operational bindings resolve historical endpoint connections and managed-world paths on the replacement host. Newly issued
operator registrations use their own explicit configuration.

## Runtime startup

Use `installationProfile(manifest, keyFile)` from `dsh-superagent/recovery` to obtain the main plugin configuration, or apply
its fields explicitly: local execution mode, installed `stateDir`, installed ownership/publication connections, and
`restore: { directory, keyFile }`. Keep the selected Harness inference, source and imported Session backend configuration.
For a dedicated world, retain the complete dedicated execution profile and replace its remote-world connection with the
manifest's single non-managed world configuration and original ownership binding. Managed worlds reopen from the pool.
The operator must select the imported Session backend; a directory name is not accepted as evidence that it contains the
right history.

Startup authenticates the installation and selected runtime configuration, takes the destination Store lock, and holds
every original Session writer while checking immutable headers and exact logical history. First startup also checks logical
Store/world digests, independent resource inventory revisions/quiescence, current claimant and publication configuration,
active world credentials, source contracts and actual inference routes. An already-open dedicated journal is compared
logically so SQLite WAL layout alone cannot alter the result.

Only after those checks does startup acquire and activate the reserved recovery lease. One SQLite transaction records the
signed activation, preserves operational bindings, and removes the execution hold. An in-process, single-use handoff
transfers the already-held Store lock and active ownership object to the real Runtime, without a release/reacquire gap.
Worker initialization continues through the existing Harness lifecycle; plugin activation does not wait on the preset
loader's own readiness barrier. A direct Runtime constructor cannot consume a held installation or bypass authenticated
startup by omitting the restore configuration.

A failure before the activation transaction retains the hold. An interrupted lease acquisition may advance the vacant
authority's epoch; retry still requires the same reserved checkpoint and unchanged independent resource inventories.
After activation, restart verifies the original Session prefix while permitting genuine appended events and descendants,
then acquires a fresh process lease. Ownership loss remains terminal for that process. It does not silently reacquire.
An acknowledged quiescent revocation is terminal: world startup retains its receipt and observation access without sending
the administrative mutation again. Unacknowledged or non-quiescent revocations still retry their original request.

Subsequent checkpoints resolve the relocated journals and retained administrative paths. A newly staged checkpoint clears
the preceding attempt's reservation/audit/preparation/activation metadata, while retaining operational bindings as
authenticated product state. Another complete reservation, preparation, installation and activation can then occur.

## Qualification and remaining work

Local tests cover private installation, original-ID retries, changed Store/world/manifest/configuration/credentials/Session
refusal, exclusive-lock transfer, interrupted acquisition, legitimate continued history, unavailable old directories and a
second complete backup/recovery cycle. The installed-Harness qualification additionally starts the installed Runtime,
runs a new real-model mission in a restored execution world, checks its artifact and restarts with the continued history.
The initial live run reached restored startup, completed a new mission and restarted, then failed the final assertion
because the world lifecycle resent an already-completed revocation. That production behavior was corrected; the assertion
was retained, and a pool restart regression now checks that no completed revocation is sent again. Final qualification
results follow below.

The complete local `pnpm check` passed 1,938 tests, typechecking and all six builds in 127.77 seconds of test time.
The terminal-revocation fix then passed 27 focused installation/pool/ownership tests plus repeated typechecking and all
six builds. Final runtime/test revision `a1c22a3` passed installed-Harness / DeepSeek Flash owned-managed qualification
in 203.47 seconds, including private installation, restored startup, a new mission/artifact, continued-history restart
and zero additional sends of the completed revocation. Inference used the configured real API; publication traffic stayed
on local contract servers. The original app remained running. The same revision passed 1,945 native Linux / Node 24 tests
with bubblewrap, typechecking and all six builds in 273.76 seconds of test time in
[run 42688097294](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42688097294).

This is not yet clean-host or cross-machine failover acceptance. The external authority, endpoints, publisher, their
provider credentials and worker roots remain independently deployed; their disaster recovery, automated provisioning,
transport/identity rotation, larger-scale retention and abrupt host-loss scenarios still require qualification. Dedicated
recovery startup also needs its own successful installed-Harness acceptance, beyond the managed-profile path. The complete
article architecture and Agentic OS product requirements remain in scope.
