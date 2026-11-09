# Optional speech input and output

The inbox now accepts microphone dictation into an editable draft and reads agent replies aloud on demand. Send still
creates the task or reply through the Engine and DeepSeek Harness. Speech services receive no tools, Sessions, execution
grants, publication authority, or inference credentials from the Harness provider registry.

## Configuration

Add `voice` to the `dsh-superagent` plugin config in the existing Harness profile. Input and output are independently
optional; absent adapters are disabled. Changing settings remounts the plugin. The UI reports local/cloud mode and never
silently changes providers or modes on failure. An inference API key alone does not enable audio services.

Local macOS example (install binaries and download a compatible whisper.cpp model separately):

```json
{
  "voice": {
    "input": {
      "kind": "whisper",
      "binary": "/opt/homebrew/bin/whisper-cli",
      "modelFile": "/private/operator/models/ggml-tiny.en.bin",
      "ffmpeg": "/opt/homebrew/bin/ffmpeg"
    },
    "output": {
      "kind": "say", "binary": "/usr/bin/say",
      "ffmpeg": "/opt/homebrew/bin/ffmpeg", "voice": "Samantha"
    }
  }
}
```

HTTP adapters use multipart `POST <url>/audio/transcriptions` with `model`, `file`, and `response_format=json`; synthesis
uses JSON `POST <url>/audio/speech` with `model`, `input`, optional `voice`, and `response_format=wav`. Include any `/v1`
prefix in the base URL. Transcription must return JSON `text`, and synthesis WAV bytes. See the primary
[vLLM transcription contract](https://docs.vllm.ai/en/stable/serving/online_serving/speech_to_text/) and
[vLLM-Omni speech contract](https://github.com/vllm-project/vllm-omni/blob/main/docs/serving/speech_api.md).
Protocol compatibility does not claim qualification against every provider/model.

```json
{
  "voice": {
    "input": { "kind": "http", "mode": "local", "url": "http://127.0.0.1:8000/v1", "model": "configured-asr-model" },
    "output": {
      "kind": "http", "mode": "cloud", "url": "https://speech.example.invalid/v1",
      "model": "configured-tts-model", "voice": "configured-voice",
      "credentialFile": "/private/operator/credentials/speech"
    }
  }
}
```

The cloud URL is a placeholder. Cloud mode requires HTTPS and a private credential file; local HTTP requires a literal
loopback address (`127.0.0.1` or `[::1]`) with optional authentication. Redirects are refused. Credentials follow existing
private-file rules: owned regular file, mode 0600, no extra hard links or symlinked parent, 32–4096 bytes, one token. Their
content is pinned until configuration remount. Credentials, executable/model files and speech temporary files must remain
outside execution roots, including subsequent enrollment. Local commands use fixed arguments and a minimal environment
without a shell. Cloud speech sends the chosen audio/text to the configured provider. Speech fees are not inferred from
LLM token counts; provider invoice/non-token usage integration remains outstanding.

## Interaction

Record requests microphone permission after a click. Finish recording waits for the final audio chunk, following the
[MediaStream Recording event ordering](https://www.w3.org/TR/mediastream-recording/). Transcription appends to the editable
draft. Send is disabled during dictation and requires the operator's ordinary submit action. Unsupported recording,
permission denial, provider errors and cancellation preserve text input.

Read aloud synthesizes an agent reply on demand. Stop speaking cancels pending synthesis or stops playback. Starting
dictation stops playback; navigation aborts work, releases microphone tracks and revokes object URLs. A permission grant
arriving after navigation is released without starting recording. This is bounded push-to-talk and explicit playback;
continuous streaming, simultaneous input/output echo handling, wake words, automatic spoken replies, long-reply chunking
and provider-specific realtime sessions remain separate work.

Limits: two concurrent operations, 30 seconds per recording, 2 MiB input audio, 2,000 characters per spoken reply, 8 MiB
returned audio and a 120-second adapter deadline. Inputs support WAV/WebM/Ogg/MP4 signatures. Local input decodes at most
30 seconds to mono 16 kHz PCM for [whisper.cpp's CLI](https://github.com/ggml-org/whisper.cpp/tree/master/examples/cli).
Local synthesis converts macOS `say` output to mono 24 kHz WAV, at most 120 seconds. Long replies remain readable as text.

## HTTP and lifecycle

Routes retain the management API's loopback, same-origin and request-header checks. Mutations also require current
coordinator ownership when configured. These are not public remote/mobile endpoints.

| Route | Result |
| --- | --- |
| `GET voice` | Enabled modes and limits; no paths or secrets |
| `POST voice/transcribe` | `{requestId, mime, audio}` with bounded base64; returns receipt |
| `POST voice/speak` | `{requestId, text}`; returns receipt |
| `GET voice/:id` | Receipt, including successful draft transcript |
| `POST voice/:id/cancel` | Idempotent cancellation attempt; waits for adapter cleanup |
| `GET voice/:id/audio` | Completed WAV with `no-store`; requires the same request header |

SQLite records request fingerprints before dispatch. Identical retries retrieve the receipt; changed content under the
same ID is refused. Reopening/restoring running work marks it interrupted and never repeats the provider call. Cancel
aborts HTTP or terminates the local process group, waiting for exit before temporary-file removal. It cannot establish
whether a cloud service already processed/billed the request. A new request requires a new explicit user action.

Raw input audio is not stored in SQLite. Local temporary audio/text is private and removed after each operation;
crash-left operation directories are cleaned at startup under the Runtime state lock. Returned transcripts/audio expire
logically after 15 minutes, with background cleanup each minute. Content-free fingerprints remain to prevent old retries
from reissuing calls. At 10,000 receipts new operations are refused; operator retention/migration UI remains outstanding.
Logical expiry is not secure erasure of SQLite pages, WAL or checkpoints. Existing backup protection/retention applies.
Sent transcripts become ordinary inbox history. Recovery does not infer relocated speech models/credentials: configure
them in the Harness base profile. Speech never renews execution grants or changes checkpoint activation proofs.

## Verification

`tests/voice.spec.ts` checks HTTP contracts, replay/conflict, no task before Send, cancellation, concurrency, interrupted
restart, expiry, credential pinning/root exclusion, malformed input, redirects, oversized output and provider refusal.
`tests/voice-ui.spec.tsx` checks final chunks, editable drafts, explicit Send, cancellation, late permission cleanup,
playback interruption, navigation cleanup and recording limits. DOM/media doubles do not establish real browser or
microphone acceptance.

Opt-in local qualification exercises actual macOS `say`, FFmpeg and whisper.cpp using generated speech, validates its
transcript and temporary-file cleanup. `DSH_VOICE_MODEL` also enables this round trip in the installed Harness test:
raw-audio authorization, receipt replay after restart and a transcribed mission objective followed by real inference/tool
execution and the existing recovery drill. No user microphone recording is used. Exact qualification receipts are added
to the implementation ledger when the complete checks pass.
