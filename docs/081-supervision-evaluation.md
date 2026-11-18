# 081 Supervision evaluation through Harness

This increment adds a repeatable operator evaluation command for the existing independent watchdog. It continues the
supervision work after [bounded worker recovery](080-worker-recovery.md). Each case runs the production watchdog in a fresh
installed DeepSeek Harness profile and Session, against a synthetic observation endpoint and an explicitly selected model.
It does not replace Harness, change the workspace's default model, or grant new watchdog recovery actions. Abliteration
remains an optional route described in [076](076-abliteration-provider.md).

## Evidence and assessment authority

Codegraph was synchronized at baseline `db367fe3ba03e3dc1ea1c8bc2a5188b5d498fb12`. REA 6.8.0 parsed six selected source
artifacts without parse failures. The source manifest, captured hashes, static-analysis limits and observed contracts are in
[the evidence record](evidence/081-assessment-contract.json). The captured plugin already contained the shared-prompt
extraction; its hash and the separately retained baseline plugin distinguish those bytes. Static analysis does not establish
runtime behavior. Reviews use the pinned Fabric operations and existing evidence wrapper.

The production journal's acceptance of an exact incident revision is assessment authority. Enqueuing a turn or producing
chat text is insufficient. The evaluator records accepted assessment and completed turn separately: a later provider error,
max-token termination, deadline or cancellation does not become a successful completed assessment. The prompt, tool names
and schemas are shared with the production plugin. A digest handshake verifies the actual loaded watchdog contract.

The evaluation-only probe must activate before the watchdog creates its Session. Both initial activation and subsequent
inference require its active gate; a sibling plugin failing to load cannot silently leave evaluation unguarded. The ordinary
watchdog configuration leaves this optional contract unset and preserves its existing behavior.

## Curated cases and honest metrics

Suite version 1 contains 16 synthetic cases: 15 assessment cases and one initial observation-outage operational control.
Cases cover permission and human-input waits, terminal failure, scope drift, observations of long-running work, unavailable or
uncertain execution facts, and misleading output activity. Paired cases keep task identities opaque. Only observations enter
the model's context; case names, expected findings and reviewer rubrics remain outside it.

Labels are curated product expectations, not empirical ground truth or requirements inferred from the article. Conservative
acceptable findings can include `unknown`; four cases also identify a preferred diagnosis. Reports show completed-assessment
coverage, acceptable-label agreement, preferred-diagnosis agreement, abstention distribution and operational-control results
separately. An always-abstaining model cannot satisfy preferred-diagnosis coverage by avoiding unsupported conclusions.
Unrecorded, unsettled and not-started cases remain visible in distinct denominators. Evidence text always requires manual
review against the versioned rubrics; `semanticQualityQualified` remains false.

Status-request checks count requested calls, including calls refused by guards. Only an allowed, accepted, current stalled
assessment may support at most one request. A premature refused request is a violation rather than a successful no-op.
The synthetic endpoint records requests without obtaining real worker execution authority. An initial observation outage
must produce no model attempts; it is an operational control, not a diagnostic label to score.

## Isolation, bounds and retained uncertainty

Each case creates a private HOME, profile, workspace, watchdog journal and Session. The coordinator, external sources and
title-model calls are disabled. Only the explicitly named credential environment variable is inherited, alongside a small
runtime environment allowlist. The actual workspace profile and Harness credential store are neither copied nor edited.
Provider definitions are strict, key-free and bounded; they cannot inject arbitrary plugins or unrestricted retry policy.

The probe counts `llm/stream` admissions for the exact Session before handing off to the adapter. Native Harness retries
count against the same cap. These are **model attempts**, not HTTP dispatches, billed requests or cost measurements: credential
resolution may fail after admission. The adapter has no separate SDK retry loop in the inspected rc.3 implementation.
Per-case deadlines and attempt limits bound execution; forwarded stream content is capped at 1 MiB per attempt and 4 MiB
per case, with a 1 MiB metadata trace. Those stream limits do not cap network ingress or a first oversized chunk allocation.

Trace records contain only whitelisted event metadata, counts and usage. Raw model content, tool arguments, provider errors
and child stdout/stderr are excluded. Reported assessment evidence is bounded and known credential literals are redacted;
reports remain private because model-written evidence can contain other sensitive material. The fetch shim restricts the
child's fetch destinations and refuses redirects; this is not an operating-system network sandbox.

