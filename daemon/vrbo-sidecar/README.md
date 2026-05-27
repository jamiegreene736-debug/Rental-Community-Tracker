# vrbo-sidecar daemon

Remote queue workers that drive real Chrome (via CDP) for Vrbo /
Booking / Airbnb / PM search and related ops. Workers poll the Railway
app over HTTPS and post results back.

## Production deploy (remote — no Mac)

**Recommended:** a second Railway service (`rct-sidecar-worker`) using
the same Dockerfile with `RAILWAY_SERVICE_ROLE=sidecar-worker`.

```sh
./scripts/setup-remote-sidecar.sh
```

See [docs/remote-sidecar-setup.md](../../docs/remote-sidecar-setup.md).

**Optional:** VPS Docker pool (Selenium Chrome + noVNC + supervisor):

```sh
./scripts/deploy-remote-sidecar-docker.sh 8
```

## Legacy Mac install (debug only)

```sh
SIDECAR_ALLOW_LOCAL_MAC=1 ./scripts/install-vrbo-sidecar-launchagent.sh
./scripts/disable-local-mac-sidecar.sh   # stop Mac workers when moving to remote
```

## Why it's not in the server tree

The main Railway web service only hosts the queue/UI. Browser workers
run in the dedicated Railway sidecar service or on a VPS — not on the
operator's Mac by default.

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

## Variation search

Airbnb, Vrbo, and Booking.com buy-in searches start from the visible
provider UI. The worker types the normalized resort/community prefix
into the provider destination field, waits for the autocomplete
dropdown, filters visible suggestions by the community token policy and
city/location guard, then runs each accepted suggestion as a separate
provider search. Results are deduped before returning to the web app.

Provider URL policy:

- **VRBO:** no constructed `/search` URL injection. VRBO must use the
  visible dropdown, visible date controls, and visible Search button.
  Constructed VRBO result URLs trigger CAPTCHA too aggressively.
- **Airbnb and Booking.com:** after the destination has been confirmed
  from the visible provider dropdown, the worker may use provider
  results URLs with query parameters for dates, bedrooms, and the
  confirmed destination text. This avoids slow calendar/dropdown loops
  while preserving the provider-selected location guard.

Successful priced OTA result sets are cached by the server queue for
`SIDECAR_SUCCESS_RESULT_CACHE_TTL_MS` (default 48 hours). The key
includes provider, destination/search term, date window, and bedroom
request (VRBO intentionally shares a full resort/date result set across
bedroom passes). Clear Queue flushes this cache.

The server generates the initial policy with `generateSearchVariations`
and passes `searchVariations` plus `variationMode.filterTokens` to the
daemon. For `Poipu Kai`, for example, dropdown options must include the
required resort-prefix tokens, so broad or neighboring matches such as
`Pili Mai at Poipu` are rejected while `The Villas at Poipu Kai` is
eligible.

Each completed provider op returns `variationsTried` with the typed
query, selected `suggestionText`, success flag, and candidate count. The
Operations buy-in panel shows the latest summary, saved preferred terms,
and any currently untried terms. The `Re-run untried` action asks the
server to send only untried policy terms for that community/date/bedroom
window.

If the DOM click/fill path misses a critical destination field,
dropdown option, or submit button, the env-gated vision fallback posts a
fresh screenshot through the sidecar screen endpoint and asks the
configured vision model for a bounded click/type action. Enable it with:

```sh
USE_OTA_VISION_FALLBACK=1
SIDECAR_USE_VISION_FALLBACK=1
ANTHROPIC_API_KEY=<key>
SIDECAR_VISION_MODEL=claude-haiku-4-5-20251001
```

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

The daemon defaults to Grok's recommended production path:
`SIDECAR_BROWSER_MODE=server` with `CHROME_PRIMARY=server`. That
prefers remote headed Chrome/noVNC workers and injects the configured
sticky residential proxy settings, while the dashboard receives live
screenshots from `page.screenshot()`.

If the server Chrome pool is unavailable, `SIDECAR_HEADLESS_FALLBACK_ENABLED=1`
uses a local persistent headless Chrome profile as the no-window
fallback. That fallback still uses the operator's local network/IP,
but it is lower fidelity than headed noVNC Chrome.

The older local headed Chrome grid is debug-only. If you need to watch
or manually unblock the sidecar browser on the desktop, restart the
daemon with:

