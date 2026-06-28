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
  --install-deps         Run npm install --omit=dev after sync.
  --no-install-deps      Skip npm install.
  --smoke                Run the hardware smoke test after restart.
  --no-smoke             Skip the hardware smoke test.
  --help                 Show this help text.

Environment overrides still work: PI_HOST, PI_USER, PI_PATH, LOCAL_PATH,
SHADOWSCORE_ROLE, SHADOWSCORE_CONFIG, SHADOWSCORE_BASE_URL,
INSTALL_REQUIREMENTS, RESTART_SERVICE, and RUN_SMOKE.
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
DRY_RUN=0
HOST_ALIAS=""

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
  SHADOWSCORE_BASE_URL="http://${PI_HOST}:8790"
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
echo "Smoke config: ${SHADOWSCORE_CONFIG}"
if [[ "${SHADOWSCORE_ROLE}" == "host" ]]; then
  echo "Smoke base URL: ${SHADOWSCORE_BASE_URL}"
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

RSYNC_OPTS=(-av --delete --progress)
if [[ "${DRY_RUN}" == "1" ]]; then
  RSYNC_OPTS+=(--dry-run)
fi

if [[ "${DRY_RUN}" != "1" ]]; then
  ssh "${PI_USER}@${RESOLVED_PI_HOST}" "mkdir -p $(quote "${PI_PATH}")"
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
    ssh "${PI_USER}@${RESOLVED_PI_HOST}" \
      "cd $(quote "${PI_PATH}") && npm install --omit=dev"
  fi
fi

if [[ "${RESTART_SERVICE}" == "1" ]]; then
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "Would restart '${SERVICE_NAME}' and show its status"
  else
    ssh "${PI_USER}@${RESOLVED_PI_HOST}" \
      "sudo systemctl restart $(quote "${SERVICE_NAME}") && sudo systemctl status $(quote "${SERVICE_NAME}") --no-pager -l"
  fi
else
  echo "Skipping service restart."
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
    ssh "${PI_USER}@${RESOLVED_PI_HOST}" \
      "cd $(quote "${PI_PATH}") && npm run smoke:hardware --${quoted_smoke_args}"
  fi
else
  echo "Skipping hardware smoke test."
fi
