# 104 iOS home-screen interface (PWA)

**Status:** The DSH web frontend already ships an installable web-app manifest; this increment adds a phone-sized panel
layout and documents the supported install path. No native SwiftUI app, offline cache or App Store package is claimed.

## Install on iPhone

1. Connect the iPhone to the same tailnet and ensure the Mac's Tailscale Serve mapping is running:
   `tailscale serve status` → HTTPS URL for `127.0.0.1:3083`.
2. In Safari, open the authenticated DSH URL printed by the web server (do not paste it into chat).
3. Share → **Add to Home Screen**. DSH's `manifest.webmanifest` supplies the app name, icon and fullscreen display.
4. Enter the panel, open the **JARVIS** tab; its action bar provides New task, New mission, Open main Session and
   confirmed Pause/Resume.
5. When the remote management API returns `401`, enter the administrator token into the JARVIS **Administration token**
   field. It is stored only in this Safari origin's localStorage and sent as a bearer on management requests; clear it
   when using a shared device. The token is not placed in a URL or logged.
5. For voice, follow `docs/097`; microphone access requires HTTPS (Tailscale Serve provides it) and a physical run.

## What the mobile layout changes

At widths ≤640px the panel uses full-width rows, wrapping action bars, horizontally scrollable tabs, 44px touch
targets, 16px inputs (prevents Safari zoom-on-focus), two-column statistics (one column under 380px) and safe-area
padding for the iPhone home indicator/notch.

## Honest limits

- The installed app is **DSH-branded**, not a separate JARVIS app; JARVIS is a tab inside it.
- The shell manifest has no service worker/offline cache; API calls still require live Tailscale access.
- Outer DSH web authentication and the orchestrator bearer flow still apply; there is no new credential bypass.
- No native icon/splash customization or App Store distribution; deferred by the chosen PWA-first order.
- The tokenized speech URL is still required for playback; the no-secret-in-URLs prerequisite in `docs/101` remains
  unresolved for remote voice.
