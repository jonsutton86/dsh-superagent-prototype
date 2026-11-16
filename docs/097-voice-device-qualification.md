# 097 Voice device qualification

**Status:** The software scope is complete; **physical iPhone/Safari qualification is an operator-run gate and has not
been performed in this environment.** No test here proves iOS microphone permission, audio routing, lock-screen
interruption or background behavior.

## Software under test

- Tokenized, range-capable speech audio (`docs/095`), streamed through a media element.
- Silent-gesture unlock for Safari playback, then the capability URL.
- Stop/barge-in aborting synthesis by request ID and pausing playback.
- Safari recording fallback to `audio/mp4` when WebM/Opus is unsupported.
- JARVIS Voice section browser probe: `MediaRecorder`, preferred mime, microphone API, audio element and secure context.

The probe reports API presence only. It never claims permission, device or provider verification.

## Manual iPhone/Safari checklist

Record device, iOS version, Safari version and network for each run.

1. **Secure context** — open the panel over HTTPS or loopback; the Voice section shows secure context available.
2. **Recorder/format** — the Voice section shows the recorder API available and `audio/mp4` (or another supported
   format) as preferred.
3. **Microphone permission** — tap Record; Safari prompts. Deny once: the UI must say unavailable and keep text input
   usable. Allow on retry: recording starts.
4. **Recording duration/cancel** — record, finish, and cancel; no audio is uploaded on cancel and the draft remains.
5. **Synthesis playback** — tap Read aloud; audio must start without a second tap (gesture unlock) and play through the
   selected route.
6. **Interruption** — press Stop: synthesis is cancelled and audio pauses. Start dictation while speaking: playback stops
   before the microphone captures.
7. **Lock screen/call** — lock the device or receive a call during playback; note whether audio pauses and whether the UI
   remains consistent after returning. This is the main unresolved risk.
8. **Backgrounding** — background Safari during synthesis/playback and return; no duplicate requests or stuck state.
9. **Range behavior** — on a long reply, playback should start before the whole response is downloaded (network inspector
   or observed latency).
10. **Text safety** — every transcript remains a draft; nothing is sent or approved without the ordinary action.

## Pass/fail record

| Check | Pass | Fail | Notes |
| --- | --- | --- | --- |
| Secure context / probe | | | |
| Permission deny + retry | | | |
| Record/finish/cancel | | | |
| Gesture playback | | | |
| Stop and barge-in | | | |
| Lock screen / call | | | |
| Background return | | | |
| Progressive start | | | |
| Draft-only safety | | | |

A release claim requires this table to be completed on at least one physical iPhone with a recorded operator. Until then
Phase 5 is **software-complete, device-unqualified**.
