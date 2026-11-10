# 076 — Optional Abliteration provider through DeepSeek Harness

Agentic OS can route selected tasks to `abliteration` through the existing Harness `llm-pi-ai` adapter. Harness remains the runtime, session owner, tool executor, credential resolver and model transport. The adapter already uses the OpenAI SDK with the configured base URL; this increment introduces no replacement inference engine or SDK dependency.

The integration is opt-in. The configuration helper declares a provider and two models; it never selects a global model, enables title generation, writes a running profile, purchases credit or sends inference. Supply the adapter's complete effective configuration to preserve its existing providers and settings. Existing installations retain their defaults until an operator explicitly selects another model.

## Verified contract and configuration

Official documentation inspected on 2026-11-10:

- [OpenAI compatibility](https://docs.abliteration.ai/api/openai-compatibility): base URL `https://api.abliteration.ai/v1`, bearer authentication, Chat Completions, streaming, tools and structured output.
- [DeepSeek Harness integration](https://docs.abliteration.ai/integrations/deepseek-harness): use `llm-pi-ai`, `apiKeyEnv: ABLIT_KEY`, protocol `openai-completions`, `supportsDeveloperRole: false` and `maxTokensField: max_tokens`. The published guide uses an older Harness release; local qualification uses adapter `0.2.1-rc.3` with pi-ai `1.5.0`.
- [Models](https://docs.abliteration.ai/models): `abliterated-model` has a 262,144-token context; `abliterated-model-large-flash` has a 1,048,576-token context. Both accept text and images.
- [Image constraints](https://docs.abliteration.ai/capabilities/images): no more than four images across request history, accepted PNG/JPEG/WebP/GIF, 12 MB per image, no video.

`src/providers/abliteration-config.ts` generates the checked-in `examples/abliteration/cordis.patch.json`. The example contains only the `llm-pi-ai` entry and its `providers.abliteration` declaration. **Harness replaces the entry's entire supplied `config`; it does not merge provider dictionaries.** The standalone example is suitable only when the effective adapter config is empty. Applying it directly over an adapter with other routes would remove those explicit route settings.

For an existing installation, first resolve the effective `llm-pi-ai` entry after its base profile and all current overlay layers. Call `abliterationPatch(existingConfig)` with that entry's complete config. The helper preserves its settings and provider declarations while adding `providers.abliteration`, without mutating the input. It refuses malformed provider maps and an existing `abliteration` route, which must be reviewed explicitly rather than overwritten. Incorporate the resulting adapter entry while preserving every other profile/overlay entry, including `agent-default-model`. Do not replace an installation's full patch with this one-entry example.

This replacement behavior was observed in installed `@deepseek-ai/dsh-app-boot@0.2.1-rc.3`: `applyEntryPatches` assigns each override directly to the target entry. Its exported `renderConfigDump` uses the same algorithm as boot. The installed-Harness test composes a synthetic existing adapter and default-model entry, proves that the unmerged example removes the other route, then proves the merged helper preserves the route, adapter settings and default-model entry. The [configuration evidence receipt](evidence/076-provider-config.json) records source identity, REA coverage and this behavioral check.

```sh
node scripts/abliteration-provider.mjs config
```

The command prints the empty-adapter example without modifying files or reading credentials. It does not discover or merge the active profile. The generated provider has:

| Setting | Value |
| --- | --- |
| Provider route | `abliteration` |
| Credential reference | `ABLIT_KEY` |
| Protocol / base URL | `openai-completions` / `https://api.abliteration.ai/v1` |
| Models | `abliterated-model`, `abliterated-model-large-flash` |
| Modalities | Text and image |
| Output default | 8,192 tokens per request |
| Reasoning | Low by default; low/medium/high selectable |
| Automatic retries | `normal` policy with `maxRetries: 0` |
| Request / idle timeout | 60 seconds / 30 seconds |
| Request image normalization target | 1 MiB encoded bytes per image; 8 MiB total base64 image payload |

An explicit model `maxTokens` configures the Harness request default in the qualified adapter. Its route-level `defaultMaxTokens` alone would describe model capability, so it is deliberately not used to impose this limit. The Agentic OS guard additionally rejects missing, invalid or greater-than-8,192 request output limits on this route. A per-request token limit is not a spending budget.

The normal Harness AgentLoop resolves `llm.prepareCall` before logging its request header and dispatching its frozen request, so the 8,192-token default is present at the guard. Custom callers should also use `prepareCall` and its returned config/stream handle. A raw `llm.stream` call without an explicit resolved output limit is intentionally refused. Local qualification exercises the prepared handle and verifies its zero-retry policy and output default before dispatch.

## Credentials and task selection

Store the project API key under the `ABLIT_KEY` reference through Harness's model/credential settings, or provide `ABLIT_KEY` in the Harness launch environment. Only the reference name belongs in source control. Do not put the key in a persona, task prompt, patch, screenshot or command argument.

After explicitly adding the provider declaration to the operator's existing profile, choose `abliteration` and one of the two model IDs in Agentic OS's persona model fields. Select that persona when creating the task or mission action. For image input, use `abliterated-model-large-flash`. The existing execution snapshot pins the persona's immutable version and model choice. Editing the persona later does not reroute an existing task.

An explicit executor or evaluator model setting also works, but applies to that role's future sessions. Leaving those settings unset and selecting an Abliteration persona only for chosen tasks preserves current defaults. `initializeRoleModel` persists the chosen session route without calling the Harness operation that changes the global default.

## Image preflight and scope

`installAbliterationGuard` is installed in the coordinator at the public Harness `llm/stream` waterfall. It reads the exact request without modifying it. On the `abliteration` route it checks both configured models, the bounded output limit, and every image occurrence across all messages, including tool results. Repeated references count repeatedly because they become separate wire image occurrences.

The guard is registered after usage accounting with `prepend: true`, so preflight runs first. A refused five-image task creates neither an HTTP request nor a usage reservation. Accepted requests retain the existing provider/model/persona attribution.

The guard allows at most four retained images and refuses invalid size/media metadata before adapter dispatch. It uses 12,000,000 bytes as the conservative 12 MB limit. Original files and request image versions still pass through the existing durable Harness attachment service. The adapter normalizes request images and checks its configured aggregate payload limit.

Images marked `offloaded: true` are excluded from the count: the qualified Harness adapter projects these to text and emits no image bytes for them. This is proven by a local wire test with four retained images plus an offloaded fifth image. A fifth retained image in a tool result is refused before an HTTP request. The guard does not silently remove images or claim automatic count-based offloading; the operator must offload older images through Harness or start a new task. Other provider routes are unchanged.

The guard applies while Agentic OS is mounted. Loading the example provider patch into a Harness profile without Agentic OS does not install this application guard. Direct external callers or a renamed provider route are outside this qualified integration.

## Metadata-only smoke check

With `ABLIT_KEY` available to the shell, run:

```sh
node scripts/abliteration-provider.mjs models
```

This makes one authenticated `GET https://api.abliteration.ai/v1/models`. It does not call a completion endpoint, follow redirects, retry, enumerate local credential stores or alter configuration. Its output contains only fixed requested model IDs, whether they were listed, any advertised access/readiness flags, and a bounded status. Responses are limited to 1 MiB; the timeout is 15 seconds. Raw provider bodies, keys and exception messages are never printed.

Exit statuses: `0` means a valid catalog was received, `2` means no key is configured, and `1` means the check failed. A valid catalog may still show a requested model as absent, locked or of unknown readiness; it does not establish inference quality, vision accuracy or tool reliability. The initial missing-key path returned `{"status":"not_configured"}` without a network request.

On 2026-11-10, after the operator saved `ABLIT_KEY` privately through the Harness credential provider, an authenticated
catalog check succeeded. Both requested model IDs were listed with access available and readiness true. The
[catalog verification receipt](evidence/076-live-model-catalog.json) contains only those bounded facts and the credential
reference name, never the credential value or raw provider response. No completion was requested, provider defaults were
not changed, and live text/tool/vision inference remains unqualified.

The optional route was subsequently saved in the local `agentic-os` profile, preserving its seven prior patch entries and
the `deepseek-official/deepseek-flash` default. An isolated real Harness context resolved both configured models and the
authenticated provider catalog. The existing application was not started or restarted, so this is prepared configuration
and isolated integration evidence, not deployment acceptance. The account's credit metadata exposed only aggregate
credits/usage, not evaluation-credit provenance; the single completion check remains pending that spending constraint.

## Usage, cost and qualification

The [pricing page](https://abliteration.ai/pricing) advertises an evaluation credit, but the integration does not assume this account has it or that an existing balance is free. Do not purchase, top up or initiate paid inference without the operator's authorization. A metadata listing is not authorization to send tasks.

Existing usage attribution records the selected provider/model and the task's pinned persona. Prices are not installed or assumed to be zero. Configure reviewed, versioned pricing and a suitable persona/workspace budget in Usage before authorizing inference; cost/token limits refuse unbounded reservations when metadata or pricing is unavailable. Uncertain calls retain their reservations under the existing usage journal.

Local qualification:

```sh
node node_modules/vitest/vitest.mjs run tests/abliteration-provider.spec.ts
DSH_ABLITERATION_ADAPTER_PACKAGE=/absolute/path/to/node_modules/@deepseek-ai/dsh-llm-pi-ai \
  node node_modules/vitest/vitest.mjs run tests/abliteration-harness.spec.ts
```

Use Node 24 or newer. The adapter path is explicit; the test skips when no installed adapter is provided, rather than installing a package or substituting a mock adapter. Its server and credential are synthetic and local. It exercises the installed Harness profile-composition algorithm and the real LLM service, provider schema, pi-ai adapter and OpenAI SDK for configuration preservation, model resolution, streaming text, usage counters, fragmented tool calls, output defaults, four-image requests, offloaded-image exclusion, history-limit rejection, HTTP failures and missing credentials. The fixture supplies an attachment service with fixed PNG bytes; it does not independently qualify image normalization or vendor-side interpretation.

The provider suite also checks nonmutating configuration preservation, malformed/duplicate route refusal, secret-safe catalog behavior, other-provider isolation, immutable per-task persona selection, session model events and persistence through database reopen. Existing role/persona and usage suites remain applicable. The configuration correction passed 13 focused tests across both suites and TypeScript checking on macOS; its evidence receipt identifies the tested working-tree file digests separately from the earlier full-suite revision.

Implemented and locally tested: opt-in configuration, retained Harness routing, persona persistence, image/output guard, safe catalog command and local wire compatibility. Authenticated live catalog access is also verified. Not claimed: live text/tool/vision inference, provider billing accuracy, deployment into the running app, or completion of broader Agentic OS qualification. These remain explicit qualification/deployment steps, not inferred successes.

Initial qualified source revision `3a31fb5445a35877b25ebaef60d6493eb6f6853c` passed full macOS and native Linux qualification with the
installed adapter test enabled on both platforms: 2,136 / 2,149 tests passed respectively, with 25 / 14 skipped. Typechecking
and seven builds passed on each platform. Native service checks passed separately. The shared
[qualification receipt](evidence/075-076-qualification.json) records exact versions, counts, digests and CI limitations.
No key was available during that initial full-suite qualification. The subsequent authenticated catalog check above is
separate evidence and does not replace or broaden the recorded inference-test boundary.

The configuration-preservation correction was subsequently included in source revision
`8b1c2ca72e11335460e85bfbee74d8466b527fef`, which passed full macOS and hosted native Linux qualification with the installed
adapter enabled: 2,167 / 2,180 tests passed respectively, plus typecheck and all seven builds on both platforms. See the
[updated qualification receipt](evidence/077-qualification.json). Live completion remains pending evaluation-credit
confirmation; these real-adapter tests use synthetic loopback provider responses and do not prove vendor inference.
