#!/usr/bin/env sh
set -eu

role="${RAILWAY_SERVICE_ROLE:-web}"

case "$role" in
  sidecar-worker)
    export SIDECAR_BROWSER_MODE="${SIDECAR_BROWSER_MODE:-server}"
    export CHROME_PRIMARY="${CHROME_PRIMARY:-server}"
    export SIDECAR_WORKER_ROLE="${SIDECAR_WORKER_ROLE:-server}"
    export SIDECAR_DISABLE_LOCAL_CDP_FALLBACK="${SIDECAR_DISABLE_LOCAL_CDP_FALLBACK:-1}"
    export SIDECAR_HEADLESS_FALLBACK_ENABLED="${SIDECAR_HEADLESS_FALLBACK_ENABLED:-0}"
    export SERVER_CHROME_FALLBACK_ENABLED="${SERVER_CHROME_FALLBACK_ENABLED:-1}"
    export SERVER_CHROME_FALLBACK_VRBO="${SERVER_CHROME_FALLBACK_VRBO:-1}"
    export SIDECAR_OPEN_NOVNC_ON_ACQUIRE="${SIDECAR_OPEN_NOVNC_ON_ACQUIRE:-0}"
    export MAX_LOCAL_CHROME_INSTANCES="${MAX_LOCAL_CHROME_INSTANCES:-1}"
    echo "Starting Railway sidecar worker role"
    exec node daemon/vrbo-sidecar/supervisor.mjs
    ;;
  web|"")
    mkdir -p /app/client/public/photos
    cp -Rn /app/photos-seed/. /app/client/public/photos/ 2>/dev/null || true
    npm run db:push
    exec node dist/index.cjs
    ;;
  *)
    echo "Unknown RAILWAY_SERVICE_ROLE: $role" >&2
    exit 64
    ;;
esac
