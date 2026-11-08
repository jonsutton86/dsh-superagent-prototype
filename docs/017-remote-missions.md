# 017 Remote mission profiles

This increment connects the endpoint and persistent world in [016 Remote execution](016-remote-execution.md) to the existing
mission, Inbox, Engine and Harness Session paths. DeepSeek Harness still owns inference, tools, jobs, subagents and Session
history. A dedicated coordinator profile binds all of its managed work to one remote grant. The coordinator's task database,
Session persistence, model credentials and artifact library stay on the coordinator host.

## Execution and authority

The profile replaces its root filesystem and subprocess services together. Harness's agent loop and working-directory
service capture their provider context at composition; overriding a shell inside a worker preset is insufficient.
`RemoteWorkspace` proves that its filesystem and subprocess providers carry the same world fingerprint and can write/read
the same nonce inside the grant. It creates and validates task directories exclusively through those providers.

Environment enrollment stores endpoint, grant, epoch and world fingerprint. Every new execution and immutable mandate binds
that environment generation. The Session registry also stores the fingerprint. Authority-specific worker, child and router
presets record it in the immutable Harness Session header. Another world does not register those old preset IDs. Cold resume
checks both the header and saved authority; legacy local tasks cannot acquire remote authority implicitly.

New remote Sessions use Harness's public Agent creation and model-selection APIs because the ordinary Session controller's
creation path performs a host-side directory creation. Existing Sessions resume through the controller. Worker descendants
use the same authority-specific child preset. When a parent is unloaded, the coordinator reads its persisted header to
verify the parent chain and recover the owning mission. Unowned descendants and mismatched ancestors remain denied.

The remote router receives host-owned typed routing/resource tools and runtime skills. Its preset has no shell, file, search
or delegation tools. Workers retain Harness shell, files, jobs, skills, compaction, todo, web search and child-agent tools.
Remote glob/grep use the endpoint's installed `rg`, bounded output and grant-checked paths. The ordinary search plugin selects
a coordinator-packaged native binary; that binary cannot be assumed to exist or run on the endpoint.
The endpoint's network capability controls its processes. Model inference and Harness web search remain coordinator-side
provider services with their separately configured access; an endpoint without network capability is not an offline AI profile.

Harness instruction discovery is rooted at the task directory, without searching parent project markers outside the grant.
Nested instruction observations still use Harness. Filesystem skills use explicit `<grant-root>/.dsh/skills` and
`<grant-root>/.agents/skills` roots; default host/user discovery and host file watching are disabled. Runtime prompt skills
remain available. Bundled host resource directories are not mounted into remote Sessions.

## Permissions and revocation

The endpoint's leased grant and bubblewrap confinement are the execution boundary. Harness uses its `danger-full-access`
mode inside that boundary, labelled **Endpoint grant** in the profile. The normal sandbox-capable bash service remains
installed because Harness permission presets require it; in this mode it delegates directly through the paired remote
subprocess provider. It does not generate coordinator-specific sandbox wrappers. A managed Session switched to another
Harness mode is denied before prompts/tools run, rather than silently claiming that per-Session read-only or workspace-write
policy is enforced by the endpoint.

Coordinator control paths, control URLs, other `DSH_*` values and unset ambient variables are not forwarded to commands.
Only `DSH_SHELL`, `DSH_SESSION_ID`, `DSH_PROFILE`, the existing superagent variables and endpoint-allowlisted non-DSH variables
can cross the process seam. The endpoint still rejects undeclared environment overrides. No model credential is forwarded.

Revoking an environment commits monotonic denial in the persistent world journal before the coordinator's environment
transaction completes. A crash or rollback between the two databases can leave execution denied; it cannot renew revoked
authority. The same remote revocation intent is retried after disconnects. The environment UI distinguishes pending remote
acknowledgement, acknowledged but uncertain effects, and confirmed stopped effects. It does not offer local reauthorization
of a revoked remote world. Replacement authority requires a new profile/world with separate Session ownership.

## Dedicated coordinator profile

Deploy the Linux endpoint and enroll its grant using the procedure in [016 Remote execution](016-remote-execution.md).
Install `ripgrep` alongside Node and bubblewrap in the endpoint's system runtime, for example `/usr/bin/rg`. Use a grant
with `fs.read`, `fs.write` and `process.spawn`; add network capability only when the mission requires it. Configure an
authenticated tunnel or HTTPS endpoint, then keep its credential and persistent world directory outside worker roots.

Use a fresh coordinator Harness profile, private `DSH_HOME` and private orchestrator state directory. Install the built
bundle as in [006 Deployment](006-deployment.md), and configure the model provider normally on the coordinator. The
following overlay uses Harness profile entry IDs observed in `0.2.1-rc.3`; audit the resolved composition when upgrading.
Replace all example paths and the UUID with the actual grant and coordinator values. The grant root is an endpoint path,
not a coordinator directory to create or mount.

