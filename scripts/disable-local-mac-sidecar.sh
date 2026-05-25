#!/usr/bin/env bash
set -euo pipefail

LABEL="com.vrbosidecar.worker"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

echo "Stopping Mac local sidecar (LaunchAgent + stray processes)..."

if [[ -f "${PLIST_PATH}" ]]; then
  launchctl bootout "gui/${UID}" "${PLIST_PATH}" >/dev/null 2>&1 || true
  echo "  Unloaded ${LABEL}"
fi

pkill -f "com.vrbosidecar.worker" >/dev/null 2>&1 || true
pkill -f "\\.vrbo-sidecar-daemon.*supervisor\\.mjs" >/dev/null 2>&1 || true
pkill -f "daemon/vrbo-sidecar/worker\\.mjs" >/dev/null 2>&1 || true
pkill -f "run-vrbo-sidecar\\.sh" >/dev/null 2>&1 || true

echo "Done. Production sidecar should run on Railway (rct-sidecar-worker) or a VPS — see docs/remote-sidecar-setup.md"
