# Guided workspace setup

The Start here page provides an operator path through the personal workspace in [010 Agentic OS](010-agentic-os.md).
It is available from the panel tabs and Overview, preserving the existing initial route and remembered navigation.
The guide reads the existing authenticated management APIs; it creates no new credential store, execution path,
permission grant, completion receipt or inference request.

## Model and execution checks

The guide displays the task and request-routing model selections separately. Each uses its saved role override when
present and otherwise the live Harness default. The model catalog comes directly from Harness. A provider listing a
model is described as catalog availability, never as proof of a successful inference request. Missing catalog entries,
provider lookup failures and unknown state remain visible. Custom unlisted model routes are not rejected by this view.
The guide links to role settings and directs provider configuration to the existing Harness Settings → Models page.
There is no API-key input in the guide, and it does not read or display credential values.

Model catalog reads run independently of environment, settings and mission reads. A failing provider cannot prevent
the operator from inspecting execution environments or selecting a persona. Catalog polling uses a 30-second interval;
explicit Refresh and restored page visibility also recheck it. Failed reads do not display stale catalog success.

The execution step shows the actual default location from [064 Inbox execution settings](064-inbox-execution-settings.md).
When only managed worlds are available, it directs the operator to choose an enrolled world in the task composer.
Pause, unavailable host/setup and unavailable execution environment prevent the guide's draft-entry action. Opening
the composer does not dispatch work. Actual submission retains the existing current-authority checks and reviewed
default/persona/world bindings. The coordinator storage location is disclosed with the limitation that copying this
folder alone is not a complete checkpoint/Session/credential/remote-resource recovery procedure.

## First task and review

Optional setup links cover personas, usage budgets and shared context. The guide explains file inputs and editable
dictation, explicit Send, questions and steering, artifact inspection and reviewed mission completion. It links to
schedules for subsequent runs of a verified workflow; viewing the guide never enables a schedule or relaxes a budget.

The draft-entry route opens the existing empty inbox composer. It supplies neither a prompt nor an execution command.
Existing conversation routes discard draft-entry query flags. Cancelling the new draft consumes the entry flag so
reopening the panel does not reopen a cancelled draft. Existing stored routes and the rest of inbox behavior remain.

Five recent missions are read from the existing mission service. Active work is not presented as complete, and changed
results requiring review take precedence over a historical completed status. A failed refresh hides stale completion
claims until current state can be read. Mission links open the original records; no onboarding flag substitutes for
review evidence, and the guide does not infer whole-system readiness from a completed task.

## Verification and remaining scope

Rendered tests cover model overrides, changes in the live catalog, provider failure, unavailable defaults with managed
execution, pause/offline handling, draft creation/cancellation/remount without mutation, and mission review freshness.
Local `pnpm check` passed typechecking, all six builds and 1,994 tests (16 skipped; 137 passing test files and three skipped;
135.12 seconds). The focused guide/panel/inbox/documentation checks passed 36 tests. Against the running installed Harness,
the real catalog endpoint returned the selected DeepSeek Flash default with zero advertised provider groups and no lookup
failure, matching the guide's unlisted-model case. Authenticated HTTP retrieval of the running app's advertised Superagent
client bundle returned the new guide and inbox-selection code after the build; the app process stayed running. This is
configuration and served-bundle evidence, not an inference test or visual browser acceptance. Exact runtime/test revision
`bfebde2ec8fbb85e47f3a1529db142fef36cb43e` passed native Linux / Node 24 typechecking, six builds and 2,002 tests
(10 skipped; 311.70 seconds) in [run 42719686052](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42719686052).
Live inference remains dependent
on the operator's configured provider; real browser acceptance, managed endpoint launch, broader deployment packaging
and every remaining architecture/product requirement stay open.
