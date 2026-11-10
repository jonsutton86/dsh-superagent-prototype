# Development reference tools and pinned patterns

These tools support evidence-driven development of Agentic OS. They are not replacements for DeepSeek Harness, the
Engine, or its execution and ownership controls. Their outputs assist investigation; only the applicable captured evidence
and executable checks establish application behavior.

## Recorded toolchain

The 2026-11-10 investigation used isolated CLI packages outside the repository dependency tree:

| Tool | Version | Official source |
| --- | --- | --- |
| CodeGraph | `@colbymchenry/codegraph@1.6.2` | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) |
| REA | `rea-agents@6.8.0` | [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/) |
| REA Node runtime | `24.22.1` | Explicit local runtime; the host's Node 25 is outside this REA release's supported range |

Packages were acquired with lifecycle scripts disabled. No global agent configuration, default provider or application
dependency was changed by installing these development tools. Installation itself does not register an MCP server.
The CLIs are usable without reconfiguring or restarting the user's agent applications.

On the recorded Mac, the package prefix is `/Users/jonathansutton/.cache/agentic-os-devtools`, and the REA runtime is
`/Users/jonathansutton/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.
On another host, choose explicit equivalent paths and verify the supported runtime rather than assuming these exist.

```sh
AGENTIC_TOOL_DIR="$HOME/.cache/agentic-os-devtools"
npm install --prefix "$AGENTIC_TOOL_DIR" --ignore-scripts --no-audit --no-fund --save-exact \
  @colbymchenry/codegraph@1.6.2 rea-agents@6.8.0
```

The recorded top-level npm distribution integrities are:

```text
@colbymchenry/codegraph@1.6.2
sha512-hODH/mGnCf3IUMs6rzktv/zbecJIKJfdZAYHZ9mqecb0G7ZkHaA8CZafDVnswANFEL1YFcG+lfAwc5SIXzUH6Q==
rea-agents@6.8.0
sha512-9QDeRnGqEDzABZyr04eLnBXBv/c6I9/TWu/6M0MD4pEfkySI/BIgwTODIbAReX3C1x6hjw9+Jlx4A2yUSPZ9ww==
```

These identify the top-level archives, not a vendored transitive dependency set. Preserve the isolated installation lockfile
when reproducing that complete tool environment. Verify acquisition against the official package/repository identity.

## CodeGraph: index before structural investigation

Run the explicit CLI from the target checkout; no `codegraph install` or global agent registration is required:

```sh
"$AGENTIC_TOOL_DIR/node_modules/.bin/codegraph" telemetry off
"$AGENTIC_TOOL_DIR/node_modules/.bin/codegraph" init --yes
"$AGENTIC_TOOL_DIR/node_modules/.bin/codegraph" status --json
"$AGENTIC_TOOL_DIR/node_modules/.bin/codegraph" explore 'RepositoryPublisher RepositoryJournal publication intents'
```

The saved checkpoint's initial index covered 509 files, 13,249 nodes and 48,646 edges. These are index statistics, not proof
of runtime coverage. `.codegraph/` is local derived state and was excluded through `.git/info/exclude`; do not commit its
database. The installed version's CLI help, rather than an assumed README flag, determines accepted options.

Use `codegraph sync` after edits when operating through one-shot CLI commands. Do not assume an always-running MCP
watcher. Record the indexed source revision and check staleness before relying on returned source or relationships.
Cross-file and dynamic-dispatch relationships can include heuristics; use tests or runtime observations for behavioral
claims that the graph does not establish.

## REA: retain original evidence and report its limits

REA's CLI and MCP expose the same investigation workflows. Use the supported Node runtime explicitly:

```sh
AGENTIC_REA_NODE=/absolute/path/to/supported/node
"$AGENTIC_REA_NODE" "$AGENTIC_TOOL_DIR/node_modules/rea-agents/scripts/rea.mjs" --version
"$AGENTIC_REA_NODE" "$AGENTIC_TOOL_DIR/node_modules/rea-agents/scripts/rea.mjs" \
  analyze-javascript-application --help
