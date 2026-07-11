#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/deploy_pi.sh [options]

Options:
  --host <host>          Override the target Pi hostname or address.
  --alias <name>         Use a named host alias (wren, host, pt5).
  --path <path>          Override the remote deploy path.
  --user <user>          Override the SSH user.
  --local-path <path>    Override the local repo path to sync.
  --role host|peer       Restart and verify the matching service. Default: host
  --config <path>        Remote config path for smoke testing.
  --base-url <url>       Public/local URL for host smoke testing.
  --dry-run              Show what would happen without modifying the remote host.
  --sync-only            Sync files only. Skip npm install, restart, and smoke test.
  --restart              Force a restart after sync.
  --force-restart        Kill/reset/start the service instead of normal restart.
  --restart-timeout <s>  Seconds to wait for service/route readiness. Default: 30
  --install-deps         Run npm install --omit=dev after sync.
  --no-install-deps      Skip npm install.
  --smoke                Run the hardware smoke test after restart.
  --no-smoke             Skip the hardware smoke test.
  --verify-route <path>  Verify an extra host HTTP route after restart.
  --no-verify-routes     Skip host HTTP route checks.
  --no-sudo-preflight    Skip the non-interactive sudo preflight check.
  --verbose-rsync        Show file-level rsync progress.
  --help                 Show this help text.

Environment overrides still work: PI_HOST, PI_USER, PI_PATH, LOCAL_PATH,
SHADOWSCORE_ROLE, SHADOWSCORE_CONFIG, SHADOWSCORE_BASE_URL,
INSTALL_REQUIREMENTS, RESTART_SERVICE, RUN_SMOKE, RESTART_TIMEOUT,
RUN_ROUTE_VERIFY, FORCE_RESTART, SUDO_PREFLIGHT, VERBOSE_RSYNC, and
SHADOWSCORE_SUDO_PASSWORD.
EOF
}

require_value() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "Missing value for option '$1'." >&2
    usage >&2
    exit 1
  fi
}

resolve_host_alias() {
  local alias_name="$1"
  local alias_upper
  alias_upper="$(printf '%s' "${alias_name}" | tr '[:lower:]' '[:upper:]')"
  local override_var="PI_HOST_ALIAS_${alias_upper}"
  local override_value="${!override_var:-}"

  if [[ -n "${override_value}" ]]; then
    printf '%s\n' "${override_value}"
    return
  fi

  case "${alias_name}" in
    wren)
      printf '%s\n' "wren.local"
      ;;
    host|pt5)
      printf '%s\n' "pt5.local"
      ;;
    *)
      echo "Unknown host alias '$1'. Known aliases: wren, host, pt5." >&2
      exit 1
      ;;
  esac
}

