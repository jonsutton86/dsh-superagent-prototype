# 101 Tailscale iPhone/Safari qualification

## Status (2026-11-15, America/New_York)

**Blocked; not physically qualified.** The operator confirmed a physical iPhone is available. Its model,
iOS/Safari version and checklist observations have not been supplied. Tailscale lists an iOS peer on the same
tailnet; this proves neither browser access nor microphone/playback behavior.

The Mac listener is `127.0.0.1:3083`. Tailscale Serve is configured for
`https://jonathans-macbook-pro.tail9bf191.ts.net/`, proxying to that loopback listener. HTTPS requests from the Mac
reached the endpoint: `/` returned 401; `/orchestrator/api/overview` with the same-origin marker and Tailscale
Origin returned 403. These are access failures, not a panel-load pass. No credentials were requested in output,
no voice provider call was made, and the running application was not restarted or deployed.

## Operator setup

The macOS app CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale` on this machine; `tailscale` is not on PATH.
With that CLI on PATH, run:

```sh
tailscale status
tailscale serve --bg 3083
tailscale serve status
```

Keep the DSH Web server at `127.0.0.1:3083`. **Tailscale is the only ingress; no Funnel.** Never bind `0.0.0.0`.
Confirm the iPhone is signed into the same tailnet and tailnet policy permits only the intended operator/device.
Do not change ACLs to broad public or tailnet-wide access to work around an authentication failure.

The local source adds an opt-in management gate:

```sh
export DSH_ORCHESTRATOR_TRUSTED_ORIGIN=https://jonathans-macbook-pro.tail9bf191.ts.net
```

This is an origin, not a credential. Use the existing local secret-management flow to configure
`DSH_ORCHESTRATOR_ADMIN_TOKEN` (at least 32 characters); never paste it into chat, command output, URLs, screenshots
or a PR. Also satisfy the existing outer panel authentication that currently returns 401. The management client
currently reads its bearer from browser-local storage; a convenient iOS credential-entry/session flow is not
implemented. Do not disable either authentication layer to proceed.

**These source changes have not been installed in the running application.** Applying them/restarting the live
service is a deployment and requires the operator's separate approval. Build and review first.

## Security boundary

- The listener remains loopback-only. Serve provides encrypted tailnet transport, not application authorization.
- Configuration accepts exactly one canonical `https://machine.tailnet.ts.net` origin. No wildcard, HTTP, userinfo,
  explicit port (even 443), path, query, fragment or lookalike suffix is accepted.
- Requests must use the exact configured Host and the existing `x-orchestrator-request: 1` marker. An Origin,
  when present, must exactly match; browser GETs omitting Origin need `Sec-Fetch-Site: same-origin`.
- Remote requests require the configured administration bearer. Supervision retains its additional watchdog
  credential check. Distinct watchdog/admin credentials will therefore refuse remote supervision; it is not bypassed.
- Forwarded Host/Proto headers grant no authority. Loopback requests retain their existing checks and behavior.
- The origin gate does not establish network provenance by itself: restrict Serve to the tailnet and preserve
  the loopback listener and host authentication. XSS or a compromised operator browser can still steal its bearer.
- Existing media capability URLs remain loopback-only; the new gate does not widen that exception.

## Voice blocker before device testing

The current player (`src/client/voice.tsx`) appends a receipt capability to the audio URL. This conflicts with the
operator's no-secret-in-URLs requirement. Native media requests also lack the management marker/bearer required
for non-loopback requests. **Do not run remote Read aloud or mark streaming qualified with this implementation.**
A token-free authenticated progressive playback design and its tests are needed before this gate can pass;
weakening remote authentication or downloading the whole file and calling it progressive playback is not a substitute.

Use only an existing authorized local voice provider, or obtain explicit budget approval before any paid call.
Once the playback/access prerequisites are resolved and an approved deployment is running, execute every step in
[097 Voice device qualification](097-voice-device-qualification.md) on the physical iPhone. Record actual observations,
not inferred outcomes from the browser probe or unit tests.

| Record field | Current value |
| --- | --- |
| Preparation date/time zone | 2026-11-15, America/New_York |
| Device model | Awaiting operator |
| iOS / Safari version | Awaiting operator |
| Physical test date | Not run |
| Network | Intended: same Tailscale tailnet, HTTPS Serve URL above |
| Secure context / recorder / MIME | Not run |
| Permission deny + retry | Not run |
| Record / finish / cancel | Not run |
| Gesture playback | Blocked by playback authentication design |
| Stop / barge-in | Not run |
| Lock-screen / call | Not run |
| Background / return | Not run |
| Progressive start / range | Not run |
| Draft-only safety | Not run |
| Overall result | BLOCKED — not a physical qualification pass |

## Rollback

```sh
tailscale serve reset
```

This resets this node's Serve configuration, so first account for any other operator-owned Serve mappings.
Remove `DSH_ORCHESTRATOR_TRUSTED_ORIGIN` from the local launch configuration and restart only with deployment
approval. Keep the loopback listener, existing administrator authentication, policy, audit and emergency stop.
Do not enable Funnel as an alternative. No merge or deployment is authorized by this document.

## Connector authorization

The operator selected **Calendar only**, read-only. No concrete `.ics` path or HTTPS feed has been provided.
Calendar ingestion is stopped pending that exact input. Secret-bearing feeds must be configured locally; provide
only their local configuration path. Email and MCP are not authorized and have not been implemented or configured.
Future calendar work must use SourceKind → Trigger → Eval → Decision → Ticket and include health/policy tests.

## Additional read-only health evidence

The direct loopback management request with `x-orchestrator-request: 1` returned **state=200**. This is separate
from the outer DSH panel's 401. Both the saved `.webloc` and latest authenticated link in `app.log` returned 401
when checked without printing their credentials. Do not restart the session-hosting PID to repair them.
The running API reports no allowed senders, a null worker model, an unset ticket directory, and voice input/output
both null. Memory/providers/credentials APIs return 404 (Unknown operation). No setup values or credentials were
invented or changed. The author self-review records the remaining read-only evidence separately.
