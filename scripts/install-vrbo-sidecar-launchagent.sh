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

quote_for_shell() {
  printf "%q" "$1"
}

RAILWAY_VARS_KV=""
load_railway_vars() {
  if [[ -n "${RAILWAY_VARS_KV}" || "${RAILWAY_VARS_LOADED:-0}" == "1" ]]; then
    return
  fi
  RAILWAY_VARS_LOADED="1"
  if command -v railway >/dev/null 2>&1; then
    RAILWAY_VARS_KV="$(railway variable list --kv 2>/dev/null || true)"
  fi
}

railway_var() {
  local key="$1"
  load_railway_vars
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' <<<"${RAILWAY_VARS_KV}"
}

value_from_env_or_railway() {
  local key="$1"
  local fallback="${2:-}"
  local current="${!key:-}"
  if [[ -n "${current}" ]]; then
    printf '%s' "${current}"
    return
  fi
  local from_railway
  from_railway="$(railway_var "${key}")"
  if [[ -n "${from_railway}" ]]; then
    printf '%s' "${from_railway}"
    return
  fi
  printf '%s' "${fallback}"
}

SERVER_URL="${SIDECAR_SERVER:-https://rental-community-tracker-production.up.railway.app}"
MAX_LOCAL_CHROME_INSTANCES="${MAX_LOCAL_CHROME_INSTANCES:-8}"
# Prefer Grok's recommended architecture: remote headed Chrome/noVNC
# with sticky residential proxy. Local headless remains the no-window
# fallback if the server Chrome pool is unavailable.
SIDECAR_BROWSER_MODE="${SIDECAR_BROWSER_MODE:-server}"
SIDECAR_HEADLESS_BROWSER_CHANNEL="${SIDECAR_HEADLESS_BROWSER_CHANNEL:-chrome}"
CHROME_PRIMARY="${CHROME_PRIMARY:-server}"
# Keep server/noVNC Chrome as the preferred path, but do not fall through to
# isolated headless Chrome when the server pool or proxy is unavailable. OTA
# search pages, especially Booking.com and VRBO, reject the headless fallback
# far more often than a real local Chrome profile.
SIDECAR_DISABLE_LOCAL_CDP_FALLBACK="${SIDECAR_DISABLE_LOCAL_CDP_FALLBACK:-1}"
SIDECAR_HEADLESS_FALLBACK_ENABLED="${SIDECAR_HEADLESS_FALLBACK_ENABLED:-0}"
# Default the local fallback to visible real Chrome. Server/noVNC is still the
# primary path, but when OTA providers block the server/proxy path the operator
# needs a reachable browser window for CAPTCHA recovery instead of an offscreen
# or headless session that cannot be rescued.
SIDECAR_CHROME_VISIBLE="${SIDECAR_CHROME_VISIBLE:-1}"
SIDECAR_CHROME_VISIBLE_GRID_ORIGIN="${SIDECAR_CHROME_VISIBLE_GRID_ORIGIN:-1440,60}"
SIDECAR_CHROME_VISIBLE_SIZE="${SIDECAR_CHROME_VISIBLE_SIZE:-500,375}"
SIDECAR_CHROME_VISIBLE_GRID_COLUMNS="${SIDECAR_CHROME_VISIBLE_GRID_COLUMNS:-4}"
SIDECAR_CHROME_VISIBLE_GRID_GAP_X="${SIDECAR_CHROME_VISIBLE_GRID_GAP_X:-0}"
SIDECAR_CHROME_VISIBLE_GRID_GAP_Y="${SIDECAR_CHROME_VISIBLE_GRID_GAP_Y:-35}"
SIDECAR_CHROME_VISIBLE_POSITIONS="${SIDECAR_CHROME_VISIBLE_POSITIONS:-1440,60;1820,60;2200,60;2580,60;1440,470;1820,470;2200,470;2580,470}"
SIDECAR_WARM_ALL_LOCAL_CHROME="${SIDECAR_WARM_ALL_LOCAL_CHROME:-0}"
SIDECAR_ALLOW_FOCUS="${SIDECAR_ALLOW_FOCUS:-1}"
SIDECAR_CAPTCHA_SURFACE_WINDOW="${SIDECAR_CAPTCHA_SURFACE_WINDOW:-1}"
SIDECAR_CAPTCHA_ALLOW_FOCUS="${SIDECAR_CAPTCHA_ALLOW_FOCUS:-1}"
SIDECAR_MACOS_BACKGROUND_LAUNCH="${SIDECAR_MACOS_BACKGROUND_LAUNCH:-0}"
SERVER_CHROME_FALLBACK_ENABLED="${SERVER_CHROME_FALLBACK_ENABLED:-1}"
SERVER_CHROME_FALLBACK_VRBO="${SERVER_CHROME_FALLBACK_VRBO:-1}"
SIDECAR_OPEN_NOVNC_ON_ACQUIRE="${SIDECAR_OPEN_NOVNC_ON_ACQUIRE:-0}"
SERVER_CHROME_HOST="$(value_from_env_or_railway SERVER_CHROME_HOST "")"
SERVER_CHROME_SCHEME="$(value_from_env_or_railway SERVER_CHROME_SCHEME "http")"
SERVER_CHROME_BASE_PORT="$(value_from_env_or_railway SERVER_CHROME_BASE_PORT "9223")"
SERVER_CHROME_BASE_WEBDRIVER_PORT="$(value_from_env_or_railway SERVER_CHROME_BASE_WEBDRIVER_PORT "4445")"
SERVER_CHROME_BASE_NOVNC_PORT="$(value_from_env_or_railway SERVER_CHROME_BASE_NOVNC_PORT "7901")"
MAX_SERVER_INSTANCES="$(value_from_env_or_railway MAX_SERVER_INSTANCES "4")"
CHROME_PROXY_ENABLED="$(value_from_env_or_railway CHROME_PROXY_ENABLED "1")"
CHROME_PROXY_PROVIDER="$(value_from_env_or_railway CHROME_PROXY_PROVIDER "brightdata")"
CHROME_PROXY_SCHEME="$(value_from_env_or_railway CHROME_PROXY_SCHEME "http")"
CHROME_PROXY_COUNTRY="$(value_from_env_or_railway CHROME_PROXY_COUNTRY "us")"
CHROME_PROXY_STICKY_SESSION_MINUTES="$(value_from_env_or_railway CHROME_PROXY_STICKY_SESSION_MINUTES "60")"
BRIGHTDATA_PROXY_HOST="$(value_from_env_or_railway BRIGHTDATA_PROXY_HOST "brd.superproxy.io")"
BRIGHTDATA_PROXY_PORT="$(value_from_env_or_railway BRIGHTDATA_PROXY_PORT "33335")"
BRIGHTDATA_PROXY_USERNAME="$(value_from_env_or_railway BRIGHTDATA_PROXY_USERNAME "")"
BRIGHTDATA_PROXY_PASSWORD="$(value_from_env_or_railway BRIGHTDATA_PROXY_PASSWORD "")"
ADMIN_SECRET_VALUE="${SIDECAR_ADMIN_SECRET:-${ADMIN_SECRET:-}}"
if [[ -z "${ADMIN_SECRET_VALUE}" ]] && command -v railway >/dev/null 2>&1; then
  # The 2Captcha key intentionally stays on Railway. The local sidecar still
  # needs ADMIN_SECRET so Railway's auth middleware lets it call the solver
  # endpoint. Pull it from the linked Railway service when available, but never
  # print the value.
  ADMIN_SECRET_VALUE="$(railway_var ADMIN_SECRET)"
  if [[ -n "${ADMIN_SECRET_VALUE}" ]]; then
    echo "Loaded ADMIN_SECRET from Railway variables for local sidecar auth."
  fi
