# Generated recovery launch profiles

Recovery installation now emits the Harness patch needed to start the installed deployment. This removes the manual
reconstruction of dedicated filesystem/subprocess providers and the hand-edited startup overlay used in earlier recovery
qualification. DeepSeek Harness remains the process and Session host.

## Operator path

Complete the existing checkpoint verification, Session import, ownership reservation, matched audit and receipt preparation
steps. The offline maintenance plugin's `install` mode now generates `harness.patch.json` inside the installation by default.
Its completion receipt includes `installation.patchFile`. Select an imported JSONL backend and a loopback port explicitly:

```json
{
  "installation": {
    "requestId": "<installation UUID>",
    "preparationId": "<prepared image request UUID>",
    "target": "/private/operator/restored-deployment",
    "launch": {
      "port": 3000,
      "sessionRoot": "/private/operator/imported-sessions"
    }
  }
}
```

Start the installed system with the existing configured Harness base profile:

```sh
dsh --profile <configured-profile> --patch /private/operator/restored-deployment/harness.patch.json --no-open
```

The base profile supplies installed plugins, inference credentials and source contracts. The generated patch contains paths
and ordinary plugin configuration, not provider secrets. Omitting `launch.sessionRoot` retains the base profile's pluggable
Session backend; startup still checks its actual immutable headers and logical history. Omitting `launch.port` retains the
base profile's webserver configuration. The selected Session directory is not itself proof of correct history.

For managed execution, the patch selects the installed coordinator state, ownership and publication connections; the pool
reopens each bound world. For a dedicated world it also emits the complete paired remote filesystem/process composition,
disables the conflicting local providers and generic presets, retains the grant's remote workspace root, and binds the
provider's world journal and ownership bridge to the installation. Worker grants are not recreated or broadened.

The manifest authenticates the patch's exact hash and byte count, together with the selected launch parameters. A changed
patch is refused before the execution hold is released. Retrying the original installation request returns the same patch;
changing launch parameters is a different request. The exported `installationPatch` helper supports callers composing their
own trusted profile, while `installationProfile` remains available for the main plugin configuration alone.

## Publication and qualification

Installation takes a separate destination lock in addition to the existing source checkpoint lock. It publishes the prepared
tree with one atomic rename, without an intermediate empty target reservation. Existing incomplete or foreign directories
are refused, and interrupted unpublished scratch directories never become a usable installation. Manifest and launch patch
writes enforce the same size bounds as their readers. Credential values remain in private files.

Tests exercise managed/dedicated patch composition, copied private paths, original-ID retries, changed launch parameters,
same-size patch substitution, a live dedicated journal opened before acquisition, competing destination ownership and
existing-directory refusal. The live Harness checks consume the generated patch without modification. Before launching,
they retire the predecessor's coordinator Store, Session files and world journals; the restored process must run new work
and restart using the installation and imported Session backend.

Final verification results will be recorded after qualification. This is filesystem-relocation and fresh-process evidence,
not a claim of cross-machine or operating-system disaster recovery. The independent authority, endpoint, publisher and
configured inference provider remain deployed. Automated host provisioning, external-service disaster recovery, transport
and identity rotation, abrupt host-loss drills and the remaining complete Agentic OS architecture still require work.
