# vrbo-sidecar daemon

Local-Mac daemon that drives the operator's real Chrome via CDP for
Vrbo / Booking / Google / PM search + photo upload + Guesty channel
disconnect ops. Runs as a `launchd` LaunchAgent so it stays alive as
long as the Mac is on.

## Why it's not in the server tree

The daemon runs on the operator's Mac (not on Railway). It posts
results back to Railway over HTTPS. The repo holds the canonical
copy here so subsequent sessions can edit it; deploy is a manual
copy to `~/Downloads/vrbo-sidecar/worker.mjs` followed by
`launchctl kickstart -k gui/$UID/com.vrbosidecar.worker`.

## Files in this directory

- `worker.mjs` — the daemon itself. Plain Node ESM, no build step.
  Runs the queue poll loop and dispatches to per-op-type processors.

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
cp daemon/vrbo-sidecar/worker.mjs ~/Downloads/vrbo-sidecar/worker.mjs

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
SIDECAR_CHROME_VISIBLE=1 /opt/homebrew/bin/node ~/Downloads/vrbo-sidecar/worker.mjs
```

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
    <string>/Users/jamiegreene/Downloads/vrbo-sidecar/worker.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
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
