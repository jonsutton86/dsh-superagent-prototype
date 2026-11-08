# 012 Local execution

Local mode runs general missions through the existing Engine and DeepSeek Harness worker Sessions without a GitHub
repository, GitHub CLI, or agent account. Missions, reviewed completion, scoped memory, and artifact publication use the
same durable services described in [010 Agentic OS](010-agentic-os.md) and [011 Library](011-library.md).

## Create a dedicated profile

Use a supported Node.js version, pnpm, and a DeepSeek Harness CLI compatible with `engines.dsh` in `package.json`.
Build this checkout with `pnpm install --frozen-lockfile` and `pnpm build`. Configure a model provider in the dedicated
Harness profile before dispatching work. Local execution describes where commands and files live; it does not imply a
local model or offline inference. Choose a local provider if those properties are required.

For a **new, unused** profile named `agentic-os`, run from this checkout:

```sh
dsh --profile agentic-os --from-default-profile web --dump-config
dsh plugin --profile agentic-os add "link:$PWD"
```

Use [examples/local.cordis.patch.yml](../examples/local.cordis.patch.yml) as the dedicated profile's
`${DSH_HOME:-$HOME/.dsh}/profiles/agentic-os/cordis.patch.yml`. Replace `stateDir` with an absolute persistent path and
choose an unused port. Do not replace an existing profile's configuration; merge these entries instead, preserving its
model/provider configuration. The example binds to loopback and disables the optional GitHub and Feishu adapters.

```sh
dsh --profile agentic-os --no-open
```

Open the loopback address printed by Harness and select the dsh-superagent panel. Create a mission, add an agent action,
and run it. Results appear in its Session and the library. Review the deliverable before accepting the action and
completing the mission. The management API described in [006 Deployment](006-deployment.md) also serves these operations.

Keep this profile separate from personal Harness Sessions: command defaults and git settings apply process-wide.
The default `repository` mode remains compatible with existing installations and their GitHub setup.

## Directories and prompts

Each ticket receives its own directory under the Execution setting's directory, or `<stateDir>/work` by default.
The saved repository preparation command is retained but disabled and never run in local mode. No Git worktree or
pull request is required. A GitHub PR number in a local worker report is refused.

Setup and worker launch write a random probe into the assigned filesystem and read it through the configured subprocess
provider. A mismatch fails setup or launch and removes the probe. This checks that process and filesystem access refer
to the same local environment; it is not remote environment enrollment or an OS security sandbox.

Local default prompts cover general research, documents, software and other authorized work, scoped recall, publication,
human decisions, and explicit completion review. Repository defaults are substituted when untouched; custom saved
prompt text remains intact. Review custom prompts when changing mode. GitHub-specific skills and source admission are
disabled in local mode. Feishu can be configured separately if wanted; local missions need no external connector.

## Changing execution mode

Settings → Deployment exposes `local` and `repository`. A mode change restarts the plugin; machine limits still apply
without restart. Finish or stop all open tickets first. Every new local ticket records its execution mode. Historical
tickets without that field are repository tickets. Setup refuses to run while open tickets belong to another mode,
and launch also checks the recorded mode. Switch back to finish incompatible work, or stop it before retrying setup.
Closed tickets retain their mode: retrying one under a different mode is refused; create a new mission action instead.

The `gh` shim refuses GitHub operations in local mode, and the generated git configuration has no GitHub credential
helper. These defaults and the scoped library tools are application guardrails. Workers still run as the profile's OS
user with the configured Harness permissions and can access other host files. Use a dedicated OS account or an isolated
environment when process isolation is required. Remote API exposure and multi-user authentication remain separate work.

## Verification and limits

The local integration tests use a simulated Harness host to dispatch a mission, publish an artifact through the actual
worker tool, report ready, review the result, and complete the mission. Setup tests additionally execute a real child
process and verify filesystem/process matching, probe cleanup, and GitHub refusal. Repository behavior remains covered
by the existing regression suite.

On 2026-11-08, an isolated installation of `@deepseek-ai/dsh@0.2.1-rc.3` loaded this built bundle and started a loopback
local profile without GitHub or Feishu accounts. The actual management API reported ready. A mission and artifact created
through that process survived stopping and restarting Harness with their original identities, content and hash.
After the operator configured the DeepSeek provider, a live `deepseek-official/deepseek-flash` mission computed the sum
and mean of `[3, 5, 8, 13, 21]`, wrote and read back `qualification.json`, published the exact JSON through
`workspace_publish`, read the stored artifact, and reported ready. The action entered review before acceptance. An
independent check compared the on-disk values (sum 50, mean 10), exact published bytes and SHA-256, then accepted the
action and completed the mission through the management API. The 87-byte artifact hash was
`d69da390d92475fecc6bc89dcb0d506573bfbd3f885bf378a81739a6697bbba3`.

This qualifies one real local workflow on macOS with Node 25.9.0 and Harness 0.2.1-rc.3. It does not establish provider
portability or unattended production reliability. Browser/desktop layout, broader provider/tool flows, restore/failover,
and the remaining full product requirements in [010 Agentic OS](010-agentic-os.md) still need qualification.