```sh
SIDECAR_CHROME_VISIBLE=1 /opt/homebrew/bin/node ~/Downloads/vrbo-sidecar/supervisor.mjs
```

Hidden mode also suppresses Playwright `bringToFront()` calls during
normal scraping. When VRBO shows a human verification challenge, the
worker keeps Chrome hidden while it checks whether CAPTCHA automation is
explicitly enabled. By default automation is disabled and the request
rotates/fails with a blocked provider status instead of silently using an
old solver. If manual fallback is enabled, the affected Chrome window can
surface for manual solving. After the challenge clears or the manual wait
times out, the worker returns that window to hidden mode.

```sh
SIDECAR_CHROME_VISIBLE=0                 # default hidden/background mode
SIDECAR_BROWSER_MODE=server              # default server/noVNC mode
CHROME_PRIMARY=server
SIDECAR_DISABLE_LOCAL_CDP_FALLBACK=1     # never open desktop Chrome from server mode
SIDECAR_HEADLESS_FALLBACK_ENABLED=1      # no-window fallback if server Chrome is offline
SIDECAR_HEADLESS_BROWSER_CHANNEL=chrome  # use installed Chrome in headless mode
SIDECAR_MACOS_BACKGROUND_LAUNCH=1        # use macOS background launch
SIDECAR_CAPTCHA_SURFACE_WINDOW=1         # reveal only for manual CAPTCHA fallback
SIDECAR_CAPTCHA_ALLOW_FOCUS=1            # allow focus stealing only for CAPTCHA fallback
SIDECAR_CHROME_VISIBLE_POSITION=120,80   # where the manual fallback window appears
SIDECAR_CHROME_HIDDEN_POSITION=-32000,-32000
```

For a dedicated sidecar monitor or local debugging session, set
`SIDECAR_CHROME_VISIBLE=1` and place the visible grid on that display.
Chrome launches with macOS `open -g` so it should appear without
stealing focus from Safari, and visible mode does not pass
`--start-minimized`:

```sh
SIDECAR_CHROME_VISIBLE=1
SIDECAR_CHROME_VISIBLE_GRID_ORIGIN=1440,60
SIDECAR_CHROME_VISIBLE_SIZE=400,420
SIDECAR_CHROME_VISIBLE_GRID_COLUMNS=4
SIDECAR_CHROME_VISIBLE_GRID_GAP_X=0
SIDECAR_CHROME_VISIBLE_GRID_GAP_Y=0
SIDECAR_WARM_ALL_LOCAL_CHROME=1
# Optional exact per-instance override for matching Rectangle slots:
# SIDECAR_CHROME_VISIBLE_POSITIONS=1440,60;1840,60;2240,60;2640,60;1440,480;1840,480;2240,480;2640,480
```

The visible grid should stay at a real desktop size. Several OTA date
pickers collapse or hide calendar controls in thumbnail-sized windows,
which can make visible-field searches look idle or fail date entry. The
worker still reasserts its emulated desktop viewport before navigation
snapshots and vision fallback screenshots; if logs ever show
`warning: scrape viewport stayed small`, increase
`SIDECAR_CHROME_VISIBLE_SIZE` before trusting provider card extraction.

## Local concurrency

Server Chrome is enabled by default for the installed LaunchAgent. The
supervisor still starts a local worker pool, but in default server mode
those workers claim queue items and drive server Chrome/noVNC
instances. In legacy local-CDP mode they map to local Chrome profiles:

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

Server Chrome is now the preferred path. `SERVER_CHROME_FALLBACK_ENABLED=1`
enables the server/noVNC pool, `SERVER_CHROME_FALLBACK_VRBO=1` allows
VRBO jobs to use it, and `SIDECAR_DISABLE_LOCAL_CDP_FALLBACK=1`
prevents the daemon from opening desktop Chrome windows if the server
pool is down.

```sh
SERVER_CHROME_FALLBACK_ENABLED=1
SERVER_CHROME_FALLBACK_VRBO=1
SIDECAR_DISABLE_LOCAL_CDP_FALLBACK=1
```

Each worker retries transient browser/network failures once by default
and exits for supervisor restart if a request exceeds its hard timeout:

```sh
SIDECAR_REQUEST_MAX_ATTEMPTS=2
SIDECAR_REQUEST_RETRY_BASE_MS=1500
SIDECAR_REQUEST_HARD_TIMEOUT_MS=600000
```

