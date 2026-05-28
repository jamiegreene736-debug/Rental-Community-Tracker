#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COUNT="${1:-8}"
ENV_FILE="${REPO_ROOT}/.env.remote-sidecar"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.remote-sidecar.yml"

if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || (( COUNT < 1 || COUNT > 8 )); then
  echo "Usage: $0 [1-8]" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required on this VPS." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is required." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${REPO_ROOT}/.env.remote-sidecar.example" "${ENV_FILE}"
  echo "Created ${ENV_FILE} — set ADMIN_SECRET and SIDECAR_SERVER before continuing."
  exit 1
fi

if ! grep -q '^ADMIN_SECRET=.\+' "${ENV_FILE}" 2>/dev/null; then
  echo "Set ADMIN_SECRET in ${ENV_FILE} (same value as Railway production)." >&2
  exit 1
fi

endpoints=()
for i in $(seq 1 "$COUNT"); do
  endpoints+=("chrome-server-${i}=http://chrome-server-${i}:9222|http://chrome-server-${i}:4444|http://chrome-server-${i}:7900")
done
joined="$(IFS=,; echo "${endpoints[*]}")"

tmp_env="$(mktemp)"
grep -v '^SERVER_CHROME_ENDPOINTS=' "${ENV_FILE}" | grep -v '^MAX_LOCAL_CHROME_INSTANCES=' >"${tmp_env}" || true
{
  cat "${tmp_env}"
  echo "MAX_LOCAL_CHROME_INSTANCES=${COUNT}"
  echo "SERVER_CHROME_ENDPOINTS=${joined}"
} >"${ENV_FILE}.next"
mv "${ENV_FILE}.next" "${ENV_FILE}"
rm -f "${tmp_env}"

profile_args=()
if (( COUNT > 4 )); then
  profile_args=(--profile scale-8)
fi

services=(sidecar-supervisor)
for i in $(seq 1 "$COUNT"); do
  services+=("chrome-server-${i}")
done

echo "Deploying ${COUNT} remote Chrome instance(s) + sidecar supervisor..."
(cd "${REPO_ROOT}" && "${COMPOSE[@]}" -f "${COMPOSE_FILE}" "${profile_args[@]}" up -d --build "${services[@]}")

public_host="${REMOTE_SIDECAR_PUBLIC_HOST:-$(curl -fsS ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')}"
echo
echo "Remote sidecar is up."
echo "  Workers poll: $(grep '^SIDECAR_SERVER=' "${ENV_FILE}" | cut -d= -f2-)"
echo "  noVNC (if firewall allows):"
for i in $(seq 1 "$COUNT"); do
  echo "    chrome-server-${i}: http://${public_host}:$((7900 + i))"
done
echo
echo "On Railway production, you do NOT need SERVER_CHROME_HOST on your Mac."
echo "Optional: set SERVER_CHROME_HOST=${public_host} on Railway only for operator noVNC links."
