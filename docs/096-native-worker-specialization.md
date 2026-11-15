# 096 Native worker specialization

**Status:** Phase 3 closes without an external coding agent. DSH already provides worker specialization natively; Codex
delegation remains an optional external adapter, not a requirement.

## What already specializes a worker

A ticket runs in its own DSH worker Session. Specialization is the immutable **persona** carried by the ticket:

- **Model:** `Sessions.ensure` seeds `persona.definition.model` before `executor.model`, so a selected specialization
  determines the worker's model without changing the global default (`src/app/sessions.ts`, `initializeRoleModel`).
- **Instructions:** `bindPersona` appends the persona's versioned instructions and allowed capability list to the worker
  system prompt (`src/personas/runtime.ts`).
- **Tools:** a persona tool guard denies read/write/commands/web/delegation/skills tools that the persona did not grant;
  the worker still gets only the profile's work tools and the mission mandate, environment and host policy remain
  authoritative.
- **Skills:** persona skills are mounted into that worker's skill scope only.
- **Pinning:** the persona digest is verified and recorded per Session; later persona edits cannot change an existing
  run, and a Session belonging to another persona version is refused.

Personas are created and selected through the existing `POST personas` / `GET personas` API and the mission/action
persona reference; no new endpoint or setting is required.

## Qualification

- `tests/worker-specialization.spec.ts` checks the capability→tool mapping, read-only denial, partial grants, and that a
  persona with no optional capabilities denies every optional tool while retaining its model.
- `tests/abliteration-provider.spec.ts` proves the persona model is seeded and pinned across edits and database reopen.
- `tests/attachments.spec.ts` proves capability-scoped tools cannot be used beyond the grant.

## Why Codex is not part of the gate

Invoking Codex would require an external binary/account, network access and potentially paid usage. Nothing in JARVIS or
DSH requires it: a specialized DSH worker already receives a scoped model, instructions, tools and skills. A future
Codex adapter can implement the same delegation boundary (routing → reserved usage → transport) without changing the
specialization contract.

## Limits

- Personas are operator-selected per mission/action; there is no automatic classifier that picks one from free text.
- Persona instructions are bounded (12,000 characters) and capabilities cannot grant authority the environment or
  mandate withholds.
- No real Codex/worker marketplace integration is claimed.
