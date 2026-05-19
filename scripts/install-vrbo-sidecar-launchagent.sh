#!/usr/bin/env bash
set -euo pipefail

# Install the local Chrome sidecar as a macOS LaunchAgent.
#
# This copies the repo's canonical sidecar files into
# ~/.vrbo-sidecar-daemon, writes ~/Library/LaunchAgents/com.vrbosidecar.worker.plist,
# and kickstarts it. launchd then starts it at login and restarts it if it exits.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/daemon/vrbo-sidecar"
INSTALL_DIR="${SIDECAR_INSTALL_DIR:-${HOME}/.vrbo-sidecar-daemon}"
LAUNCH_AGENT_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENT_DIR}/com.vrbosidecar.worker.plist"
LABEL="com.vrbosidecar.worker"

if [[ ! -f "${SOURCE_DIR}/supervisor.mjs" || ! -f "${SOURCE_DIR}/worker.mjs" ]]; then
  echo "Could not find sidecar source files in ${SOURCE_DIR}" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-}"
if [[ -z "${NODE_BIN}" ]]; then
  if [[ -x "/opt/homebrew/bin/node" ]]; then
    NODE_BIN="/opt/homebrew/bin/node"
  else
    NODE_BIN="$(command -v node || true)"
  fi
fi
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "Node.js is required. Set NODE_BIN=/path/to/node if it is not on PATH." >&2
  exit 1
fi

mkdir -p "${INSTALL_DIR}" "${LAUNCH_AGENT_DIR}"
cp "${SOURCE_DIR}/supervisor.mjs" "${INSTALL_DIR}/supervisor.mjs"
cp "${SOURCE_DIR}/worker.mjs" "${INSTALL_DIR}/worker.mjs"
cp "${SOURCE_DIR}/chrome-sidecar-manager.mjs" "${INSTALL_DIR}/chrome-sidecar-manager.mjs"
cp "${SOURCE_DIR}/README.md" "${INSTALL_DIR}/README.md"
cp "${REPO_ROOT}/package.json" "${INSTALL_DIR}/package.json"
if [[ -d "${REPO_ROOT}/node_modules" ]]; then
  ln -sfn "${REPO_ROOT}/node_modules" "${INSTALL_DIR}/node_modules"
else
  echo "Warning: ${REPO_ROOT}/node_modules does not exist; run npm install in the repo if the sidecar cannot resolve dependencies." >&2
fi
LEGACY_COOKIES_FILE="${HOME}/Downloads/vrbo-sidecar/cookies.json"
if [[ ! -f "${INSTALL_DIR}/cookies.json" && -f "${LEGACY_COOKIES_FILE}" ]]; then
  cp "${LEGACY_COOKIES_FILE}" "${INSTALL_DIR}/cookies.json"
  chmod 600 "${INSTALL_DIR}/cookies.json"
  echo "Migrated sidecar cookies from ${LEGACY_COOKIES_FILE}"
fi

SERVER_URL="${SIDECAR_SERVER:-https://rental-community-tracker-production.up.railway.app}"
MAX_LOCAL_CHROME_INSTANCES="${MAX_LOCAL_CHROME_INSTANCES:-8}"
SIDECAR_CHROME_VISIBLE="${SIDECAR_CHROME_VISIBLE:-1}"
SIDECAR_CHROME_VISIBLE_GRID_ORIGIN="${SIDECAR_CHROME_VISIBLE_GRID_ORIGIN:-1600,60}"
SIDECAR_CHROME_VISIBLE_GRID_COLUMNS="${SIDECAR_CHROME_VISIBLE_GRID_COLUMNS:-2}"
SIDECAR_CHROME_VISIBLE_GRID_GAP_X="${SIDECAR_CHROME_VISIBLE_GRID_GAP_X:-24}"
SIDECAR_CHROME_VISIBLE_GRID_GAP_Y="${SIDECAR_CHROME_VISIBLE_GRID_GAP_Y:-36}"
SIDECAR_ALLOW_FOCUS="${SIDECAR_ALLOW_FOCUS:-0}"
SIDECAR_CAPTCHA_SURFACE_WINDOW="${SIDECAR_CAPTCHA_SURFACE_WINDOW:-1}"
SIDECAR_CAPTCHA_ALLOW_FOCUS="${SIDECAR_CAPTCHA_ALLOW_FOCUS:-1}"
SIDECAR_MACOS_BACKGROUND_LAUNCH="${SIDECAR_MACOS_BACKGROUND_LAUNCH:-1}"
SERVER_CHROME_FALLBACK_ENABLED="${SERVER_CHROME_FALLBACK_ENABLED:-0}"