VRBO hard blocks are handled separately from transient browser errors.
If a page says the browser/session has been blocked, the worker tears
down only that VRBO browser allocation and retries the same VRBO request
with a fresh session/proxy identity. Other channels in the same buy-in
search continue through their own queue work.

```sh
SIDECAR_VRBO_HARD_BLOCK_FRESH_RETRIES=2 # default fresh VRBO-only retries
```

## CAPTCHA provider configuration

CapSolver is the configured CAPTCHA provider surface. Automatic solving
is disabled by default for provider scrapers; VRBO should surface a
blocked provider status and rotate/fail according to provider policy.
Keep the CapSolver key on Railway:

```sh
railway variables set CAPTCHA_PROVIDER=capsolver CAPSOLVER_API_KEY=<your-key> CAPTCHA_SOLVING_ENABLED=0
```

Daemon knobs:

```sh
SIDECAR_VRBO_CAPTCHA_AUTOMATION=0       # default; provider should rotate/fail
SIDECAR_VRBO_CAPTCHA_POLL_SECONDS=120   # reserved for future authorized flows
SIDECAR_VRBO_CAPTCHA_MAX_ATTEMPTS=2     # reserved for future authorized flows
```

The local LaunchAgent also needs `ADMIN_SECRET` so Railway's auth
middleware allows the daemon to call the sidecar queue and status
endpoints.
Run `./scripts/install-vrbo-sidecar-launchagent.sh` from a Railway-linked
checkout; the installer will load `ADMIN_SECRET` from Railway variables
when it is not already exported locally. A healthy startup log should show
`admin-secret=set`, not `admin-secret=none`.

If the daemon's Chrome session is stuck (rare — manifests as
"Browser context management is not supported" on connect), kill
the Chrome process and restart:

```sh
pkill -f "remote-debugging-port=9222"
sleep 5
launchctl kickstart -k "gui/$UID/com.vrbosidecar.worker"
```

## launchd setup (one-time setup)

Preferred setup from the repo root:

```sh
./scripts/install-vrbo-sidecar-launchagent.sh
```

That script copies the current sidecar files into
`~/.vrbo-sidecar-daemon`, writes the LaunchAgent plist, stops any
manual sidecar supervisor already running from Terminal, and kickstarts
`com.vrbosidecar.worker`. The LaunchAgent uses `KeepAlive`, so macOS
starts it at login and restarts it if the sidecar exits. The daemon is
installed outside `~/Downloads` because macOS can block LaunchAgents
from executing files there with `Operation not permitted`.

The installer defaults to the in-dashboard viewing flow:

```sh
SIDECAR_BROWSER_MODE=server
CHROME_PRIMARY=server
SERVER_CHROME_FALLBACK_ENABLED=1
SERVER_CHROME_FALLBACK_VRBO=1
SIDECAR_DISABLE_LOCAL_CDP_FALLBACK=1
SIDECAR_HEADLESS_FALLBACK_ENABLED=1
SIDECAR_HEADLESS_BROWSER_CHANNEL=chrome
SIDECAR_CHROME_VISIBLE=0
SIDECAR_WARM_ALL_LOCAL_CHROME=0
SIDECAR_ALLOW_FOCUS=0
SIDECAR_CAPTCHA_SURFACE_WINDOW=1
SIDECAR_CAPTCHA_ALLOW_FOCUS=1
```

To intentionally bring back a large two-column monitor grid for local
debugging, override these before running the installer:

```sh
SIDECAR_CHROME_VISIBLE=1
SIDECAR_CHROME_VISIBLE_GRID_ORIGIN=1440,60
SIDECAR_CHROME_VISIBLE_SIZE=1280,900
SIDECAR_CHROME_VISIBLE_GRID_COLUMNS=2
SIDECAR_CHROME_VISIBLE_GRID_GAP_X=24
SIDECAR_CHROME_VISIBLE_GRID_GAP_Y=35
SIDECAR_CHROME_VISIBLE_POSITIONS=1440,60;2744,60;1440,995;2744,995;1440,1930;2744,1930;1440,2865;2744,2865
SIDECAR_WARM_ALL_LOCAL_CHROME=1
SIDECAR_ALLOW_FOCUS=0
```

Override the grid values if the monitor layout changes.

Manual plist reference:

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
    <string>8</string>
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
