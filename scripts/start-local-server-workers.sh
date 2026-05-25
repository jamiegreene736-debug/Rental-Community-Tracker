#!/usr/bin/env bash
set -euo pipefail

# DEPRECATED on Mac — use fully remote deploy instead:
#   ./scripts/deploy-remote-sidecar-docker.sh 8   # VPS
#   docs/remote-sidecar-setup.md                   # Railway sidecar-worker
#
# This script starts Node workers on the current machine that drive
# remote Docker chrome-server-* containers. Run it on the VPS after
# ./scripts/start-server-sidecars.sh, not on your Mac.
#
# Usage on the VPS:
#   export SERVER_CHROME_HOST=<THIS_VPS_PUBLIC_IP>
#   ./scripts/start-local-server-workers.sh 8

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
