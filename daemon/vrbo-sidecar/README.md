# vrbo-sidecar daemon

Local-Mac daemon that drives the operator's real Chrome via CDP for
Vrbo / Booking / Google / PM search + photo upload + Guesty channel
disconnect ops. Runs as a `launchd` LaunchAgent so it stays alive as
long as the Mac is on.

## Why it's not in the server tree

The daemon runs on the operator's Mac (not on Railway). It posts
results back to Railway over HTTPS. The repo holds the canonical
copy here so subsequent sessions can edit it; deploy is a manual
copy to `~/Downloads/vrbo-sidecar/` followed by
`launchctl kickstart -k gui/$UID/com.vrbosidecar.worker`.

## Files in this directory

- `supervisor.mjs` — launchd entrypoint. Starts up to three local
  worker processes and keeps them alive.
- `worker.mjs` — one queue worker. Plain Node ESM, no build step.
  Runs the queue poll loop and dispatches to per-op-type processors.
- `chrome-sidecar-manager.mjs` — allocates local Chrome sidecars on
  ports 9222, 9223, and 9224, with separate user-data dirs.

## Files NOT in this directory (operator-side state)

These live on the operator's Mac under `~/Downloads/vrbo-sidecar/`
and are NOT version-controlled because they're machine-specific:

- `cookies.json` — Cookie-Editor export from operator's main browser
  (vrbo.com, booking.com, expedia.com, hotels.com). Seeds the daemon
  Chrome on each restart. Auto-refreshed via the cookie-sync Chrome
  extension between restarts.
- `worker.log` — daemon's log output (rotated by launchd).
- `last-vrbo.jpg`, `last-booking.jpg` — most-recent screenshots
  dumped during scans for diagnostic purposes.
- `last-vrbo-state.json`, `last-booking-state.json` — page state
  (URL, title, body excerpt, HTML snippet) at the moment of
  extraction.

## Updating the daemon

When this repo's `worker.mjs` is updated:

```sh
# From the repo root, sync the new daemon code to your Mac
cp daemon/vrbo-sidecar/{worker,supervisor,chrome-sidecar-manager}.mjs ~/Downloads/vrbo-sidecar/

# Restart the daemon to pick up the changes
launchctl kickstart -k "gui/$UID/com.vrbosidecar.worker"

# Verify it's up
tail ~/Downloads/vrbo-sidecar/worker.log
```

## Chrome visibility

The daemon launches a dedicated Google Chrome profile hidden/offscreen
by default. This keeps the real local browser signal that Vrbo/Booking
need without taking over the operator's desktop. If you need to watch
or manually unblock the sidecar browser, restart the daemon with:

```sh
SIDECAR_CHROME_VISIBLE=1 /opt/homebrew/bin/node ~/Downloads/vrbo-sidecar/supervisor.mjs
```

Hidden mode also suppresses Playwright `bringToFront()` calls during
normal scraping. When VRBO shows a human verification challenge, the
worker first keeps Chrome hidden while it tries 2Captcha. Only if
2Captcha is disabled, fails, or times out does the affected Chrome
window surface for manual solving. After the challenge clears or the
manual wait times out, the worker returns that window to hidden mode.

```sh
SIDECAR_CHROME_VISIBLE=0                 # default hidden/background mode
SIDECAR_MACOS_BACKGROUND_LAUNCH=1        # use macOS background launch
SIDECAR_CAPTCHA_SURFACE_WINDOW=1         # reveal only for manual CAPTCHA fallback
SIDECAR_CAPTCHA_ALLOW_FOCUS=1            # allow focus stealing only for CAPTCHA fallback
SIDECAR_CHROME_VISIBLE_POSITION=120,80   # where the manual fallback window appears
SIDECAR_CHROME_HIDDEN_POSITION=-32000,-32000
```

## Local concurrency

Server Chrome fallback is disabled by default. The supervisor starts a
local worker pool instead, and `chrome-sidecar-manager.mjs` allocates
up to eight local Chrome profiles by default:

- `http://127.0.0.1:9222` using `VrboSidecar-Chrome`
- `http://127.0.0.1:9223` using `VrboSidecar-Chrome-2`
- `http://127.0.0.1:9224` using `VrboSidecar-Chrome-3`
- ...through `VrboSidecar-Chrome-8` when `MAX_LOCAL_CHROME_INSTANCES=8`

