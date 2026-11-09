# 039 Passive source contracts and recovery settings

Source plugins now register their contracts independently of the coordinator. The bundle mounts `dsh-superagent/sources`,
which exposes the passive `superagentSources` Cordis service. GitHub and Feishu register their actual schemas in that service;
their polling and runtime registry registration remain inside an `orchestrator` injection. With the coordinator disabled,
maintenance can inspect loaded contracts without constructing a Runtime, admitting inputs or starting listeners. Unloading
the coordinator removes polling and runtime registration while retaining the passive contract; unloading the source plugin
removes its contract too. Custom profiles that load source plugins directly must also load `dsh-superagent/sources`.

The workspace, publication and conversation contracts are compiled into the catalog. Their running adapters use the same
schema objects. Runtime and maintenance share the availability rule: an owned coordinator permits workspace input and,
when configured, its fenced publication/conversation adapters. The legacy host-CLI GitHub and Feishu watchers remain
ineligible in owned mode, even when their contracts are installed. Their passive registration does not grant execution or
establish credentials, account identity, connectivity or listening permission.

## Held preparation

[Held receipt preparation](031-recovery-receipt-preparation.md) requires the selected host's real catalog through a lazy
public Cordis lookup. It reads authenticated settings at their recorded revision, checks the registered configuration and
policy schemas, and derives effective enabled sources using the original owned-coordinator and publisher bindings. It
rejects missing active/policy-only source contracts and invalid registered settings instead of silently falling back to
defaults. An unknown source explicitly disabled in settings remains opaque and unchanged, including its retained policy.
Known disabled sources still have their configuration validated by their installed contract.

The service carries a unique lifetime generation and monotonic registration revision. Verification pins both, plus a digest
of normalized configuration, effective availability and retained inactive settings. A plugin reload, catalog replacement,
changed settings or changed effective defaults fails subsequent verification. Cordis may return distinct contextual service
proxies, so identity is established by the catalog generation rather than JavaScript proxy identity. Stale registration
disposers cannot remove a subsequent registration of the same contract.

Checks run before inference, before final inference verification, and again after final resource/Session checks. The optional
appended `sourceConfiguration` image field records contract, enabled/inactive and retained-source counts plus a configuration
digest. It includes no raw configuration, credentials or provider responses. Original-ID retries return the authenticated
historical image without requiring a live catalog; older manifests remain readable without claiming this evidence. Invalid
or changed source state removes an unpublished image and preserves the execution hold.

## Scope and remaining work

This verifies the selected restore host's loaded source contracts and the authenticated settings interpreted by this code.
Older checkpoints did not record original source plugin versions or resolved schema defaults, so this is not proof of
identity with uncaptured source-host code or private account configuration. Catalog membership also does not prove all
external plugin callback behavior, future availability or successful polling. Publisher account/target proof remains the
separate [control configuration check](036-control-configuration-recovery.md).

Supported restored activation must bind and revalidate the actual deployment profile, Session backend, publisher, sources
and ownership handoff at startup. Authoritative pending-work/thread/evaluation/effect reconciliation, cursor and connector
state checks, runtime remapping, clean-host failover and broader source/repository integration remain open. The full
architecture and product requirements remain in the implementation ledger.

## Qualification

Tests use real Cordis plugin fibers to load both source plugins without a coordinator, mount and dispose GitHub polling with
a synthetic unconfigured host, and validate optional maintenance service access. They cover source eligibility, duplicate
and stale registration, missing schemas, invalid configuration/policy, retained disabled sources, catalog replacement,
reloads, changing defaults/settings and cancellation. Pipeline tests cover source failures before, during and after inference,
signed summary authentication, old manifests and the retained hold. Installed-Harness qualification checks the real bundle's
source catalog and signed source summary without sending external provider messages.

Source-contract code `24fe27f7e172d40e2f47e03c618ced6e2e0c9bca` passed 1,656 local tests, typechecking and all four
builds. The same code passed 1,658 tests with native Linux confinement, typechecking and all builds in
[run 42572760163](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42572760163).
Both owned installed-Harness / DeepSeek Flash scenarios passed in 202.70 seconds. Managed recovery loaded the bundle's
passive source catalog with the coordinator disabled, verified its signed source summary, and retrieved the same held image
on retry. The dedicated case retained its expected refusal for unrecorded publication probes. Focused source/recovery tests
passed 184 cases; bundle tests passed all three cases after their expected plugin list was updated. Provider-message traffic
stayed local and the original app remained running. Deployment binding, authoritative pending-work/cursor reconciliation,
supported activation, clean-host failover and the remaining architecture/product scope remain open.