resolve_host_address() {
  local host="$1"
  local resolved=""

  if [[ "${host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    printf '%s\n' "${host}"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    resolved="$(
      python3 -c 'import socket, sys
host = sys.argv[1]
try:
    print(socket.gethostbyname(host))
except OSError:
    pass' "${host}"
    )"
  fi

  if [[ -n "${resolved}" ]]; then
    printf '%s\n' "${resolved}"
    return
  fi

  printf '%s\n' "${host}"
}

quote() {
  printf '%q' "$1"
}

remote_sh() {
  ssh "${PI_USER}@${RESOLVED_PI_HOST}" "$1"
}

remote_sudo_sh() {
  if [[ -n "${SHADOWSCORE_SUDO_PASSWORD:-}" ]]; then
    remote_sh "printf '%s\n' $(quote "${SHADOWSCORE_SUDO_PASSWORD}") | sudo -S -p '' $1"
  else
    remote_sh "sudo -n $1"
  fi
}

service_snapshot() {
  remote_sh \
    "systemctl show $(quote "${SERVICE_NAME}") --no-pager --property=MainPID --property=ActiveState --property=SubState --property=ActiveEnterTimestamp --property=ExecMainStartTimestamp" \
    || true
}

snapshot_value() {
  local snapshot="$1"
  local key="$2"
  awk -F= -v key="${key}" '$1 == key { print substr($0, index($0, "=") + 1); exit }' <<<"${snapshot}"
}

print_service_snapshot() {
  local label="$1"
  local snapshot="$2"

  echo "${label}:"
  echo "  ActiveState=$(snapshot_value "${snapshot}" ActiveState)"
  echo "  SubState=$(snapshot_value "${snapshot}" SubState)"
  echo "  MainPID=$(snapshot_value "${snapshot}" MainPID)"
  echo "  ActiveEnterTimestamp=$(snapshot_value "${snapshot}" ActiveEnterTimestamp)"
  echo "  ExecMainStartTimestamp=$(snapshot_value "${snapshot}" ExecMainStartTimestamp)"
}

wait_for_service_ready() {
  local deadline=$((SECONDS + RESTART_TIMEOUT))
  local snapshot=""
  local active_state=""
  local sub_state=""

  while (( SECONDS <= deadline )); do
    snapshot="$(service_snapshot)"
    active_state="$(snapshot_value "${snapshot}" ActiveState)"
    sub_state="$(snapshot_value "${snapshot}" SubState)"

    if [[ "${active_state}" == "active" && "${sub_state}" == "running" ]]; then
      SERVICE_AFTER_SNAPSHOT="${snapshot}"
      return 0
    fi

    sleep 2
  done

  SERVICE_AFTER_SNAPSHOT="${snapshot}"
  return 1
}

print_manual_restart_recovery() {
  echo "Manual recovery commands:" >&2
  echo "  ssh ${PI_USER}@${RESOLVED_PI_HOST}" >&2
  echo "  sudo systemctl kill -s SIGKILL ${SERVICE_NAME}" >&2
  echo "  sudo systemctl reset-failed ${SERVICE_NAME}" >&2
  echo "  sudo systemctl start ${SERVICE_NAME}" >&2
}

recover_service() {
  echo "Recovering ${SERVICE_NAME} with kill/reset-failed/start..."
  remote_sudo_sh "systemctl kill -s SIGKILL $(quote "${SERVICE_NAME}") || true"
  remote_sudo_sh "systemctl reset-failed $(quote "${SERVICE_NAME}")"
  remote_sudo_sh "systemctl start $(quote "${SERVICE_NAME}")"
}

restart_service_with_proof() {
  local before_snapshot="$1"
  local before_pid=""
  local before_started=""
  local after_pid=""
  local after_started=""

  before_pid="$(snapshot_value "${before_snapshot}" MainPID)"
  before_started="$(snapshot_value "${before_snapshot}" ExecMainStartTimestamp)"

  if [[ "${FORCE_RESTART}" == "1" ]]; then
    recover_service
  else
    echo "Restarting ${SERVICE_NAME}..."
    if ! remote_sudo_sh "systemctl restart $(quote "${SERVICE_NAME}")"; then
      echo "Normal restart failed; attempting recovery." >&2
      recover_service
    fi
  fi

  if ! wait_for_service_ready; then
    print_service_snapshot "Service state after restart attempt" "${SERVICE_AFTER_SNAPSHOT}"
    echo "${SERVICE_NAME} did not become active/running within ${RESTART_TIMEOUT}s." >&2
    if [[ "${FORCE_RESTART}" != "1" ]]; then
      recover_service
      if ! wait_for_service_ready; then
        print_service_snapshot "Service state after recovery" "${SERVICE_AFTER_SNAPSHOT}"
        print_manual_restart_recovery
        exit 1
      fi
    else
      print_manual_restart_recovery
      exit 1
    fi
  fi

  after_pid="$(snapshot_value "${SERVICE_AFTER_SNAPSHOT}" MainPID)"
  after_started="$(snapshot_value "${SERVICE_AFTER_SNAPSHOT}" ExecMainStartTimestamp)"
  print_service_snapshot "Service state after restart" "${SERVICE_AFTER_SNAPSHOT}"

  if [[ -n "${before_pid}" && "${before_pid}" != "0" && "${before_pid}" == "${after_pid}" && "${before_started}" == "${after_started}" ]]; then
    echo "Warning: ${SERVICE_NAME} reports the same MainPID and start timestamp after restart." >&2
  fi
}

print_local_provenance() {
  local git_commit=""
  local git_dirty=""
  local build_info="${LOCAL_PATH}public/matrix-edit/build-info.json"

  if command -v git >/dev/null 2>&1 && git -C "${LOCAL_PATH}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_commit="$(git -C "${LOCAL_PATH}" rev-parse --short HEAD 2>/dev/null || true)"
    git_dirty="$(git -C "${LOCAL_PATH}" status --short 2>/dev/null || true)"
    echo "Local git commit: ${git_commit:-unknown}"
    if [[ -n "${git_dirty}" ]]; then
      echo "Local git dirty: yes"
    else
      echo "Local git dirty: no"
    fi
  fi

  if [[ -f "${build_info}" ]] && command -v node >/dev/null 2>&1; then
    node -e '
const fs = require("fs");
const path = process.argv[1];
const info = JSON.parse(fs.readFileSync(path, "utf8"));
if (info.matrixeditCommit || Object.prototype.hasOwnProperty.call(info, "matrixeditDirty")) {
  console.log(`Matrix Edit bundle: commit=${info.matrixeditCommit || "unknown"} dirty=${info.matrixeditDirty}`);
}
' "${build_info}" || true
  fi
}

verify_url_with_retry() {
  local url="$1"
  local deadline=$((SECONDS + RESTART_TIMEOUT))

  while (( SECONDS <= deadline )); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "Route verification failed: ${url}" >&2
  return 1
}

PI_HOST="${PI_HOST:-wren.local}"
PI_USER="${PI_USER:-pi}"
PI_PATH="${PI_PATH:-/home/pi/ShadowscoreServer}"
LOCAL_PATH="${LOCAL_PATH:-$(pwd)}"
SHADOWSCORE_ROLE="${SHADOWSCORE_ROLE:-host}"
SHADOWSCORE_CONFIG="${SHADOWSCORE_CONFIG:-}"
SHADOWSCORE_BASE_URL="${SHADOWSCORE_BASE_URL:-}"
INSTALL_REQUIREMENTS="${INSTALL_REQUIREMENTS:-1}"
RESTART_SERVICE="${RESTART_SERVICE:-1}"
RUN_SMOKE="${RUN_SMOKE:-1}"
RESTART_TIMEOUT="${RESTART_TIMEOUT:-30}"
RUN_ROUTE_VERIFY="${RUN_ROUTE_VERIFY:-1}"
FORCE_RESTART="${FORCE_RESTART:-0}"
SUDO_PREFLIGHT="${SUDO_PREFLIGHT:-1}"
VERBOSE_RSYNC="${VERBOSE_RSYNC:-0}"
DRY_RUN=0
HOST_ALIAS=""
VERIFY_ROUTES=()
SERVICE_AFTER_SNAPSHOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      require_value "$@"
      PI_HOST="$2"
      shift 2
      ;;
    --alias)
      require_value "$@"
      HOST_ALIAS="$2"
      shift 2
      ;;
    --path)
      require_value "$@"
      PI_PATH="$2"
      shift 2
      ;;
    --user)
      require_value "$@"
      PI_USER="$2"
      shift 2
      ;;
    --local-path)
      require_value "$@"
      LOCAL_PATH="$2"
      shift 2
      ;;
    --role)
      require_value "$@"
      SHADOWSCORE_ROLE="$2"
      shift 2
      ;;
    --config)
      require_value "$@"
      SHADOWSCORE_CONFIG="$2"
      shift 2
      ;;
    --base-url)
      require_value "$@"
      SHADOWSCORE_BASE_URL="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --sync-only)
      INSTALL_REQUIREMENTS=0
      RESTART_SERVICE=0
      RUN_SMOKE=0
      shift
      ;;
    --restart)
      RESTART_SERVICE=1
      shift
      ;;
    --force-restart)
      FORCE_RESTART=1
      RESTART_SERVICE=1
      shift
      ;;
    --restart-timeout)
      require_value "$@"
      RESTART_TIMEOUT="$2"
      shift 2
      ;;
    --install-deps)
      INSTALL_REQUIREMENTS=1
      shift
      ;;
    --no-install-deps)
      INSTALL_REQUIREMENTS=0
      shift
      ;;
    --smoke)
      RUN_SMOKE=1
      shift
      ;;
    --no-smoke)
      RUN_SMOKE=0
      shift
      ;;
    --verify-route)
      require_value "$@"
      VERIFY_ROUTES+=("$2")
      shift 2
      ;;
    --no-verify-routes)
      RUN_ROUTE_VERIFY=0
      shift
      ;;
    --no-sudo-preflight)
      SUDO_PREFLIGHT=0
      shift
      ;;
    --verbose-rsync)
      VERBOSE_RSYNC=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${SHADOWSCORE_ROLE}" != "host" && "${SHADOWSCORE_ROLE}" != "peer" ]]; then
  echo "--role must be host or peer." >&2
  exit 1