Set `MAX_LOCAL_CHROME_INSTANCES=1` through `8` for normal operation.
The manager has a hard safety cap of `12`. PM website discovery and PM
URL checks also use tab-level concurrency:

```sh
SIDECAR_PM_SITE_TAB_CONCURRENCY=3
SIDECAR_PM_URL_BATCH_CONCURRENCY=8
```

Hybrid overflow is still opt-in. Set `SERVER_CHROME_FALLBACK_ENABLED=1`
to let non-VRBO bulk work spill to server Chrome when every local
worker is busy. VRBO stays local-only by default because CAPTCHA/manual
solve needs the operator Mac; set `SERVER_CHROME_FALLBACK_VRBO=1` only
when that tradeoff is intentional.

```sh
SERVER_CHROME_FALLBACK_ENABLED=0
SERVER_CHROME_FALLBACK_VRBO=0
```

Each worker retries transient browser/network failures once by default
and exits for supervisor restart if a request exceeds its hard timeout:

```sh
SIDECAR_REQUEST_MAX_ATTEMPTS=2
SIDECAR_REQUEST_RETRY_BASE_MS=1500
SIDECAR_REQUEST_HARD_TIMEOUT_MS=600000
```

## VRBO slider CAPTCHA automation

When VRBO shows a slider CAPTCHA, the daemon first tries to clear it
with 2Captcha before falling back to manual verification. The 2Captcha
key stays on Railway:

```sh
railway variables set TWOCAPTCHA_API_KEY=<your-key>
```

Daemon knobs:

```sh
SIDECAR_VRBO_2CAPTCHA=1                 # default; set 0 to disable
SIDECAR_VRBO_2CAPTCHA_POLL_SECONDS=120  # default solve wait
SIDECAR_VRBO_2CAPTCHA_MAX_ATTEMPTS=1    # default attempts per wall
```

The daemon captures the challenge box while Chrome remains hidden,
Railway submits it as a
2Captcha CoordinatesTask, and the daemon drags the slider in the headed
Chrome window using the returned coordinate. If the challenge does not
clear, that specific Chrome window is surfaced with the manual banner.

If the daemon's Chrome session is stuck (rare — manifests as
"Browser context management is not supported" on connect), kill
the Chrome process and restart:

```sh
pkill -f "remote-debugging-port=9222"
sleep 5
launchctl kickstart -k "gui/$UID/com.vrbosidecar.worker"
```

## launchd plist (one-time setup)

`~/Library/LaunchAgents/com.vrbosidecar.worker.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vrbosidecar.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/jamiegreene/Downloads/vrbo-sidecar/supervisor.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MAX_LOCAL_CHROME_INSTANCES</key>
    <string>3</string>
    <key>SERVER_CHROME_FALLBACK_ENABLED</key>
    <string>0</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/Users/jamiegreene/Downloads/vrbo-sidecar/worker.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/jamiegreene/Downloads/vrbo-sidecar/worker.log</string>
</dict>
</plist>
```

Load with:
```sh
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.vrbosidecar.worker.plist
```

## What's gone wrong before (greatest hits)

- **Stale tabs in the daemon's Chrome** (#302) — `pages[0]` was
  pointing to a leftover tab from cookie-extension setup, so the
  daemon was scraping the wrong tab. Fix: always create a fresh
  page on each daemon start. Don't try to close existing tabs —
  closing the last tab quits Chrome on macOS.
- **Vrbo's data-stid changed** (#301) — selector `[data-stid="lodging-card-responsive"]` returned 0. Fix: anchor-fallback selector
  walking up from `<a href="/N">` Vrbo property links.
- **Vrbo card pricing format changed** (#299) — old `"$X for Y
  nights"` text gone, replaced with `"$X total includes taxes &
  fees"`. Fix: try new pattern first, fall back to old; tag each
  card with `priceIncludesTaxes` so server-side knows when to skip
  the per-region tax-normalization multiplier.
- **Booking scraper grabbed savings badge instead of total** (#285)
  — fixed by taking the largest `$X` on the price element.
- **VRBO bedroom-filter UI click broken** (#301) — Vrbo redesigned
  the search page and the "Filters" button no longer matches the
  selector we relied on. Fix: drop the click entirely; let the
  helper filter by exact-BR match client-side.
