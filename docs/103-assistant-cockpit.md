# 102 JARVIS assistant cockpit

**Status:** Phase A of the JARVIS integration. The dashboard now has an action bar; it is not yet the full conversational
assistant described in the design proposal.

## What it does

The JARVIS tab starts with `AssistantActions`:

- **New task** opens Inbox compose; nothing is created until the operator submits.
- **New mission** opens the Missions page.
- **Open main Session** opens the master orchestrator Session.
- **Pause/Resume processing** is a confirmed action using the existing `POST executor/pause` endpoint; it reloads the
  panel state after the response.

All controls are explicit; there is no implicit approval, no model call, no new backend route and no secret handling.
The action bar uses only existing panel controls, routes and API endpoints.

## Verification

`tests/jarvis-ui.spec.tsx` checks the four button labels, the confirmed pause dialog and the existing seven-section
dashboard. TypeScript and the full suite are the acceptance gates.

## Limits

- No embedded master-chat transcript; **Open main Session** deep-links into DSH's own Session UI.
- No voice dictation inside JARVIS yet; Inbox remains the voice entry point.
- Approvals for individual tickets/missions remain on their existing pages with their existing evidence.
- Van/ChatGPT orchestration and the iOS app are separate layers and are not implemented here.