```

For bounded source analysis, select exact files under a source root with repeated `--source-path` arguments or
`--source-paths-json`. `--detail summary --evidence_output /absolute/new/file.json` retains the complete evidence while
returning a compact summary; the output path is no-replace. Selection does not implicitly include dependencies. Record the
selection, source revision/digests, tool version, evidence identity and unknowns alongside any finding.

The first publisher investigation selected 13 source files and retained its approximately 34 MB original bundle at
`.artifacts/resume-2026-11-10/rea-publication.evidence.json`. This directory is ignored local derived evidence. Retain a
compact reproducible contract report in documentation; do not commit the large bundle or sensitive runtime evidence.
Use `inspect-analysis-view` to project saved evidence rather than repeatedly ingesting its full contents.

Static JavaScript evidence establishes the analyzed source relationships and retained observations. It does not by itself
prove dispatch ordering across process failure, durable SQLite behavior, ownership handoff or a provider's live result.
Pair it with targeted executable observations, including acknowledgement loss and restart tests. Native analysis is
appropriate when behavior actually depends on an unavailable native implementation; it is not required merely to restate
available TypeScript source. Additional native tools and their permissions remain separate, explicit setup work.

## Fabric: versioned operations inside the existing workflow

The [operations library](../prompts/operations/README.md) vendors four original patterns from Fabric revision
`de0b72766db0436b6c1887bb75768cb3960e67e5` (v1.4.568): feature extraction, code review, design review and summarization.
[Its manifest](../prompts/operations/manifest.json) records source URLs, Git blob identities and SHA-256 hashes; the original
MIT notice is retained. A separate [versioned evidence wrapper](../prompts/operations/EVIDENCE.md) requires source IDs and
locations, distinguishes observations/inferences/unknowns/proposals, and forbids inventing items to satisfy prompt quotas.

These prompts are selected by the development agent for recurring operations. This change does not wire them into default
Harness prompts or route work to a new model. Prompt content and analysis results never grant execution authority.

## Reference gallery and architecture

| Reference | Recorded revision | Use and boundary |
| --- | --- | --- |
| [Awesome Reverse Engineer Anything](https://github.com/maluramichael/awesome-reverse-engineer-anything/tree/8041ddc0adbdf29cbbcf1af4c07587b145e4eccc) | `8041ddc0adbdf29cbbcf1af4c07587b145e4eccc` | A generated gallery for finding comparable cases and tools. Popularity/health scores do not validate methods or establish this project's requirements. |
| [Fabric](https://github.com/danielmiessler/Fabric/tree/de0b72766db0436b6c1887bb75768cb3960e67e5) | `de0b72766db0436b6c1887bb75768cb3960e67e5` | Pinned prompt patterns, reused under the included MIT notice. |
| [OpenMonoAgent.ai](https://github.com/StartupHakk/OpenMonoAgent.ai/tree/e4b8eaeba0198bba7f1728390ee8472cf6bf1d98) | `e4b8eaeba0198bba7f1728390ee8472cf6bf1d98` | Conceptual reference for a terminal-first interface, local model option, shared core, bounded specialists and explicit tool permissions. No runtime replacement or code import. |

OpenMono's [architecture](https://github.com/StartupHakk/OpenMonoAgent.ai/blob/e4b8eaeba0198bba7f1728390ee8472cf6bf1d98/docs/ARCHITECTURE.md)
documents a .NET agent loop separate from an OpenAI-compatible inference service, with session persistence, tool dispatch
and terminal/extension interfaces. Agentic OS retains Harness and maps useful concepts onto its existing Engine and
provider abstractions. Upstream documentation is a reference, not independent acceptance testing of that software.
Local inference avoids provider per-token charges; it does not make hosted APIs or hardware operation free. The optional
Abliteration provider remains a paid external API under the owner's separate routing and spending constraints.

The gallery's root license is CC-BY-4.0, with Apache-2.0 in `LICENSE-CODE` and Michael Malura credited in `NOTICE`.
OpenMono advertises AGPL-3.0, but the recorded license file is abridged and GitHub reports `NOASSERTION`; this project uses
architectural ideas and links, not copied OpenMono implementation. The only upstream content vendored here is the Fabric
pattern set and its MIT license.