fi
EXISTING_RUNNER_PATH="${INSTALL_DIR}/run-vrbo-sidecar.sh"
if [[ -z "${ADMIN_SECRET_VALUE}" && -f "${EXISTING_RUNNER_PATH}" ]]; then
  EXISTING_ADMIN_SECRET_RAW="$(
    awk -F= '$1 == "export ADMIN_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "${EXISTING_RUNNER_PATH}" \
      || true
  )"
  if [[ -n "${EXISTING_ADMIN_SECRET_RAW}" && "${EXISTING_ADMIN_SECRET_RAW}" != "''" ]]; then
    ADMIN_SECRET_VALUE="$(/bin/bash -lc "v=${EXISTING_ADMIN_SECRET_RAW}; printf '%s' \"\$v\"" 2>/dev/null || true)"
    if [[ -n "${ADMIN_SECRET_VALUE}" ]]; then
      echo "Preserved ADMIN_SECRET from existing sidecar runner."
    fi
  fi
fi
ADMIN_SECRET_EXPORT="$(quote_for_shell "${ADMIN_SECRET_VALUE}")"
SERVER_CHROME_HOST_EXPORT="$(quote_for_shell "${SERVER_CHROME_HOST}")"
BRIGHTDATA_PROXY_USERNAME_EXPORT="$(quote_for_shell "${BRIGHTDATA_PROXY_USERNAME}")"
BRIGHTDATA_PROXY_PASSWORD_EXPORT="$(quote_for_shell "${BRIGHTDATA_PROXY_PASSWORD}")"
SIDECAR_VRBO_2CAPTCHA="${SIDECAR_VRBO_2CAPTCHA:-1}"
SIDECAR_VRBO_2CAPTCHA_POLL_SECONDS="${SIDECAR_VRBO_2CAPTCHA_POLL_SECONDS:-120}"
SIDECAR_VRBO_2CAPTCHA_MAX_ATTEMPTS="${SIDECAR_VRBO_2CAPTCHA_MAX_ATTEMPTS:-2}"

