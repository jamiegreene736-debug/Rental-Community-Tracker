# syntax=docker/dockerfile:1.7-labs
FROM node:22-slim

RUN apt-get update && apt-get install -y chromium xvfb ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Split the committed photo bundle from the rest of the source tree so
# the image only ships it once. The main COPY excludes
# client/public/photos; the second COPY places the same files at
# /app/photos-seed — the backup location the CMD seeds the Railway
# volume from on boot. Avoiding the duplicate keeps the image ~88MB
# smaller, which matters for Railway's snapshot/upload step. See
# Load-Bearing Decision #17 in AGENTS.md.
#
# Requires the BuildKit Dockerfile 1.7-labs frontend (the `# syntax=`
# line above). `--exclude` lives in the experimental/labs channel, not
# mainline 1.7 — the plain `1.7` tag will fail to parse this flag with
# "unknown flag: exclude". Promote to mainline when docker/dockerfile
# ships it there.
COPY --exclude=client/public/photos . .
COPY client/public/photos /app/photos-seed/

RUN npm run build

ENV NODE_ENV=production

# Startup sequence:
#   1. Ensure the photos dir exists (first boot with fresh volume = empty).
#   2. Seed the volume from /app/photos-seed using `cp -Rn` — non-clobber,
#      so scraped photos from prior boots are preserved while any
#      newly-committed seed photos still land on fresh volumes.
#   3. Apply Drizzle schema changes before the server starts. This keeps
#      database-backed features such as manual buy-in reservations alive across
#      deploys without hand-written migration SQL.
#   4. Start the server.
#
# A second Railway service runs the same image with RAILWAY_SERVICE_ROLE=sidecar-worker
# (remote queue workers + Chromium on Railway — no Mac LaunchAgent). See docs/remote-sidecar-setup.md.
CMD ["sh", "-c", "if [ \"${RAILWAY_SERVICE_ROLE:-web}\" = \"sidecar-worker\" ]; then export DISPLAY=\"${DISPLAY:-:99}\" SIDECAR_BROWSER_MODE=\"${SIDECAR_BROWSER_MODE:-cdp}\" CHROME_PRIMARY=\"${CHROME_PRIMARY:-local}\" SIDECAR_WORKER_ROLE=\"${SIDECAR_WORKER_ROLE:-server}\" LOCAL_CHROME_BINARY=\"${LOCAL_CHROME_BINARY:-/usr/bin/chromium}\" LOCAL_CHROME_USER_DATA_DIR=\"${LOCAL_CHROME_USER_DATA_DIR:-/tmp/rct-sidecar-chrome}\" SIDECAR_CHROME_VISIBLE=\"${SIDECAR_CHROME_VISIBLE:-1}\" SIDECAR_DISABLE_LOCAL_CDP_FALLBACK=\"${SIDECAR_DISABLE_LOCAL_CDP_FALLBACK:-0}\" SIDECAR_HEADLESS_FALLBACK_ENABLED=\"${SIDECAR_HEADLESS_FALLBACK_ENABLED:-0}\" SIDECAR_HEADLESS_PROXY_DIRECT_FALLBACK=\"${SIDECAR_HEADLESS_PROXY_DIRECT_FALLBACK:-0}\" SERVER_CHROME_FALLBACK_ENABLED=\"${SERVER_CHROME_FALLBACK_ENABLED:-0}\" SERVER_CHROME_FALLBACK_VRBO=\"${SERVER_CHROME_FALLBACK_VRBO:-0}\" SIDECAR_OPEN_NOVNC_ON_ACQUIRE=\"0\" SIDECAR_WARM_ALL_LOCAL_CHROME=\"${SIDECAR_WARM_ALL_LOCAL_CHROME:-0}\" MAX_LOCAL_CHROME_INSTANCES=\"${MAX_LOCAL_CHROME_INSTANCES:-8}\"; echo \"Starting Railway remote sidecar worker (Xvfb + Chromium, slots=${MAX_LOCAL_CHROME_INSTANCES})\"; echo \"CapSolver enabled when CAPTCHA_SOLVING_ENABLED=1 and CAPSOLVER_API_KEY is set on this service\"; Xvfb \"$DISPLAY\" -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & exec node daemon/vrbo-sidecar/supervisor.mjs; fi; mkdir -p /app/client/public/photos && cp -Rn /app/photos-seed/. /app/client/public/photos/ 2>/dev/null || true; npm run db:push && exec node dist/index.cjs"]