RUNNER_PATH="${INSTALL_DIR}/run-vrbo-sidecar.sh"
cat >"${RUNNER_PATH}" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
cd "${INSTALL_DIR}"
export SIDECAR_SERVER="${SERVER_URL}"
export MAX_LOCAL_CHROME_INSTANCES="${MAX_LOCAL_CHROME_INSTANCES}"
export SIDECAR_CHROME_VISIBLE="${SIDECAR_CHROME_VISIBLE}"
export SIDECAR_CHROME_VISIBLE_GRID_ORIGIN="${SIDECAR_CHROME_VISIBLE_GRID_ORIGIN}"
export SIDECAR_CHROME_VISIBLE_GRID_COLUMNS="${SIDECAR_CHROME_VISIBLE_GRID_COLUMNS}"
export SIDECAR_CHROME_VISIBLE_GRID_GAP_X="${SIDECAR_CHROME_VISIBLE_GRID_GAP_X}"
export SIDECAR_CHROME_VISIBLE_GRID_GAP_Y="${SIDECAR_CHROME_VISIBLE_GRID_GAP_Y}"
export SIDECAR_ALLOW_FOCUS="${SIDECAR_ALLOW_FOCUS}"
export SIDECAR_CAPTCHA_SURFACE_WINDOW="${SIDECAR_CAPTCHA_SURFACE_WINDOW}"
export SIDECAR_CAPTCHA_ALLOW_FOCUS="${SIDECAR_CAPTCHA_ALLOW_FOCUS}"
export SIDECAR_MACOS_BACKGROUND_LAUNCH="${SIDECAR_MACOS_BACKGROUND_LAUNCH}"
export SERVER_CHROME_FALLBACK_ENABLED="${SERVER_CHROME_FALLBACK_ENABLED}"
echo "[\$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [vrbo-sidecar-launchagent] starting supervisor via ${NODE_BIN}"
exec "${NODE_BIN}" "${INSTALL_DIR}/supervisor.mjs"
RUNNER
chmod 755 "${RUNNER_PATH}"

cat >"${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${RUNNER_PATH}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>20</integer>
  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/sidecar-launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/sidecar-launchd.err.log</string>
</dict>
</plist>
PLIST

# LaunchAgent plists should be readable by launchd. Keep it non-writable
# by group/other, but do not lock it down to 600 or launchd can surface
# an opaque EX_CONFIG on some macOS versions.
chmod 644 "${PLIST_PATH}"

echo "Stopping any existing ${LABEL} LaunchAgent..."
launchctl bootout "gui/${UID}" "${PLIST_PATH}" >/dev/null 2>&1 || true

echo "Stopping manual sidecar supervisors, if any..."
while IFS= read -r pid; do
  [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
  kill "${pid}" >/dev/null 2>&1 || true
done < <(pgrep -f "((node|bash).*(daemon/vrbo-sidecar|Downloads/vrbo-sidecar|\\.vrbo-sidecar-daemon).*supervisor\\.mjs)|((node|bash).*run-vrbo-sidecar\\.sh)" || true)
while IFS= read -r pid; do
  [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
  kill "${pid}" >/dev/null 2>&1 || true
done < <(pgrep -f "(daemon/vrbo-sidecar|Downloads/vrbo-sidecar|\\.vrbo-sidecar-daemon)/worker\\.mjs" || true)
echo "Stopping dedicated sidecar Chrome windows, if any..."
while IFS= read -r pid; do
  [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
  kill "${pid}" >/dev/null 2>&1 || true
done < <(pgrep -f "VrboSidecar-Chrome" || true)
sleep 1

: >"${INSTALL_DIR}/sidecar-launchd.log"
: >"${INSTALL_DIR}/sidecar-launchd.err.log"

echo "Loading ${LABEL} LaunchAgent..."
launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
launchctl kickstart -k "gui/${UID}/${LABEL}"

echo
echo "Installed and started ${LABEL}"
echo "  Source: ${SOURCE_DIR}"
echo "  Install dir: ${INSTALL_DIR}"
echo "  Plist: ${PLIST_PATH}"
echo "  Log: ${INSTALL_DIR}/sidecar-launchd.log"
echo
launchctl print "gui/${UID}/${LABEL}" | sed -n '1,40p'
echo
echo "Recent sidecar log:"
tail -n 30 "${INSTALL_DIR}/sidecar-launchd.log" 2>/dev/null || true
tail -n 20 "${INSTALL_DIR}/sidecar-launchd.err.log" 2>/dev/null || true
