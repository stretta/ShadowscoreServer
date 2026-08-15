#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SHADOWSCORE_REPO_URL:-https://github.com/stretta/ShadowscoreServer.git}"
INSTALL_DIR="${SHADOWSCORE_INSTALL_DIR:-/home/pi/ShadowscoreServer}"
ROLE="${SHADOWSCORE_ROLE:-host}"
BRANCH="${SHADOWSCORE_BRANCH:-main}"
PUBLIC_URL="${SHADOWSCORE_PUBLIC_URL:-}"
SESSION_HOST_URL="${SHADOWSCORE_SESSION_HOST_URL:-}"
HOST_IDENTITY="${SHADOWSCORE_HOST_IDENTITY:-$(hostname)}"
ADVERTISED_NAME="${SHADOWSCORE_ADVERTISED_NAME:-$(hostname)}"
RUN_SMOKE="${SHADOWSCORE_RUN_SMOKE:-1}"
JACK_TRANSPORT="${SHADOWSCORE_JACK_TRANSPORT:-0}"
JACK_TRANSPORT_INTERVAL_MS="${SHADOWSCORE_JACK_TRANSPORT_INTERVAL_MS:-75}"

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --role host|peer              Install as session host or peer registration agent. Default: host
  --repo-url URL                Git repository URL. Default: $REPO_URL
  --branch NAME                 Git branch to checkout. Default: $BRANCH
  --install-dir PATH            Install directory. Default: $INSTALL_DIR
  --public-url URL              Host public URL, for example http://pt5.local:8790
  --session-host-url URL        Disable discovery and pin a peer to this explicit coordinator URL
  --host-identity ID            Stable unit id. Default: hostname
  --advertised-name NAME        Display name. Default: hostname
  --enable-jack-transport       Install and run the host JACK transport bridge
  --jack-transport-interval MS  JACK bridge poll interval. Default: $JACK_TRANSPORT_INTERVAL_MS
  --no-smoke                    Skip final hardware smoke test
  -h, --help                    Show this help

Environment variables with matching SHADOWSCORE_* names may also be used.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --session-host-url) SESSION_HOST_URL="$2"; shift 2 ;;
    --host-identity) HOST_IDENTITY="$2"; shift 2 ;;
    --advertised-name) ADVERTISED_NAME="$2"; shift 2 ;;
    --enable-jack-transport) JACK_TRANSPORT=1; shift ;;
    --jack-transport-interval) JACK_TRANSPORT_INTERVAL_MS="$2"; shift 2 ;;
    --no-smoke) RUN_SMOKE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$ROLE" != "host" && "$ROLE" != "peer" ]]; then
  echo "--role must be host or peer" >&2
  exit 2
fi

if [[ "$ROLE" == "host" && -z "$PUBLIC_URL" ]]; then
  PUBLIC_URL="http://${HOST_IDENTITY}.local:8790"
fi

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

log() {
  printf '\n[shadowscore-install] %s\n' "$*"
}

need_apt_update=0
for command_name in git curl node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    need_apt_update=1
  fi
done

if [[ "$need_apt_update" -eq 1 ]]; then
  log "Installing prerequisites"
  $SUDO apt-get update
  $SUDO apt-get install -y git curl ca-certificates nodejs npm
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 18 ]]; then
  echo "ShadowscoreServer requires Node.js 18 or newer; found $(node --version). Install a current Node.js release and rerun this installer." >&2
  exit 1
fi

log "Installing repository at $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  parent_dir="$(dirname "$INSTALL_DIR")"
  $SUDO mkdir -p "$parent_dir"
  $SUDO chown "$(id -u):$(id -g)" "$parent_dir"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

log "Installing npm package metadata"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

if [[ "$ROLE" == "host" ]]; then
  CONFIG_TEMPLATE_PATH="config/shadowbox.hardware-host.json"
  CONFIG_PATH="config/shadowscore.host.local.json"
else
  CONFIG_TEMPLATE_PATH="config/shadowbox.hardware-peer.json"
  CONFIG_PATH="config/shadowscore.peer.local.json"
fi

if [[ -f "$CONFIG_PATH" ]]; then
  log "Updating $ROLE config at $CONFIG_PATH while preserving local settings"
else
  log "Writing $ROLE config to $CONFIG_PATH"
