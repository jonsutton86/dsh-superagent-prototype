# 100 Release qualification and rollback

**Status:** Software release package for branch `feature/jarvis-agentic-os`. The branch is **not pushed, merged or
deployed**. Clean-machine installation and PR publication remain operator actions; physical iPhone/Safari voice
qualification remains a manual gate (`docs/097`). Nothing here claims a production deployment.

## What ships

Phases 0–7 and the Phase 6 briefing increment:

- baseline repair, emergency stop, audit chain, admin RBAC, credential vault/provider validation;
- typed memory, recall/capture, worker grants, retention/digests/profiles/consent imports;
- deterministic provider routing, ordered fallbacks, recorded-spend enforcement, OpenAI-compatible transport,
  usage reservations;
- native persona-based worker specialization (no Codex dependency);
- read-only JARVIS dashboard, Creative workspace, tokenized voice streaming and browser/device qualification harness;
- read-only operator briefing.

## Install and qualification procedure

1. Use a clean checkout of the branch on a supported Node.js version (the repository is developed on Node 25 with
   pnpm 11).
2. `pnpm install --frozen-lockfile` in the clean checkout.
3. `pnpm check` (typecheck, Vitest, production build) or run the three steps directly:
   `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/vitest/vitest.mjs run`, `node node_modules/tsdown/dist/run.mjs`.
4. Start the harness and open the panel; verify setup guidance, the JARVIS tab, Creative publish and the ordinary
   Inbox/Missions flows.
5. Voice: follow the device checklist in `docs/097`; do not claim voice qualification without a recorded device run.

Latest recorded run on this machine: TypeScript pass, build pass, full Vitest suite green (see the branch commit log
and phase reports for the exact counts). A **clean-machine install was not executed** in this environment; it remains
part of the operator release checklist.

## Platform matrix

| Platform | State |
| --- | --- |
| macOS arm64, Node 25, pnpm 11 | developed and tested here |
| Linux | not qualified |
| Windows | not qualified |
| iPhone Safari voice | software-ready, **not physically qualified** |

## Rollback

- The work is additive and sits on its own branch. Revert the branch range with `git revert` or return to the prior
  commit (`b587753` memory lifecycle, or the repository's `main`); no production schema migration was introduced.
- Runtime tables added by earlier commits are additive `CREATE TABLE IF NOT EXISTS`; rolling back the binary leaves
  unused tables rather than corrupting existing ones. Back up the orchestrator state directory before a rollback.
- Emergency stop (`POST emergency`) and the audit chain remain available for operational containment independent of
  release rollback.
- Do not force-push or rewrite the protected branch; use a reviewed revert PR.

## Security review points

- Management API stays loopback-only with same-origin checks and optional bearer auth/RBAC.
- Credentials remain in the vault (0600, names-only API); no secret is exposed in provider, route or voice responses.
- Speech audio uses a short-lived capability token scoped to one receipt; management routes still require auth.
- External content remains untrusted; no connector credentials or external accounts are configured.
- GoalForge/Codex are not dependencies of the runtime; no paid external call is made automatically.

## PR package

- Base: repository `main`; head: `feature/jarvis-agentic-os`.
- Suggested title: `JARVIS-style agentic OS: memory, routing, dashboard, voice streaming and release qualification`.
- Include the phase reports and the exact verification commands/results in the PR body.
- Required checks: TypeScript, full Vitest suite, production build; manual device checklist attached where voice is
  claimed.
- Do **not** merge without review; branch protection and the deployment gate still apply.

## Known limitations

- Calendar/email/MCP connectors are not implemented; the Phase 6 briefing is read-only.
- Physical iPhone/Safari voice qualification is outstanding.
- No deployment, push, PR or merge was performed from this checkout.
- Host load can make timing-sensitive suites slow; rerun under low load before treating a timeout as a regression.
