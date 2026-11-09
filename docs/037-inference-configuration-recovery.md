# 037 Harness inference configuration in recovery

[Held receipt preparation](031-recovery-receipt-preparation.md) now verifies the selected restore host's inference path before
publishing a prepared image. This supplements [Session history](035-session-backend-recovery.md) and
[control credentials](036-control-configuration-recovery.md). The execution hold remains in place.

## Host services and model selection

`PrepareCheckpointReceipts.inference` requires the actual Harness `llm`, `sessionProjections` and default-model selection
services. The maintenance entry point obtains these from its host; no provider key or model override is accepted in the
recovery configuration. Mount the intended inference adapters and Session Controller projection in that maintenance profile.
Missing services, the required model-selection projection, or a referenced settings revision fail preparation.

Recovery reads the authenticated current settings and each eligible Session archive in pages of 128 events. It uses
Harness's public `sessionProjections.restore` and `foldRequestHeader`, preserving fork boundaries. A pending model selection
wins over the last request header. Without either, a root uses its role or immutable ticket-persona setting, then the
selected host default. Header reasoning effort recorded as an adapter default is resolved again by the current adapter.
Historical models superseded by a newer selection are not probed.

The selected set includes the coordinator, live tickets, non-human-ended tickets with undelivered inputs, and their archived
descendants, which remain addressable by their parent. Ended inactive worker roots are excluded. Queued workers with no
Session yet still contribute their pinned persona/worker route. Current coordinator/worker role defaults are also checked
for new work. This is configuration evidence, not a claim that every selected Session will resume; authoritative work and
descendant reconciliation remain required. Future persona selections and explicit reopening of inactive work must validate
their routes when admitted.

## Bounded inference probe

Each distinct provider/model/explicit-effort route is prepared with Harness `llm.prepareCall` and streamed through its public
registration-bound call. The request contains only `Reply OK.`, no Session identity, history, system prompt, tool definitions
or execution authority. It requests at most 64 output tokens, has a 30-second deadline and honors the enclosing operation's
120-second deadline. At most 256 distinct routes are accepted; oversized or slow configurations fail held and require a
separately reviewed operational path, never an implicit timeout extension. This makes a small billable inference request
per route on each verification pass.

A successful probe requires nonempty text or reasoning and exactly one successful stop or token-limit terminal event.
Tool calls, empty/incomplete streams, errors, cancellation and excessive output fail. No exact answer text is demanded.
The caller deadline bounds even a noncooperative adapter; cancellation is signaled, but cannot prove a broken remote
provider has stopped processing. Provider exceptions, response text and private configuration are not saved in recovery
evidence. Errors expose only a safe configuration code.

The public Harness stream includes its installed middleware. A replay or synthetic middleware response can therefore pass
this check: it proves that configured inference path, not independent credential authentication or direct provider origin.
Production qualification must use the intended adapter/middleware profile. The installed-Harness qualification uses the
configured DeepSeek adapter; unit tests use a synthetic provider through the real `LlmRuntime`.

## Image publication and limits

Preparation probes while destination Session writers and source state remain held, then probes again immediately before
final resource/Session validation and image publication. Selected default changes or resolved configuration changes fail.
The appended optional `inferenceConfiguration` manifest field records route/Session counts and selection/resolved-config
digests. It contains no keys, endpoint URLs, model responses or conversation text. Older signed manifests remain readable;
absence of the field is absence of this evidence. Original-ID retries return their authenticated historical image without
rerunning inference or requiring the old provider to remain available.

An older checkpoint did not capture the source host's global default or private adapter configuration. These checks validate
the explicitly selected restore host and retained Session choices; they do not establish equality with an uncaptured source
default, endpoint or account. Configuration can also change after verification. Activation must repeat applicable checks and
coordinate the live ownership handoff. Source/connector configuration, authoritative-state reconciliation, runtime remapping,
supported restored activation and clean-host failover qualification remain open.

Qualification also exposed repeated ownership fencing rewriting an already requested job cancellation. The endpoint now
persists only a new cancellation or accepted-to-settled transition while continuing to terminate any live process on every
fence. This preserves revision stability for unchanged unsettled evidence; it never marks that evidence quiescent. A
regression test observes repeated monitor polls and then verifies that the unsettled revocation still blocks preparation.