fi
SHADOWSCORE_ROLE_VALUE="$ROLE" \
SHADOWSCORE_PUBLIC_URL_VALUE="$PUBLIC_URL" \
SHADOWSCORE_SESSION_HOST_URL_VALUE="$SESSION_HOST_URL" \
SHADOWSCORE_HOST_IDENTITY_VALUE="$HOST_IDENTITY" \
SHADOWSCORE_ADVERTISED_NAME_VALUE="$ADVERTISED_NAME" \
SHADOWSCORE_JACK_TRANSPORT_VALUE="$JACK_TRANSPORT" \
SHADOWSCORE_JACK_TRANSPORT_INTERVAL_MS_VALUE="$JACK_TRANSPORT_INTERVAL_MS" \
SHADOWSCORE_CONFIG_TEMPLATE_PATH="$CONFIG_TEMPLATE_PATH" \
SHADOWSCORE_CONFIG_PATH="$CONFIG_PATH" \
node bin/configure-install.mjs

if [[ "$ROLE" == "host" ]]; then
  SERVICE_NAME="shadowscore-server.service"
  SERVICE_CONFIG_DEFAULT="/home/pi/ShadowscoreServer/config/shadowbox.hardware-host.json"
else
  SERVICE_NAME="shadowscore-registration-agent.service"
  SERVICE_CONFIG_DEFAULT="/home/pi/ShadowscoreServer/config/shadowbox.hardware-peer.json"
fi

log "Installing systemd service $SERVICE_NAME"
SERVICE_CONFIG_PATH="$INSTALL_DIR/$CONFIG_PATH"
tmp_service="$(mktemp)"
sed \
  -e "s#$SERVICE_CONFIG_DEFAULT#$SERVICE_CONFIG_PATH#g" \
  -e "s#/home/pi/ShadowscoreServer#$INSTALL_DIR#g" \
  "deploy/systemd/$SERVICE_NAME" > "$tmp_service"
$SUDO cp "$tmp_service" "/etc/systemd/system/$SERVICE_NAME"
rm -f "$tmp_service"
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$SERVICE_NAME"
$SUDO systemctl restart "$SERVICE_NAME"

BRIDGE_SERVICE_NAME="shadowscore-jack-transport-bridge.service"
if [[ "$ROLE" == "host" && "$JACK_TRANSPORT" == "1" ]]; then
  log "Installing JACK transport bridge service"
  if ! ldconfig -p 2>/dev/null | grep -q 'libjack.so.0'; then
    echo "JACK transport bridge requested, but libjack.so.0 was not found" >&2
    exit 1
  fi
  interval_seconds="$(node -e 'const ms=Number(process.argv[1]); if (!Number.isFinite(ms) || ms <= 0) process.exit(2); console.log(ms / 1000)' "$JACK_TRANSPORT_INTERVAL_MS")"
  tmp_bridge_service="$(mktemp)"
  sed \
    -e "s#/home/pi/ShadowscoreServer#$INSTALL_DIR#g" \
    -e "s#--host shadowbox-host#--host $HOST_IDENTITY#g" \
    -e "s#--interval 0.075#--interval $interval_seconds#g" \
    "deploy/systemd/$BRIDGE_SERVICE_NAME" > "$tmp_bridge_service"
  $SUDO cp "$tmp_bridge_service" "/etc/systemd/system/$BRIDGE_SERVICE_NAME"
  rm -f "$tmp_bridge_service"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "$BRIDGE_SERVICE_NAME"
  $SUDO systemctl restart "$BRIDGE_SERVICE_NAME"
elif [[ "$ROLE" == "host" ]]; then
  log "Disabling JACK transport bridge service"
  $SUDO systemctl disable --now "$BRIDGE_SERVICE_NAME" >/dev/null 2>&1 || true
fi

if [[ "$ROLE" == "host" ]]; then
  log "Waiting for host readiness"
  ready=0
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 1 "http://127.0.0.1:8790/healthz" >/dev/null 2>&1 \
      && curl -fsS --max-time 1 "http://127.0.0.1:8790/" | grep -q "ShadowScore Views" \
      && curl -fsS --max-time 1 "http://127.0.0.1:8790/structure-editor" | grep -q "ShadowScore Arrange" \
      && curl -fsS --max-time 1 "http://127.0.0.1:8790/matrix-edit" | grep -q "ShadowScore Matrix Edit" \
      && curl -fsS --max-time 1 "http://127.0.0.1:8790/piano-roll" | grep -q "ShadowScore Piano Roll" \
      && curl -fsS --max-time 1 "http://127.0.0.1:8790/event-list" | grep -q "ShadowScore Event List"; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [[ "$ready" != "1" ]]; then
    echo "ShadowscoreServer did not serve /healthz, /, /structure-editor, /matrix-edit, /piano-roll, and /event-list successfully" >&2
    $SUDO journalctl -u "$SERVICE_NAME" -n 80 --no-pager || true
    exit 1
  fi
fi

log "Service status"
$SUDO systemctl --no-pager --full status "$SERVICE_NAME" || true

if [[ "$RUN_SMOKE" == "1" ]]; then
  log "Running hardware smoke test"
  npm run smoke:hardware -- --config "$CONFIG_PATH"
fi

log "Done"