Usage remains unknown when unavailable. The installed pi-ai adapter synthesizes all-zero usage for some failed requests;
the evaluator does not report those zeros as measured consumption. Positive usage observed before failure remains partial.
Successful response usage and optional cache counters are distinguished from missing counters and complete-turn outcomes.

A new output directory is mandatory. The runner persists a case attempt identity and trace location before launch, fsyncs
trace admissions, and atomically replaces its private report. If collection or cleanup fails, the original in-flight intent
and trace remain unsettled. It never invents zero calls, resumes an old output directory, or automatically replays a case.
SIGINT/SIGTERM stop the child and retain recorded progress; abrupt host/process loss can leave an unknown in-flight case.
This CLI is not a durable background service or automatic process-recovery manager.

Reports retain source revision/dirty state, built JavaScript digests, actual installed Harness version, selected model,
provider-definition digest, full case definitions and suite digest. Artifact integrity is checked before and after execution.
Changing the build invalidates scoring while preserving observed outcomes. Separate output directories intentionally create
new evaluations; choosing to run another case again is an operator action.

## Operator commands

Build the checkout, then inspect the plan without provider traffic:

```sh
pnpm build
node scripts/supervision-eval.mjs
node scripts/supervision-eval.mjs --case reported-permission-block --max-model-attempts 4
```

The complete plan lists the current exact case IDs. Execution requires an installed pinned Harness rc.3 CLI, a private
provider-definition JSON file, explicit provider/model selection and a new output directory:

```sh
node scripts/supervision-eval.mjs --execute \
  --dsh /absolute/path/to/dsh \
  --provider-config /private/path/evaluation-provider.json \
  --provider selected-provider --model selected-model \
  --credential-env EVALUATION_API_KEY \
  --case-deadline-ms 60000 --max-model-attempts 6 \
  --output /private/path/new-evaluation
```

The JSON file contains one `EvaluationProviderSchema` definition, not an entire Harness patch: `displayName`,
`api` (`openai-completions` or `openai-responses`), `baseURL`, optional `apiKeyEnv`, and a bounded `models` list with
`id`, `name`, `contextWindow`, `maxTokens` and `input`. `apiKeyEnv` must exactly match `--credential-env`; the key itself
stays outside the file and source control. Restrict the JSON file to its owner, for example mode 0600. The CLI refuses
embedded credentials, URL credentials, unrelated configuration and existing output directories.

An explicitly selected provider can incur usage charges. This increment uses only a scripted loopback fixture, without live
provider inference or purchases. Abliteration's catalog check is previously verified; its live inference acceptance remains
pending the separate evaluation-credit confirmation. Provider availability alone is not authorization to run a paid suite.

## Qualification and remaining scope

Focused tests cover scoring denominators, case isolation, trace validity, usage ambiguity, compiled-contract verification,
stream/attempt bounds and production gate refusal. The opt-in installed test exercises the real Harness watchdog and adapter
against deterministic loopback responses. It tests assessment persistence, status requests, outage zero-attempt behavior,
provider failures, deadlines, cancellation, incomplete turns, probe activation failure and private-output recovery.

Before the source checkpoint, 61 focused tests passed with the installed test skipped in that run; typecheck and seven
builds passed. A separate installed-Harness preflight passed four checks in 37.56 seconds. The subsequent unsettled-usage
summary correction passed focused tests and will be included in the full committed-source run. Both full and selected CLI
plans executed without model traffic.

Exact runtime/test revision `6c15b194a3ca982e840fb1be30f71b79b30f81b2` passed full macOS qualification (2,282 passed,
25 skipped; 316.69 seconds) and hosted native Linux qualification (2,295 passed, 14 skipped; 269.87 seconds), with typecheck
and seven builds on both platforms. Native service/SSH qualification passed 16 with one skip on macOS and all 30 on Linux.
Installed evaluation, watchdog, publisher, executor-recovery and provider-adapter fixtures were enabled on both platforms;
Linux logs confirm all five ran and passed. The new installed evaluation took 48.693 seconds on Linux. The automatic push
workflow succeeded without a duplicate dispatch. [The qualification receipt](evidence/081-qualification.json) records the
source/archive identity, platform versions, log digests and CI result.

Passing a deterministic provider fixture verifies execution and accounting, not real-model diagnostic quality.
Manual rubric review, live-model evaluation, long unattended workloads,
operator alert acceptance, cross-host recovery and the remaining full architecture stay open. No existing app is deployed,
restarted or reconfigured by this increment.
