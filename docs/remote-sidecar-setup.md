# Remote sidecar setup (no Mac required)

The sidecar has three layers:

| Layer | Role | Where it runs |
|-------|------|----------------|
| **Queue + UI** | Enqueue searches, show Operations screens | **Railway** (`main` web service) |
| **Workers** | Poll queue, drive Playwright, post results | **Remote only** (see below) |
| **Browsers** | Real Chrome for VRBO / Booking / Airbnb | Same host as workers |

Your Mac is **not** required. Do not run `install-vrbo-sidecar-launchagent.sh` unless you explicitly need a legacy local debug setup (`SIDECAR_ALLOW_LOCAL_MAC=1`).

## Recommended: Railway `rct-sidecar-worker` service

Use a **second Railway service** from the same repo image with `RAILWAY_SERVICE_ROLE=sidecar-worker`. Workers run Chromium under Xvfb inside Railway and talk to the main app over HTTPS.

### One-time setup

1. In Railway, **duplicate** the production service (or add a new service) named e.g. `rct-sidecar-worker`.
2. Point it at the same GitHub repo and branch as production.
3. Set service variables (share secrets with production where noted):

   | Variable | Value |
   |----------|--------|
   | `RAILWAY_SERVICE_ROLE` | `sidecar-worker` |
   | `SIDECAR_SERVER` | `https://rental-community-tracker-production.up.railway.app` (your main app URL) |
   | `ADMIN_SECRET` | Same as production |
   | `MAX_LOCAL_CHROME_INSTANCES` | `8` |
   | `CHROME_PROXY_ENABLED` | `1` |
   | `CHROME_PROXY_PROVIDER` | `decodo` (default; do not use Bright Data unless intentional) |
   | `DECODO_PROXY_USERNAME` / `DECODO_PROXY_PASSWORD` | Decodo residential credentials (or `CHROME_PROXY_USERNAME` / `CHROME_PROXY_PASSWORD`) |
   | `DECODO_PROXY_HOST` | `gate.decodo.com` (default) |
   | `DECODO_PROXY_PORT` | `7000` (default) |
   | Optional `DECODO_PROXY_STATE`, `DECODO_PROXY_CITY`, `DECODO_PROXY_SESSION_DURATION_MINUTES` | Geo targeting. Do **not** set `DECODO_PROXY_SESSION` unless you intentionally want a static IP session. |
   | `SIDECAR_FINGERPRINT_OS` | `macos` (default; set `random` only if you want to restore mixed Windows/macOS fingerprints) |
   | `CAPTCHA_SOLVING_ENABLED` | `1` |
   | `CAPSOLVER_API_KEY` | Your CapSolver key (same as production or worker-only) |
   | `SIDECAR_VRBO_MANUAL_VERIFICATION` | `1` (fallback if CapSolver cannot solve a slider) |

4. Deploy. Logs should show:
   - `Starting Railway remote sidecar worker (Xvfb + Chromium...)`
   - `config: ... CapSolver=on; proxy=on (decodo)` on worker slot 1
   - `proxy preflight OK: provider=decodo ... egress=<IP>` on worker slot 1
   - `using local Chrome sidecar #N via CDP` when a search starts

### VRBO + Booking search path (remote worker)

| Step | Behavior |
|------|----------|
| Queue | Railway web app enqueues `vrbo_search` / `booking_search` |
| Worker | `rct-sidecar-worker` claims job, launches Chromium in-container (Xvfb) |
| Proxy | **Decodo** residential (default provider) when `CHROME_PROXY_ENABLED=1`; each OTA job gets a new `-session-…` in the proxy username |
| Identity reset | Each OTA job starts from a fresh Chrome profile/fingerprint and skips persisted cookies; VRBO manual-solve cookies are not reused unless `SIDECAR_VRBO_REUSE_MANUAL_SESSION=1` is explicitly set |
| Fingerprint | Browser fingerprint defaults to macOS-only (`navigator.platform=MacIntel`, macOS UA/UA-CH, Apple WebGL renderer) to better match a real Mac sidecar |
| VRBO CAPTCHA | `stopOtaProviderIfBlocked` → CapSolver VisionEngine `slider_1` (puzzle + background images) → human-like drag → manual wait if still blocked |
| Booking CAPTCHA | Same `stopOtaProviderIfBlocked` hook before scraping result cards |

CapSolver VisionEngine requires **two** images (`image` = puzzle piece, `imageBackground` = background). The worker extracts them from the captcha widget before calling the API.
5. On your Mac, disable the old LaunchAgent (optional but recommended):

   ```bash
   ./scripts/disable-local-mac-sidecar.sh
   ```

6. In Operations, confirm **Sidecar live** and runtime label **Railway sidecar worker** (not “Local sidecar worker”).

### Why this replaces the Mac

- Workers poll `SIDECAR_SERVER` on Railway — no `launchd`, no Tailscale, no `SERVER_CHROME_HOST` on your laptop.
- Browsers run inside the worker container (`/usr/bin/chromium` + Xvfb), not on your desktop.

## Optional: VPS Docker pool (noVNC + Selenium Chrome)

For headed **noVNC** screens on a Linux VPS (eight Chrome containers + one supervisor), use:

```bash
cp .env.remote-sidecar.example .env.remote-sidecar
# Edit ADMIN_SECRET, SIDECAR_SERVER, proxy vars
./scripts/deploy-remote-sidecar-docker.sh 8
```

Open firewall ports `7901–7908` (noVNC) only if you need live viewing. Set Railway variable `SERVER_CHROME_HOST` to the VPS public IP **only** if something still reads it for diagnostics; workers on the VPS use internal Docker DNS via `SERVER_CHROME_ENDPOINTS`.

## Legacy Mac install (debug only)

```bash
SIDECAR_ALLOW_LOCAL_MAC=1 ./scripts/install-vrbo-sidecar-launchagent.sh
```

This is unsupported for production buy-in searches.