RUNNER_PATH="${INSTALL_DIR}/run-vrbo-sidecar.sh"
cat >"${RUNNER_PATH}" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
cd "${INSTALL_DIR}"
export SIDECAR_SERVER="${SERVER_URL}"
export ADMIN_SECRET=${ADMIN_SECRET_EXPORT}
export MAX_LOCAL_CHROME_INSTANCES="${MAX_LOCAL_CHROME_INSTANCES}"
export SIDECAR_BROWSER_MODE="${SIDECAR_BROWSER_MODE}"
export SIDECAR_HEADLESS_BROWSER_CHANNEL="${SIDECAR_HEADLESS_BROWSER_CHANNEL}"
export CHROME_PRIMARY="${CHROME_PRIMARY}"
export SIDECAR_DISABLE_LOCAL_CDP_FALLBACK="${SIDECAR_DISABLE_LOCAL_CDP_FALLBACK}"
export SIDECAR_HEADLESS_FALLBACK_ENABLED="${SIDECAR_HEADLESS_FALLBACK_ENABLED}"
export SIDECAR_CHROME_VISIBLE="${SIDECAR_CHROME_VISIBLE}"
export SIDECAR_CHROME_VISIBLE_SIZE="${SIDECAR_CHROME_VISIBLE_SIZE}"
export SIDECAR_CHROME_VISIBLE_POSITIONS="${SIDECAR_CHROME_VISIBLE_POSITIONS}"
export SIDECAR_CHROME_VISIBLE_GRID_ORIGIN="${SIDECAR_CHROME_VISIBLE_GRID_ORIGIN}"
export SIDECAR_CHROME_VISIBLE_GRID_COLUMNS="${SIDECAR_CHROME_VISIBLE_GRID_COLUMNS}"
export SIDECAR_CHROME_VISIBLE_GRID_GAP_X="${SIDECAR_CHROME_VISIBLE_GRID_GAP_X}"
export SIDECAR_CHROME_VISIBLE_GRID_GAP_Y="${SIDECAR_CHROME_VISIBLE_GRID_GAP_Y}"
export SIDECAR_WARM_ALL_LOCAL_CHROME="${SIDECAR_WARM_ALL_LOCAL_CHROME}"
export SIDECAR_ALLOW_FOCUS="${SIDECAR_ALLOW_FOCUS}"
export SIDECAR_CAPTCHA_SURFACE_WINDOW="${SIDECAR_CAPTCHA_SURFACE_WINDOW}"
export SIDECAR_CAPTCHA_ALLOW_FOCUS="${SIDECAR_CAPTCHA_ALLOW_FOCUS}"
export SIDECAR_MACOS_BACKGROUND_LAUNCH="${SIDECAR_MACOS_BACKGROUND_LAUNCH}"
export SERVER_CHROME_FALLBACK_ENABLED="${SERVER_CHROME_FALLBACK_ENABLED}"
export SERVER_CHROME_FALLBACK_VRBO="${SERVER_CHROME_FALLBACK_VRBO}"
export SIDECAR_OPEN_NOVNC_ON_ACQUIRE="${SIDECAR_OPEN_NOVNC_ON_ACQUIRE}"
export SERVER_CHROME_HOST=${SERVER_CHROME_HOST_EXPORT}
export SERVER_CHROME_SCHEME="${SERVER_CHROME_SCHEME}"
export SERVER_CHROME_BASE_PORT="${SERVER_CHROME_BASE_PORT}"
export SERVER_CHROME_BASE_WEBDRIVER_PORT="${SERVER_CHROME_BASE_WEBDRIVER_PORT}"
export SERVER_CHROME_BASE_NOVNC_PORT="${SERVER_CHROME_BASE_NOVNC_PORT}"
export MAX_SERVER_INSTANCES="${MAX_SERVER_INSTANCES}"
export CHROME_PROXY_ENABLED="${CHROME_PROXY_ENABLED}"
export CHROME_PROXY_PROVIDER="${CHROME_PROXY_PROVIDER}"
export CHROME_PROXY_SCHEME="${CHROME_PROXY_SCHEME}"
export CHROME_PROXY_COUNTRY="${CHROME_PROXY_COUNTRY}"
export CHROME_PROXY_STICKY_SESSION_MINUTES="${CHROME_PROXY_STICKY_SESSION_MINUTES}"
export BRIGHTDATA_PROXY_HOST="${BRIGHTDATA_PROXY_HOST}"
export BRIGHTDATA_PROXY_PORT="${BRIGHTDATA_PROXY_PORT}"
export BRIGHTDATA_PROXY_USERNAME=${BRIGHTDATA_PROXY_USERNAME_EXPORT}
export BRIGHTDATA_PROXY_PASSWORD=${BRIGHTDATA_PROXY_PASSWORD_EXPORT}
export SIDECAR_VRBO_2CAPTCHA="${SIDECAR_VRBO_2CAPTCHA}"
export SIDECAR_VRBO_2CAPTCHA_POLL_SECONDS="${SIDECAR_VRBO_2CAPTCHA_POLL_SECONDS}"
export SIDECAR_VRBO_2CAPTCHA_MAX_ATTEMPTS="${SIDECAR_VRBO_2CAPTCHA_MAX_ATTEMPTS}"
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
