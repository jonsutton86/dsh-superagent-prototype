# 099 Creative workspace

**Status:** Phase 7 software increment. The Creative tab publishes and lists Markdown artifacts through the existing
library; missions remain the way to have an agent produce or revise creative work.

## Behavior

- Publish form: title, summary and Markdown content, saved as an `artifact` in the `workspace` scope with the existing
  `POST library` contract. The request uses a fresh idempotency key per submit.
- Recent list: `GET library?kind=artifact`, showing title, filename, bytes, creation time and summary.
- Read/act links stay in the ordinary Library and Missions pages; no new store, model call or external service.
- Empty, loading and error states are explicit; a refused publish is surfaced to the operator and the form keeps its
  content.

## Tests

- `tests/creative-ui.spec.tsx` renders the tab, form labels, save action and empty state.
- `tests/creative.spec.ts` publishes a Markdown artifact through the real Runtime host and reads its content back.

## Limits

- No rich editor, image upload, diff/history view or revision workflow; the library remains immutable per record and
  supersession uses existing `sources` relations.
- No automatic creative generation: a mission or explicit agent action is still required to produce content.
- Voice dictation inside the Creative tab is not wired; the existing Inbox dictation remains the voice entry point.