```yaml
- id: dsh-superagent
  config:
    stateDir: /private/coordinator/orchestrator
    executionMode: local
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: /var/lib/dsh-execution/workspaces/mission-one
- id: permission
  config:
    defaultPreset: danger-full-access
    presets:
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: Endpoint grant
        description: Execution is bounded by the remote endpoint grant.
- id: fs-sandbox
  disabled: true
- id: subprocess
  disabled: true
- id: pwsh-sandbox
  disabled: true
- id: session-title-llm
  disabled: true
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-feishu
  disabled: true
- id: dsh-superagent-worker-preset
  disabled: true
- id: dsh-superagent-router-preset
  disabled: true
- id: preset-standard
  disabled: true
- id: preset-ptc
  disabled: true
- id: preset-minimal
  disabled: true
- id: preset-cordis
  disabled: true
- insert:
    - id: remote-mission-world
      name: dsh-superagent/remote-world
      config:
        url: http://127.0.0.1:60668
        endpointId: <trusted-endpoint-UUID>
        credentialFile: /private/coordinator/mission-one.token
        stateDir: /private/coordinator/worlds/mission-one
```

Keep the default root `bash-sandbox`, `sandbox`, `sandbox-policy` and permission services. Disable any additional root local
filesystem/process providers or generic presets added by your own profile. Do not install the endpoint plugin on this
coordinator profile. Keep the web listener on loopback. Launch the dedicated profile with
`dsh --profile remote-missions --patch /private/coordinator/remote-profile.yml --no-open` and check the Environments page
before dispatching work. `executionMode: local` currently means general missions without repository setup; the composed
provider determines that execution is remote. Leaving the execution directory setting empty selects the grant root.

Remote account CLIs, repository mode and host command shims are explicitly refused. Endpoint-owned credentials are integrated
in `019-endpoint-credentials.md`; connector/command policy and service-specific acceptance are still needed before those
adapters can be enabled. One profile currently owns one grant shared by its tasks;
task directories are not independent security principals. Durable command/file ownership, assignment/tool attribution and
operator receipt controls are implemented in `018-execution-ownership.md`. Selecting different environments per action,
operator endpoint enrollment/reconciliation, resource quotas, state ownership/failover and backup restoration remain open
requirements of the full architecture.

## Qualification

The opt-in `tests/remote-harness.spec.ts` launches an actual installed Harness with a configured model in a temporary profile.
It creates an Inbox mission, runs remote tools, independently reads the file and published artifact, restarts the coordinator,
checks the preserved authority binding and replays the original request without another assignment. It reuses configured
provider access without copying or printing credential values. Set these paths explicitly when running it:

```sh
DSH_HARNESS_QUALIFICATION=1 \
DSH_QUALIFICATION_CLI=/absolute/path/to/node_modules/.bin/dsh \
DSH_QUALIFICATION_HOME=/private/qualification-home \
DSH_QUALIFICATION_PROFILE=/private/qualification-home/profiles/source-profile \
pnpm exec vitest run tests/remote-harness.spec.ts
```

On macOS that test uses the explicitly injected test-only endpoint and qualifies Harness composition, model/tool integration
and restart behavior. It does **not** qualify confinement. The production endpoint refuses unsupported hosts. Linux CI runs
the real bubblewrap boundary and the application-level remote mission dispatch case with `DSH_REMOTE_ISOLATION=1`.
The model-backed test is opt-in and is not part of ordinary CI; `DSH_REMOTE_ISOLATION=1` can also be combined with its path
variables on a configured Linux host. Neither same-host test establishes separate-machine TLS/tunnel deployment acceptance.

Live composition qualification on 2026-11-08 passed against Harness `0.2.1-rc.3` and the configured
`deepseek-official/deepseek-flash` provider. The worker created and published `remote-harness-proof`; coordinator restart
preserved the grant and a duplicate Inbox request retained one assignment. This is acceptance of the exercised remote
mission path, not completion of the article or Agentic OS product. Exact code/CI receipts are recorded in the implementation
tracker after the full suite completes.

Local `pnpm check` on 2026-11-08 passed typechecking, all builds and 1,326 tests in 74 files. Two native Linux cases and the
opt-in real-model case were skipped by that ordinary macOS run. The real-model qualification passed separately as described
above. Native Linux qualification passed for commit `d8223312706205e2f9cfa352b975cc603b1ab75a` in
[GitHub Actions run 42515787855](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42515787855), job
`128838381859`: typechecking, all builds and 1,327 tests passed across 74 test files. Both native cases ran, including remote
mission dispatch, endpoint search, artifact publication, descendant guards and offline revocation. The opt-in model-backed
case and the non-Linux refusal case were skipped. The runner used Ubuntu 22.04, bubblewrap 0.6.1 and ripgrep 13.0.0. This
qualifies the exercised Linux application/provider composition; separate-machine transport and the other open requirements
above still need acceptance evidence.
