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
   | `CHROME_PROXY_*` / `BRIGHTDATA_*` | Same proxy vars as production if used |
   | `CAPTCHA_SOLVING_ENABLED` | `1` (optional) |
   | `CAPSOLVER_API_KEY` | Your CapSolver key (optional) |

4. Deploy. Logs should show: `Starting Railway sidecar worker role with headed Chromium under Xvfb`.
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
