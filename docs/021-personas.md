# Versioned execution personas

The Personas tab manages specialist instructions, model preferences, optional tool capabilities and embedded skills.
Each agent action selects an exact persona ID/version. Selection is part of the reviewed mission definition described in
[014 Mission plans](014-mission-plans.md), and execution continues through the existing Engine and DeepSeek Harness.
The default worker remains available when an action has no persona reference.

## Operator workflow

1. Open **Personas → New persona**. Set a name, description and instructions. Optionally choose a configured provider/model
   and reasoning effort. Blank model fields inherit the worker model selection. Saving a configured model validates that
   route before writing the definition; an unavailable model fails without creating a version.
2. Select optional tools and add embedded skills. The skills capability must be enabled when the definition contains skills.
   Skill names use kebab case. Skill bodies remain in the coordinator's private Store and are exposed to the assigned worker
   through Harness's scoped skill service. Do not put credentials in instructions or skill bodies.
3. Add an agent action or edit a mission plan and choose **Execution persona**. The selector records the displayed version;
   catalog refreshes and later persona updates never silently substitute a newer version. A person-owned action cannot select
   a persona. Editing the plan still requires the usual proposal review before the definition changes.
4. Run the action. The host checks the reference before creating a task and copies the immutable definition into the execution.
   Worker Sessions use that snapshot for instructions, optional-tool guards and skills. The model preference initializes a new
   worker; a subsequent explicit Harness model selection or previously recorded selection remains authoritative on resume.
5. Use **Edit persona** to save a new immutable version. Read any historical version by number or restore it as an editing
   draft; saving the draft creates another version. Archiving prevents new runs using any version of that persona. Existing
   executions retain their original version and may continue, including retry/steering under their existing task authority.
   Restore the persona explicitly to permit new runs again.

Changing or removing a persona in an approved plan increments affected action definitions and invalidates downstream
acceptance. Affected running actions must be stopped or finished before approval. This never replaces an existing Session's
persona in place. Archived references in a candidate plan must be removed or restored before the plan can be approved.

## Authority and lifecycle

The Store contains separate persona heads, immutable versions, command receipts and status/version audit events. Definition
version and optimistic revision are distinct: archive/restore advances the revision without changing the version. All accepted
mutations write their head, history/audit and idempotent receipt in one SQLite transaction. Response-loss retries return the
original committed response; a different payload using that request ID is refused. Revision checks run after asynchronous
model validation, so concurrent updates cannot overwrite one another.

Definitions are bounded to 64,000 characters including their JSON structure, at most 32 skills, 12,000 characters for each
instruction/body, and six unique capability names. Catalogs return at most 30 metadata records per page. The worker-facing
`workspace_personas` tool lists active metadata for candidate plans; it cannot edit personas, approve a plan, change its own
selection or dispatch another action. Task details expose the execution's full immutable persona snapshot and digest.

The source gate compares the exact persona reference alongside the action definition revision. The executor accepts persona
selection only from host-authorized workspace triggers. The snapshot is checked against immutable registry history and the
Session's persisted persona digest before binding. A different persona requires a new authorized run. Worker descendants
inherit the owning task's instructions, skills and capability guard. Parent lookup includes persisted Session headers when
intermediate agents are unloaded, bounded to eight parent links per lookup. Each verified child also persists its owning
task as a lineage anchor, allowing deeper teams to recover without dropping their persona at that bound. A previously persona-bound child with missing ownership
refuses tools and prompt assembly. Remote descendants additionally retain the execution-world and lineage checks from
[017 Remote missions](017-remote-missions.md).

The six optional capabilities govern these Harness tools:

| Capability | Tools |
| --- | --- |
| Read | `read`, `read_image`, `glob`, `grep` |
| Write | `write`, `edit` |
| Commands | `bash`, `pwsh`, `job_output`, `job_list`, `job_kill` |
| Web | `web_search`, `web_fetch` |
| Delegation | `subagent`, `list_subagent_models`, `send_message`, `list_agents`, `interrupt_agent` |
| Skills | `skill` |

Inherited work-tool visibility is narrowed, and a monotonic Harness guard also denies forbidden calls through scoped tool
registrations. A later permissive tool listener cannot override that guard. Existing task, library and reporting tools retain
their host authorization checks. Persona skills are registered under `persona-<id>-<version>-<name>` and do not replace another
worker's skills. The policy/mandate prompt still follows the persona prompt, and literal template syntax is not interpolated.

These capabilities are tool selection limits, not independent OS permissions: an enabled shell can read/write files and use
network access allowed by its execution grant. The environment grant and native confinement remain the execution boundary.
The model preference is routing configuration, not a security boundary or a persona-specific spend budget. Global/preset
skills remain subject to Harness composition; embedded persona skills add to that catalog. Per-persona memory stores,
credential privileges and subagent-specific model overrides are not introduced by this increment.

## Management API

Routes are relative to `/orchestrator/api/` and retain the existing single-operator loopback/origin/request-header protection.

| Method/path | Purpose |
| --- | --- |
| `GET personas?offset=0&q=&active=true` | Bounded current metadata; omit `active` to include archived records |
| `GET personas/:id` | Current head and definition |
| `GET personas/:id/versions/:version` | Exact immutable historical definition |
| `POST personas` | Create with `requestId` and `definition` |
| `PUT personas/:id` | New version with `requestId`, current `revision` and `definition` |
| `POST personas/:id/archive` | Archive/restore with `requestId`, current `revision`, `archived` and `reason` |

Mission actions/plan definitions accept optional `persona: { id, version }`; no raw instructions or capability changes can
be smuggled into that reference. Persona IDs, versions and snapshot digests persist across coordinator restart.

## Verification and remaining scope

Deterministic tests cover immutable history and Store reopen, original request replay, archive semantics, model-validation
races, bounded catalogs, malformed definitions, archived dispatch with no created task, plan changes/removal, Session pinning,
unloaded-parent recovery and missing-owner refusal. Tests against actual Harness services exercise scoped prompt rendering,
embedded skill discovery/loading/disposal and monotonic tool guards without affecting another worker. Rendered UI tests cover
lost-create recovery, historical restoration, archive/restore and preserving an older plan selection after a catalog update.

The opt-in configured-model test runs the generated remote profile from [020 Endpoint administration](020-endpoint-administration.md).
An actual worker must load its persona skill and produce an artifact containing a proof value found only in that skill, after
checking a synthetic endpoint service credential. It verifies owned command receipts, immutable execution snapshots and
idempotent mission dispatch after persona edit/archive and coordinator restart. Native Linux confinement is a separate CI
boundary; the macOS composition fixture does not establish OS isolation or cross-host transport.

Local qualification on 2026-11-08: `pnpm check` passed typechecking, all four builds and 1,366 tests across 82 files.
The ordinary macOS run skipped three native Linux cases and the opt-in model case. The separate configured-model test
passed with Harness `0.2.1-rc.3` and `deepseek-official/deepseek-flash`, including persona skill loading, endpoint credential
use, artifact publication, execution attribution, persona edit/archive and coordinator restart.

Per-action environment selection, managed runtime pools, multi-workspace persona ownership, retention and broader specialist
quality evaluation remain open alongside the full article/Agentic OS ledger. Dedicated whole-profile environments are still
required; a persona selector does not switch filesystems or process providers.
