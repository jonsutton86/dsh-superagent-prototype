# Inbox execution settings

The new-task composer extends [013 Inbox](013-inbox.md) with versioned personas from
[021 Personas](021-personas.md) and an explicit execution environment. DeepSeek Harness remains the execution runtime.
The selection flows through the existing Workspace action and Engine admission, preserving scoped process/filesystem
services and worker bindings. Replies stay within their original task and reject execution-selection fields.

## Reviewed choices and dispatch

`GET inbox/setup` describes the currently available default environment and its exact grant: environment ID, revision,
epoch and optional world binding. It distinguishes an unavailable default from available managed worlds. Owned managed
deployments require an explicitly selected enrolled world; they do not silently fall back to coordinator-local execution.
The composer reuses the existing persona and world selectors and shows the selected persona version, starting model
preference and optional tool capabilities. The selected version is retained when the catalog advances.

Selecting the default captures its grant. Polling never silently replaces that reviewed grant. If the default changes,
the operator must review the current location before Send. The server compares the supplied grant before creating the
mission and again against the actual dispatched ticket, inside the original inbox transaction. A mismatch rolls back
admission. Managed-world selections use the existing activation, readiness, ownership and mounting checks. New tasks
cannot use archived personas or revoked worlds. Legacy API callers that omit `expectedDefault` keep their existing default
selection behavior; the new composer supplies the precondition. The optional fields do not alter old receipt fingerprints.

The original inbox request identity includes text, attachment IDs and execution choices. An ambiguous response retains
the original request for retry even if polling subsequently reports an archived persona or unavailable environment.
Committed receipt lookup precedes fresh admission checks, so the retry retrieves the original task without dispatching
again. Changing the draft or choices starts a different request; reusing the original ID with different content fails.
The composer remains mounted while execution availability changes. File uploads still finish before Send, and their
original message bindings use [063 Conversation attachments](063-attachments.md).

## Captured task details

Conversation details show the ticket's original persona version, digest, name, starting model preference, capabilities,
execution grant and working directory. They do not replace the original snapshot with the latest persona definition.
Environment catalog names are descriptive labels, including historical revoked records; the original grant and ticket
directory remain authoritative. A missing catalog label does not erase the recorded execution. Model preference describes
the starting selection, not every inference call after an explicit model change in the Harness conversation.

No new credential, transport or process authority is introduced. These routes use the existing same-origin management
authentication. Persona instructions and credential values are not included in the settings view. Existing Store and
recovery snapshots already preserve task/persona/environment bindings; this increment introduces no new persistence tables.

## Verification and remaining acceptance

The focused service and rendered-UI checks cover exact persona versions, changed default grants, conflict/reply rejection,
Store reopen, archived/revoked receipt replay, and dispatch into an actually mounted managed world with no default available.
The installed-Harness qualification creates a persona containing a unique proof that is absent from the task message,
dispatches the task through the inbox into an explicitly selected world, then edits and archives that persona. It requires
the worker to produce and publish the original proof through real inference, and checks captured settings and artifact
provenance after Runtime restart and authenticated installed recovery. Attachment qualification can run in the same drill.

Local `pnpm check` passed typechecking, all six builds and 1,988 tests (16 skipped; 136 passing test files and three skipped;
130.32 seconds). The focused service/UI/environment/persona/world-pool selection checks passed 34 tests. Exact runtime/test
revision `432f4aeeca76177f32a2944932db48899a8d77db` passed native Linux / Node 24 typechecking, six builds and 1,996 tests
(10 skipped; 244.42 seconds) in [run 42716861135](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42716861135).
Installed-Harness inference/restart/recovery qualification remains pending. On resumption the previous temporary Harness installation and app process were
absent, and no configured provider credential was found in the checked project/profile locations. The pinned Harness was
reinstalled outside temporary storage. A new persistent local profile now serves the built application: authenticated page
access, management health and the reviewed default environment endpoint all returned HTTP 200. Its Store resides outside
temporary storage. This is a new instance, not recovery of the removed instance's history. Its credential store has no
DeepSeek API-key reference; live inference cannot be claimed until a configured provider is available again. The running
instance is left available for private provider setup through the Harness Models page.
Real browser acceptance, broader provider/persona quality, multi-workspace enrollment, retention and every remaining
requirement in the full Agentic OS and article implementation ledgers remain open. This increment does not declare the
whole architecture complete.