fi

if ! [[ "${RESTART_TIMEOUT}" =~ ^[0-9]+$ ]] || [[ "${RESTART_TIMEOUT}" -lt 1 ]]; then
  echo "--restart-timeout must be a positive integer." >&2
  exit 1
fi

if [[ -n "${HOST_ALIAS}" ]]; then
  PI_HOST="$(resolve_host_alias "${HOST_ALIAS}")"
fi

RESOLVED_PI_HOST="$(resolve_host_address "${PI_HOST}")"

if [[ "${LOCAL_PATH}" != */ ]]; then
  LOCAL_PATH="${LOCAL_PATH}/"
fi

if [[ ! -d "${LOCAL_PATH}" ]]; then
  echo "Local path '${LOCAL_PATH}' does not exist." >&2
  exit 1
fi

if [[ ! -f "${LOCAL_PATH}package.json" || ! -d "${LOCAL_PATH}src" ]]; then
  echo "Local path '${LOCAL_PATH}' does not look like ShadowscoreServer." >&2
  exit 1
fi

if [[ -z "${SHADOWSCORE_CONFIG}" ]]; then
  if [[ "${SHADOWSCORE_ROLE}" == "host" ]]; then
    SHADOWSCORE_CONFIG="config/shadowscore.host.local.json"
  else
    SHADOWSCORE_CONFIG="config/shadowscore.peer.local.json"
  fi
