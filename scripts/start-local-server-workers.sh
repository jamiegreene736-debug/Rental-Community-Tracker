#!/usr/bin/env bash
set -euo pipefail

# Start lightweight local worker processes that consume the Railway
# queue and drive remote server Chrome/noVNC sidecars.
#
# This is what turns remote Chrome containers into parallel workers.
# Keep the normal launchd local worker running too; these workers use
# CHROME_PRIMARY=server and wait briefly before claiming work, so local
# Chrome remains the first/default path.
#
# Usage from the repo root on your Mac:
#   export SERVER_CHROME_HOST=<SERVER_IP_OR_DNS>
#   ./scripts/start-local-server-workers.sh 4

COUNT="${1:-${MAX_SERVER_INSTANCES:-4}}"
if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  echo "Count must be a number from 1 to 8" >&2
  exit 2
fi
if (( COUNT < 1 || COUNT > 8 )); then
  echo "Count must be between 1 and 8" >&2
  exit 2
fi

SERVER_HOST="${SERVER_CHROME_HOST:-}"
if [[ -z "$SERVER_HOST" ]]; then
  echo "SERVER_CHROME_HOST is required, e.g. export SERVER_CHROME_HOST=203.0.113.10" >&2
  exit 2
fi

NODE_BIN="${NODE_BIN:-$(command -v node)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is required" >&2
  exit 1
fi

WORKER_FILE="${WORKER_FILE:-$(pwd)/daemon/vrbo-sidecar/worker.mjs}"
LOG_DIR="${SIDECAR_SERVER_WORKER_LOG_DIR:-$HOME/Downloads/vrbo-sidecar}"
mkdir -p "$LOG_DIR"

BASE_CDP="${SERVER_CHROME_BASE_PORT:-9223}"
BASE_WEBDRIVER="${SERVER_CHROME_BASE_WEBDRIVER_PORT:-4445}"
BASE_NOVNC="${SERVER_CHROME_BASE_NOVNC_PORT:-7901}"
SCHEME="${SERVER_CHROME_SCHEME:-http}"
CLAIM_DELAY="${SIDECAR_SERVER_WORKER_CLAIM_DELAY_MS:-4000}"

echo "Starting ${COUNT} local overflow worker(s) for remote Chrome sidecars..."
for i in $(seq 1 "$COUNT"); do
  cdp_port=$((BASE_CDP + i - 1))
  webdriver_port=$((BASE_WEBDRIVER + i - 1))
  novnc_port=$((BASE_NOVNC + i - 1))
  endpoint="chrome-server-${i}=${SCHEME}://${SERVER_HOST}:${cdp_port}|${SCHEME}://${SERVER_HOST}:${webdriver_port}|${SCHEME}://${SERVER_HOST}:${novnc_port}"
  log_file="${LOG_DIR}/server-worker-${i}.log"

  pkill -f "SIDECAR_WORKER_NAME=server-worker-${i}" >/dev/null 2>&1 || true
  (
    export SIDECAR_WORKER_NAME="server-worker-${i}"
    export SIDECAR_WORKER_ROLE="server"
    export CHROME_PRIMARY="server"
    export SERVER_CHROME_ENDPOINTS="$endpoint"
    export SIDECAR_SERVER_WORKER_CLAIM_DELAY_MS="$CLAIM_DELAY"
    exec "$NODE_BIN" "$WORKER_FILE"
  ) >"$log_file" 2>&1 &

  echo "  server-worker-${i}: ${endpoint}"
  echo "    log: ${log_file}"
done

echo
echo "Local Chrome remains primary. These overflow workers wait ${CLAIM_DELAY}ms before claiming queued work."
echo "Live noVNC screens:"
for i in $(seq 1 "$COUNT"); do
  echo "  chrome-server-${i}: ${SCHEME}://${SERVER_HOST}:$((BASE_NOVNC + i - 1))"
done
