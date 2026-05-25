#!/usr/bin/env bash
set -euo pipefail

# Start N headed Chrome sidecars on a remote Docker host.
#
# Usage:
#   ./scripts/start-server-sidecars.sh          # starts 4 sidecars
#   ./scripts/start-server-sidecars.sh 8        # starts 8 sidecars
#
# After startup, run workers on the same VPS (not your Mac):
#   ./scripts/deploy-remote-sidecar-docker.sh 8
#
# Legacy Mac pointer (deprecated):
#   export SERVER_CHROME_HOST=<SERVER_IP_OR_DNS>
#   export MAX_SERVER_INSTANCES=<N>

COUNT="${1:-${MAX_SERVER_INSTANCES:-4}}"
if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  echo "Count must be a number from 1 to 8" >&2
  exit 2
fi
if (( COUNT < 1 || COUNT > 8 )); then
  echo "Count must be between 1 and 8" >&2
  exit 2
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is required. Install Docker Engine + Compose on this server." >&2
  exit 1
fi

SERVICES=()
for i in $(seq 1 "$COUNT"); do
  SERVICES+=("chrome-server-${i}")
done

"${COMPOSE[@]}" -f docker-compose.server.yml up -d "${SERVICES[@]}"

SERVER_HOST="${SERVER_CHROME_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
SERVER_HOST="${SERVER_HOST:-SERVER_IP}"

echo
echo "Started ${COUNT} Chrome sidecar(s). Configure your local daemon with:"
echo "  export SERVER_CHROME_HOST=${SERVER_HOST}"
echo "  export SERVER_CHROME_BASE_PORT=9223"
echo "  export SERVER_CHROME_BASE_WEBDRIVER_PORT=4445"
echo "  export SERVER_CHROME_BASE_NOVNC_PORT=7901"
echo "  export MAX_SERVER_INSTANCES=${COUNT}"
echo
echo "Live noVNC screens:"
for i in $(seq 1 "$COUNT"); do
  port=$((7900 + i))
  echo "  chrome-server-${i}: http://${SERVER_HOST}:${port}"
done
