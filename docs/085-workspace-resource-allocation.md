# 085 Workspace aggregate resource allocation

Status: investigated and designed; not implemented or qualified. This continues the complete architecture's compute and
environment contract. DeepSeek Harness remains the execution runtime. Disk quotas, fleet setup, transport, ownership,
clean-host recovery and the other ledger requirements remain in scope.

## Verified current boundary

At `87f49c2`, `EndpointResources` contains only pool and command budgets. `CgroupResources` creates command scopes directly
under the endpoint pool. Every scope receives the same command ceiling; there is no intermediate workspace ceiling.
The endpoint enters the resource context under `job:<id>`, `operation:<id>` or `read`. Those identities preserve receipt
attribution but do not identify a shared workspace allocation. The filesystem path receives an authorized `RemoteGrant`,
and jobs retain `grantId`; the grant contains the workspace identity. The pre-exec helper verifies the command directory
and its immediate parent as the endpoint pool. Adding an intermediate group without changing that check would break the
boundary. Existing startup pins the full resource policy in the endpoint journal. None of these facts establishes native
kernel behavior for a new hierarchy. Source hashes are in `evidence/085-resource-contract.json`.

## Implementation decision

Add an optional workspace budget to the existing endpoint resource policy. Preserve current pool/command behavior when
it is absent. Validate command <= workspace <= pool for every configured ceiling. This is an aggregate ceiling, not CPU
reservation, scheduling fairness or disk quota. Do not advertise those distinct capabilities as implemented.

When enabled, the hierarchy is delegated root / endpoint pool / workspace / command. Workspace identity must come from
the authenticated original grant, not argv, environment variables or a caller-supplied resource label. Resolve how grant
replacement, epoch changes and multiple grants to the same workspace map to one stable group before implementation;
record that mapping and test it. Keep original job/operation identity separately for usage and recovery. Unattributed
internal execution requires an explicit bounded allocation; it cannot silently escape workspace accounting.

Extend the existing resource context rather than creating a second reservation journal. Preserve scoped asynchronous
context across job launch, every verification stage and filesystem helpers. The trusted pre-exec gate must verify all
three levels and exact policy before entry/exec. No fallback may dispatch into a less restrictive group when any level is
missing, changed, unsupported or unavailable. Controller enablement and the no-internal-process constraint must hold at
every intermediate level.

Restart traverses workspace groups without treating missing in-memory scope objects as proof of termination. Preserve
populated or unknown groups and original effect receipts. Remove a workspace group only after its child scopes and direct
process population are confirmed absent; retain ambiguous cleanup. Cancellation must target the original command group,
not all sibling commands in the workspace. Existing whole-pool enforcement remains authoritative above workspace limits.
Pinned policy changes remain refused unless the existing migration contract explicitly permits them.

## Delivery sequence and checks

1. Extend policy parsing and source-bound allocation identity; prove same-workspace aggregation and cross-workspace
   separation through endpoint job, filesystem and verification paths.
2. Implement the nested cgroup hierarchy and trusted helper verification together. Check cancellation, restart discovery,
   cleanup races, changed limits and unclaimed populated scopes with the existing simulated-kernel fixture.
3. Project configured workspace limits through authenticated status and the environment UI. Keep snapshot counters clearly
   separate from live telemetry. Update launcher configuration/validation and recovery policy validation as required.
4. Run affected resource/endpoint/launcher/recovery/UI tests plus typecheck/build. Add native Linux assertions to the existing
   dedicated qualification fixture: two concurrent commands in one workspace share the ceiling, a second workspace remains
   distinct, and parent pool constraints still apply. Run the final native platform gate under the agreed qualification
   policy; simulated-kernel success is not native acceptance.

The initial impact graph is retained privately at
`.artifacts/resume-2026-11-15/workspace-resources-affected.json`. Start with `tests/remote-resources.spec.ts`,
`tests/fixtures/cgroup.ts`, the trusted helper and endpoint attribution calls. No host provisioning, policy mutation,
service restart or default-model change is authorized by this design record alone.