fi

if [[ -z "${SHADOWSCORE_BASE_URL}" && "${SHADOWSCORE_ROLE}" == "host" ]]; then
  SHADOWSCORE_BASE_URL="http://${RESOLVED_PI_HOST}:8790"
fi

if [[ "${SHADOWSCORE_ROLE}" == "host" ]]; then
  if [[ "${#VERIFY_ROUTES[@]}" -gt 0 ]]; then
    VERIFY_ROUTES=(/healthz /session /matrix-edit /piano-roll /event-list "${VERIFY_ROUTES[@]}")
  else
    VERIFY_ROUTES=(/healthz /session /matrix-edit /piano-roll /event-list)
  fi
fi

SERVICE_NAME="shadowscore-server.service"
if [[ "${SHADOWSCORE_ROLE}" == "peer" ]]; then
  SERVICE_NAME="shadowscore-registration-agent.service"
fi

echo "Deploying ShadowscoreServer to ${PI_USER}@${RESOLVED_PI_HOST}:${PI_PATH}"
if [[ -n "${HOST_ALIAS}" ]]; then
  echo "Resolved host alias '${HOST_ALIAS}' to '${PI_HOST}'"
fi
if [[ "${RESOLVED_PI_HOST}" != "${PI_HOST}" ]]; then
  echo "Resolved '${PI_HOST}' to IP '${RESOLVED_PI_HOST}'"
fi
echo "Role: ${SHADOWSCORE_ROLE}"
echo "Service: ${SERVICE_NAME}"
echo "Restart timeout: ${RESTART_TIMEOUT}s"
echo "Smoke config: ${SHADOWSCORE_CONFIG}"
if [[ "${SHADOWSCORE_ROLE}" == "host" ]]; then
  echo "Smoke base URL: ${SHADOWSCORE_BASE_URL}"
  if [[ "${RUN_ROUTE_VERIFY}" == "1" ]]; then
    echo "Verify routes: ${VERIFY_ROUTES[*]}"
  else
    echo "Verify routes: disabled"
  fi
fi
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "Dry run enabled: remote state will not be modified."
  echo "Dry run still connects to the target host so rsync can compare file trees."
fi

