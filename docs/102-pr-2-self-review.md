# 102 PR #2 author self-review and live qualification

Date: 2026-11-15 (America/New_York). This is an **author self-review, not independent review or approval**.

PR: https://github.com/jonsutton86/dsh-superagent-prototype/pull/2
Observed state: OPEN, unmerged, head `9793c53e4902079fa514144cfd54e57dfef0c975`, base `main`.
The local comparison spans 202 commits and 664 files (75,870 insertions, 737 deletions), including earlier DSH work.
Review scope: branch summary, release/phase reports, management HTTP/authentication, voice transport, provider
transport, live read-only API responses, and relevant tests. This is not a claim of line-by-line independent review
of all 664 files.

## Findings before merge or remote qualification

1. **P1 — Capability in voice URLs conflicts with the requested remote security contract.**
   `src/client/voice.tsx:59` inserts `mediaToken` into the audio URL. `src/app/http.ts` admits that special media
   path before ordinary marker/bearer authentication, but only for loopback Host. A remote media element cannot
   supply those headers. Extending that exception to the tailnet would weaken the requested boundary and retain
   a secret in URLs. Keep remote playback unqualified until token-free authenticated progressive playback is
   implemented and physically tested. The local origin patch deliberately does not extend the media exception.
2. **P1 — Viewer capabilities are not enforced on all mutations.**
   `src/security/access.ts` excludes write capabilities from viewer, but `src/app/http.ts` routes such as
   `POST library`, `POST inbox`, and `POST voice/speak` directly call their services without `allow(...)`.
   The general mutation guard checks ownership/lifetime, not role. An authenticated viewer can therefore reach
   write/provider operations on these paths when other service prerequisites are met. The existing access tests
   cover emergency-stop denial, not complete mutation coverage. Complete route/capability coverage is needed
   before treating viewer access as generally read-only. This is static route evidence, not a live mutation test.
3. **P2 — Provider redirects can forward prompt content outside the configured endpoint.**
   `HttpProviderTransport.execute` in `src/security/provider-client.ts` omits `redirect: 'error'`. A local-only
   experiment with two loopback HTTP servers and synthetic text demonstrated a 307 redirect forwarding the
   prompt to the second, unconfigured endpoint. No real credentials or providers were involved. Fail closed on
   redirects and test that the redirect destination is not contacted. This finding concerns prompt forwarding;
   it does not claim that cross-origin Authorization headers were forwarded.
4. **P2 — Suffix byte ranges are interpreted incorrectly.**
   `speechAudioResponse` treats `bytes=-4` as bytes 0–4 rather than the final four bytes. The existing streaming
   test covers `bytes=0-3`, not suffix ranges. Add suffix/open-ended/unsatisfiable range coverage before relying
   on arbitrary Safari seeking behavior. Physical Safari behavior remains untested.

## Local origin-gate change (not in PR head, not deployed)

`src/security/trusted-origin.ts`, `src/app/http.ts`, and `tests/http.spec.ts` add a single canonical HTTPS
Tailscale origin, startup refusal without administration bearer configuration, exact Host/Origin and marker checks,
Fetch Metadata for browser GETs without Origin, and remote admin authentication even for supervision. Forwarded
headers do not grant access. The listener remains loopback-only, existing loopback behavior stays unchanged,
and the capability-URL media path remains restricted to loopback. Audit/authentication and per-route capability
checks are retained; this patch does not claim to fix the pre-existing capability gaps above. Remote supervision
still needs its watchdog credential, so distinct watchdog/admin credentials can make it unavailable remotely.

Tests reject HTTP, explicit ports including 443, credentials, paths, fragments, wildcard/lookalike hosts, missing
markers, absent/wrong bearer tokens, and cross-origin requests. Documentation includes the threat model and
`tailscale serve reset` rollback in [101](101-tailscale-ios.md); the architecture module index was updated.

## Verification evidence

- PR-head clean-copy qualification already recorded in [100](100-release-qualification.md): install, TypeScript,
  2,419 passed / 32 skipped / 0 failed, production build.
- Local gate: TypeScript passed; focused HTTP/access suite passed 23 tests.
- First full local run: 2,432 passed / 32 skipped / 1 failed. The failure was the architecture module index missing
  the new `trusted-origin.ts`; the table has been corrected. This was not a timing regression.
- Production build passed (exit 0). Final full-suite verification after the documentation correction is recorded
  below when complete. No real provider calls or physical-device qualification were part of these checks.

## Running system observations

No harness restart, reinstall, live deployment, task, ticket, mission, artifact publication, merge or force-push
was performed. Existing saved and latest-log authenticated panel links were opened without displaying them; both
returned HTTP 401. Do not kill PID 31029: it hosts this conversation. A fresh valid DSH web-authentication link
must be obtained through the operator's local flow; the existing links did not establish panel access.

Read-only loopback API checks with `x-orchestrator-request: 1` returned:

| Surface | HTTP / observed data | Qualification limit |
| --- | --- | --- |
| State / Agents | 200; running 0, queued 0, capacity 3; paused false | API only; panel rendering unverified |
| Overview | 200; `no-allowed`, pending-person list empty, all flow counters 0 | API only |
| Memory | 404 on memory/search | Unavailable in running service |
| Goals | 200; zero missions on first page | API only |
| Connections | 404 on providers and credentials | Unavailable in running service |
| Analytics | 200; 3,187 calls, 269,248,421 tokens, 3,187 calls with unknown cost | Cost 0 is not evidence of free usage |
| Voice | 200; input null, output null | No adapters configured; no voice test performed |
| Creative / Library | 200; 19 artifacts on first page | Form/rendering unverified; no publish attempted |

Source settings contain enabled operator, repository and workspace sources; no source was added. Overview reports
no allowed senders. Worker model is null and ticket directory is unset; concurrency is 3. Settings were not changed.
The running service's missing APIs differ from the checked-out JARVIS implementation; source tests do not prove
that implementation is installed in the running process.

Tailscale Serve points tailnet-only HTTPS at `127.0.0.1:3083`; no Funnel was enabled. Remote panel returned 401;
remote API returned 403 with the Tailscale Origin/marker. Physical iPhone availability was confirmed by the operator,
but model, iOS/Safari version and actual checklist results are pending. No physical checks are marked passed.

Calendar alone was selected. A local `.ics` path or authorized HTTPS feed is still missing; no connector was added.
Email/MCP remain unauthorized. Applying source changes to the live harness, merge, and deployment remain separately
gated. See [101](101-tailscale-ios.md) for the physical checklist blockers and operator actions.

### Final validation outcome

The second full run finished with **2,432 passed / 32 skipped / 1 failed**, exit 1 (252.95 seconds). Its sole
failure was the new document 101 linking forward to 102, which violates the repository's numbered-document rule.
That link was removed; the targeted documentation rerun then passed **6/6**, exit 0. Thus both observed documentation
failures were corrected, and no code-test failures remained in the full run, but a completely green full-suite rerun
after the final documentation-only correction was not performed. TypeScript and production build passed; the
focused HTTP/access tests passed 23/23; `git diff --check` passed. These local changes remain uncommitted and undeployed.
