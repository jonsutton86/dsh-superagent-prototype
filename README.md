# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

For standalone missions without a GitHub repository, follow [Local execution](docs/012-local-execution.md).
The workflow below configures the repository-backed mode.

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

This fork retains DeepSeek Harness and is implementing the article's broader architecture in integrated increments.
It is also building an [Agentic OS workspace](docs/010-agentic-os.md). The Missions tab supports persistent goals,
human/agent actions, dependencies, actual Harness dispatch, steering, and reviewed completion. The
[memory and artifact library](docs/011-library.md) adds scoped recall, immutable results, provenance, previews and worker
publication tools. The workspace ledger distinguishes these increments from the remaining full product and live deployment requirements.
The [local execution profile](docs/012-local-execution.md) runs general missions without mandatory GitHub setup, using
the same Engine, Harness Sessions, library, and completion review.
The [mission planner](docs/014-mission-plans.md) adds editable plans, agent proposals, explicit review and immutable history.
The [Environments tab](docs/015-execution-environments.md) enrolls local workspaces, verifies paired Harness filesystem/process
access, and manages task-bound execution grants with revocation and replacement.
The [managed world pool](docs/022-managed-worlds.md) maintains independent remote environments under one coordinator,
with exact per-action selection, paired worker/child providers, durable revocation and world-specific execution receipts.
The [checkpoint maintenance plugin](docs/023-checkpoint-recovery.md) captures encrypted coordinator, Session and world state,
verifies backups, and imports Sessions into a staged restore that remains blocked from execution pending ownership reconciliation.
[Recovery reservations](docs/029-recovery-reservations.md) bind replacement acquisition authority to a verified checkpoint,
invalidate the source claimant, and recover lost acknowledgements without removing that hold.
[Receipt audits](docs/030-recovery-receipt-audit.md) compare held checkpoint intents with revision-bound independent
execution and publication inventories, exposing missing, uncertain or unrecorded effects before activation work proceeds.
The [ownership authority](docs/024-ownership-fencing.md) provides separate coordinator generations and endpoint handoff
barriers, cancelling prior work and preserving its receipts before a successor can execute.
[Runtime ownership](docs/025-runtime-ownership.md) connects dedicated and managed worlds to that lease and stops work on
loss. The [publication service](docs/026-artifact-publication.md) sends operator-reviewed text artifacts to pinned GitHub
issue or PR comment destinations, with independent credentials, ownership fencing and persistent delivery receipts.
[Mission reply delivery](docs/027-mission-delivery.md) connects worker acknowledgements and router replies to that service
under exact plan/destination grants, including pinned GitHub review threads and Feishu/Lark root-message replies.
[Inbound task conversations](docs/028-inbound-conversations.md) let explicitly allowed participants steer one selected task
through those destinations, with durable deduplication, revocation and visible unsupported-message records.
Broader inbound discovery/task admission, repository integration and restored-state reconciliation remain required before staged restore activation.
Approved plans preserve execution history and invalidate affected results before they can be accepted again.

The [Inbox](docs/013-inbox.md) brings conversations, unread updates, questions and review into one view. Start a task,
send a follow-up, and open its mission or artifacts while keeping the same durable execution path.
The [implementation tracker](docs/IMPLEMENTATION.md) distinguishes working code from remaining work.
[Independent watchdog supervision](docs/009-supervision.md) runs in a separate Harness profile with durable incident history,
semantic progress assessment and bounded, fenced progress requests. Its [operator console](docs/052-supervision-console.md)
at `/watchdog` on that profile's port provides service health, evidence review, acknowledgements and paginated history even
when the main app is unavailable. Acknowledging evidence does not resolve the incident or retry work.

## License

[MIT](LICENSE)