if [[ "${RESOLVED_PI_HOST}" == "${PI_HOST}" && "${PI_HOST}" != "localhost" && ! "${PI_HOST}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  if [[ -n "${HOST_ALIAS}" ]]; then
    HOST_ALIAS_UPPER="$(printf '%s' "${HOST_ALIAS}" | tr '[:lower:]' '[:upper:]')"
    echo "Could not resolve '${PI_HOST}' to an IP address." >&2
    echo "If mDNS is unavailable on this Mac, re-run with --host <ip> or set PI_HOST_ALIAS_${HOST_ALIAS_UPPER}=<ip>." >&2
    exit 1
  fi
fi

print_local_provenance

if [[ "${RESTART_SERVICE}" == "1" && "${SUDO_PREFLIGHT}" == "1" && "${DRY_RUN}" != "1" ]]; then
  echo "Checking non-interactive sudo on ${PI_USER}@${RESOLVED_PI_HOST}..."
  if ! remote_sudo_sh "true"; then
    echo "Non-interactive sudo is unavailable on ${PI_USER}@${RESOLVED_PI_HOST}." >&2
    print_manual_restart_recovery
    exit 1
  fi
fi

RSYNC_OPTS=(-a --delete --stats)
if [[ "${VERBOSE_RSYNC}" == "1" ]]; then
  RSYNC_OPTS=(-av --delete --progress)
fi
if [[ "${DRY_RUN}" == "1" ]]; then
  RSYNC_OPTS+=(--dry-run)
fi

if [[ "${DRY_RUN}" != "1" ]]; then
  remote_sh "mkdir -p $(quote "${PI_PATH}")"
else
  echo "Would create remote directory '${PI_PATH}'"
fi

rsync "${RSYNC_OPTS[@]}" \
  --exclude '.git' \
  --exclude '.agents' \
  --exclude '.codex' \
  --exclude 'node_modules' \
  --exclude 'data/***' \
  --exclude 'config/*.local.json' \
  --exclude '.DS_Store' \
  "${LOCAL_PATH}" \
  "${PI_USER}@${RESOLVED_PI_HOST}:${PI_PATH}/"

if [[ "${INSTALL_REQUIREMENTS}" == "1" ]]; then
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "Would run npm install --omit=dev in '${PI_PATH}'"
  else
    remote_sh "cd $(quote "${PI_PATH}") && npm install --omit=dev"
  fi
fi

if [[ "${RESTART_SERVICE}" == "1" ]]; then
  if [[ "${DRY_RUN}" == "1" ]]; then
    if [[ "${FORCE_RESTART}" == "1" ]]; then
      echo "Would force-restart '${SERVICE_NAME}' and verify active/running state"
    else
      echo "Would restart '${SERVICE_NAME}' and verify active/running state"
    fi
  else
    SERVICE_BEFORE_SNAPSHOT="$(service_snapshot)"
    print_service_snapshot "Service state before restart" "${SERVICE_BEFORE_SNAPSHOT}"
    restart_service_with_proof "${SERVICE_BEFORE_SNAPSHOT}"
  fi
else
  echo "Skipping service restart."
fi

if [[ "${SHADOWSCORE_ROLE}" == "host" && "${RUN_ROUTE_VERIFY}" == "1" ]]; then
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "Would verify live host routes at '${SHADOWSCORE_BASE_URL}': ${VERIFY_ROUTES[*]}"
  else
    echo "Verifying live host route shape at ${SHADOWSCORE_BASE_URL}"
    for route in "${VERIFY_ROUTES[@]}"; do
      verify_url_with_retry "${SHADOWSCORE_BASE_URL}${route}"
    done
    echo "Verified host routes: ${VERIFY_ROUTES[*]}"
  fi
elif [[ "${SHADOWSCORE_ROLE}" == "host" ]]; then
  echo "Skipping host route verification."
fi

if [[ "${RUN_SMOKE}" == "1" ]]; then
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "Would run hardware smoke test with '${SHADOWSCORE_CONFIG}'"
  else
    REMOTE_SMOKE_ARGS=(--config "${SHADOWSCORE_CONFIG}")
    if [[ "${SHADOWSCORE_ROLE}" == "host" ]]; then
      REMOTE_SMOKE_ARGS+=(--base-url "${SHADOWSCORE_BASE_URL}")
    fi
    quoted_smoke_args=""
    for arg in "${REMOTE_SMOKE_ARGS[@]}"; do
      quoted_smoke_args+=" $(quote "${arg}")"
    done
    remote_sh "cd $(quote "${PI_PATH}") && npm run smoke:hardware --${quoted_smoke_args}"
  fi
else
  echo "Skipping hardware smoke test."
fi
