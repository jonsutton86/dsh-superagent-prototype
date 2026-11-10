# 078 Supervision inference failures and productive work

This increment continues the first item in the implementation sequence: supervision failure coverage and productive work
that remains quiet longer than the observation threshold. It retains the independent DeepSeek Harness watchdog, its
restricted tools, existing incident journal and bounded assessment reservations. It does not add worker restart or task
retry authority. [077's alert routing](077-supervision-alerts.md) continues to consume the same assessment-service status.

## Observed failure and correction

The installed Harness distinguishes enqueueing a message from completing inference. `AgentDelivery.send` can return after
queueing and flushing a Session while the later model request fails. Previously the monitor cleared `modelError` at that
enqueue boundary and did not subscribe to the runtime's inference-failure event. A provider failure could therefore leave
the console reporting no assessment error even though no diagnosis had been recorded.

The watchdog now observes Harness's `agent/error` event for its current Agent instance, live registry entry and exact Session only. The listener
is installed before restoration. It ignores other agents, retired instances and shutdown, and records a fixed explanatory
message without inspecting the provider's error payload. Session setup and delivery failures also use fixed messages;
provider bodies, exception properties, credentials and paths do not become operator status or alert evidence.

Queue acceptance, a chat response, a rejected assessment and a duplicate assessment do not establish recovery. Only a newly
accepted assessment of the current incident revision clears the reported assessment failure. Later inference failure
remains visible even if an earlier tool call succeeded. Main-service reachability continues to be recorded independently.
These changes retain the existing journal and retry budget; there is no additional persistence authority or replay queue.
All three watchdog tool callbacks apply the same live-identity check before parsing arguments or accessing state. A callback
retained by a replaced Agent cannot consume the replacement's incident assessment or initiate a progress request.

## Installed-process qualification

The opt-in `tests/watchdog-process-harness.spec.ts` uses the pinned installed Harness CLI with disposable installations,
private homes and working directories. It does not copy the operator's profile or credentials. Its local OpenAI-compatible
server supplies scripted responses and synthetic credentials; all model traffic stays on loopback. The ordinary test run
skips this installed boundary unless explicitly enabled. The native Linux workflow enables it.

```sh
pnpm build
DSH_WATCHDOG_PROCESS_QUALIFICATION=1 \
DSH_WATCHDOG_QUALIFICATION_CLI=/absolute/path/to/installed/dsh \
pnpm exec vitest run tests/watchdog-process-harness.spec.ts
```

`DSH_ENDPOINT_QUALIFICATION_CLI` is the CI fallback. This fixture must not use `DSH_HARNESS_QUALIFICATION`, which selects
the separate configured-model acceptance test described in [052](052-supervision-console.md).

The installed-process qualification passed in 66.26 seconds on macOS with Harness `0.2.1-rc.3`. It observed these boundaries:

| Scenario | Recorded result |
| --- | --- |
| HTTP 503 from the local provider | Assessment error becomes visible; synthetic provider body is absent from status |
| Hung response stream | Watchdog deadline aborts that stream; main observations continue |
| Current assessment after failure | Error clears while the productive worker is still working |
| Thirty-second real background job | One invocation and assignment; exact proof and all 30 SHA-256 samples verified |
| Artifact publication | Content matches the actual output; library retains worker/Session/assignment provenance as `agent_submission` |
| Abrupt main and watchdog termination | Production locks expire naturally; no lock deletion bypass |
| Watchdog restart during main outage | Original acknowledgement and assessment delivery ID remain available |
| Main restart | Original acknowledgement, output and single assignment remain; no second worker command |

The first run exposed a fixture mismatch with the installed `workspace_publish` schema: `encoding` and `sources` are
advertised as required even though the application API supplies defaults. Explicit arguments corrected the fixture, and
the complete run then passed. Assistant statements are not used as proof of output or receipt recovery.

## Evidence and remaining acceptance

Codegraph supplies checkout context; REA captures selected source evidence, supplemented by direct inspection of the
installed Harness error-event contract. The [evidence record](evidence/078-supervision-failures.json) preserves these source identities and limits.
Pinned Fabric design/code review applies the repository evidence wrapper. Static analysis is not a runtime trace, and a
scripted model is not evidence of semantic diagnosis quality. Focused runtime/monitor tests passed 21 cases, typechecking
passed and seven bundles built. The final full qualification receipt will identify the exact committed source, platforms,
executed scenarios and results; the previous increment's full-suite results do not validate this change.

Live diagnosis quality, useful versus false-positive interventions on representative workloads, live operator destination
acceptance and separately authorized recovery policies remain open. An accelerated long-running fixture proves its recorded
duration and configured stale threshold, not overnight reliability. The remaining tracker items are unchanged.

The optional Abliteration provider and the operator's default model are unchanged. No paid inference, live alert delivery,
user-app deployment, hosting purchase or main-branch merge is part of this increment. Full-project completion is not claimed.
