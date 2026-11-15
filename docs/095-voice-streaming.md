# 095 Voice streaming, interruption and iOS Safari

**Status:** Phase 5 client/transport increment. Speech synthesis is still produced by the existing bounded adapter and
stored as one audio result; playback now streams that result through a media element instead of buffering an object URL
in JavaScript. No cloud speech provider was contacted and no real iPhone qualification is claimed.

## Streaming playback

- A completed synthesis receipt carries a short-lived `mediaToken`.
- The panel sets the media element source to
  `/orchestrator/api/voice/<id>/audio?token=<mediaToken>`; the browser fetches and plays progressively.
- The audio route accepts only `GET`, checks the loopback Host, validates the token in constant time against that
  receipt, and serves `Accept-Ranges: bytes` with `206` range responses. A missing or wrong token is `403`.
- The token is not an administrator credential: it authorizes only that receipt's audio bytes, expires with the
  receipt, and is never accepted for management routes.

## Interruption and barge-in

- Stop aborts pending synthesis by its original request ID, pauses and releases the media element, and clears the
  playing state.
- Starting microphone dictation stops playback first, so spoken input cannot be masked by the reply.
- Navigation aborts pending synthesis and releases playback.

## iOS Safari

- `MediaRecorder` already prefers WebM/Opus and falls back to `audio/mp4`; Safari uses the MP4 path.
- On the synthesis click, the panel starts a silent WAV on the media element synchronously inside the user gesture and
  later replaces the source with the capability URL. This is the standard Safari unlock pattern; it is covered by a
  jsdom test that asserts the silent play and the tokenized source.
- Byte-range support lets Safari start before the whole result is fetched and seek within it.

## Honest limits

- This is transport/progressive playback, not chunked synthesis: the adapter still returns a complete audio buffer
  before the element starts. True token-by-token speech streaming needs a streaming adapter contract.
- Real iPhone Safari qualification (microphone permission, audio route, interruption by the lock screen or a phone call,
  backgrounding) requires a physical/manual device run. The automated tests simulate the browser APIs, not iOS.
- Cloud speech remains operator-configured and unverified; the panel labels the mode and never claims a live check.
