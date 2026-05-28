#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Remote sidecar setup ==="
echo

if [[ "$(uname -s)" == "Darwin" ]]; then
  bash "${SCRIPT_DIR}/disable-local-mac-sidecar.sh"
  echo
fi

cat <<'EOF'
Next: run workers on Railway (recommended)

  1. In Railway, add a second service from this repo (e.g. rct-sidecar-worker).
  2. Set RAILWAY_SERVICE_ROLE=sidecar-worker
  3. Set SIDECAR_SERVER to your main app URL (https://...up.railway.app)
  4. Copy ADMIN_SECRET and proxy/CapSolver vars from production.
  5. Deploy and confirm logs: "Starting Railway sidecar worker role..."

Full guide: docs/remote-sidecar-setup.md

Optional: VPS Docker pool with noVNC (eight Chrome containers)

  cp .env.remote-sidecar.example .env.remote-sidecar
  # edit ADMIN_SECRET, SIDECAR_SERVER, proxy keys
  ./scripts/deploy-remote-sidecar-docker.sh 8

EOF

if command -v railway >/dev/null 2>&1; then
  echo "Railway CLI detected. Linked project:"
  (cd "${REPO_ROOT}" && railway status 2>/dev/null | head -5) || true
  echo
  echo "Duplicate the web service in the Railway dashboard, set RAILWAY_SERVICE_ROLE=sidecar-worker, then deploy."
fi
