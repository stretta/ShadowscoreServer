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

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --role host|peer              Install as session host or peer registration agent. Default: host
  --repo-url URL                Git repository URL. Default: $REPO_URL
  --branch NAME                 Git branch to checkout. Default: $BRANCH
  --install-dir PATH            Install directory. Default: $INSTALL_DIR
  --public-url URL              Host public URL, for example http://pt5.local:8790
  --session-host-url URL        Required for peer role, for example http://pt5.local:8790
  --host-identity ID            Stable unit id. Default: hostname
  --advertised-name NAME        Display name. Default: hostname
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

if [[ "$ROLE" == "peer" && -z "$SESSION_HOST_URL" ]]; then
  echo "--session-host-url is required for peer installs" >&2
  exit 2
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
npm install --omit=dev

if [[ "$ROLE" == "host" ]]; then
  CONFIG_TEMPLATE_PATH="config/shadowbox.hardware-host.json"
  CONFIG_PATH="config/shadowscore.host.local.json"
else
  CONFIG_TEMPLATE_PATH="config/shadowbox.hardware-peer.json"
  CONFIG_PATH="config/shadowscore.peer.local.json"
fi

log "Writing $ROLE config to $CONFIG_PATH"
cp "$CONFIG_TEMPLATE_PATH" "$CONFIG_PATH"
SHADOWSCORE_ROLE_VALUE="$ROLE" \
SHADOWSCORE_PUBLIC_URL_VALUE="$PUBLIC_URL" \
SHADOWSCORE_SESSION_HOST_URL_VALUE="$SESSION_HOST_URL" \
SHADOWSCORE_HOST_IDENTITY_VALUE="$HOST_IDENTITY" \
SHADOWSCORE_ADVERTISED_NAME_VALUE="$ADVERTISED_NAME" \
SHADOWSCORE_CONFIG_PATH="$CONFIG_PATH" \
node --input-type=module <<'NODE'
import fs from "node:fs";

const path = process.env.SHADOWSCORE_CONFIG_PATH;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.server ??= {};
config.server.role = process.env.SHADOWSCORE_ROLE_VALUE;
config.server.hostIdentity = process.env.SHADOWSCORE_HOST_IDENTITY_VALUE;
config.server.advertisedName = process.env.SHADOWSCORE_ADVERTISED_NAME_VALUE;
config.http ??= {};
config.static ??= {};
config.static.enabled = true;
config.static.root = "public/matrix-edit";
config.static.index = "index.html";
config.static.apps = {
  matrixEdit: {
    root: "public/matrix-edit",
    index: "index.html",
    routes: ["/matrix-edit"]
  },
  eventList: {
    root: "public/event-list",
    index: "index.html",
    routes: ["/event-list"]
  },
  structureEditor: {
    root: "public/structure-editor",
    index: "index.html",
    routes: ["/structure-editor", "/"]
  }
};
if (process.env.SHADOWSCORE_ROLE_VALUE === "host") {
  config.http.publicUrl = process.env.SHADOWSCORE_PUBLIC_URL_VALUE;
  config.registration ??= {};
  config.registration.sessionHostUrl = "";
} else {
  config.http.publicUrl = "";
  config.registration ??= {};
  config.registration.sessionHostUrl = process.env.SHADOWSCORE_SESSION_HOST_URL_VALUE;
  config.rnbo ??= {};
  config.rnbo.oscQuery ??= {};
  if (!config.rnbo.oscQuery.oscHost) {
    config.rnbo.oscQuery.oscHost = `${process.env.SHADOWSCORE_HOST_IDENTITY_VALUE}.local`;
  }
}
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

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

if [[ "$ROLE" == "host" ]]; then
  log "Waiting for host readiness"
  ready=0
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 1 "http://127.0.0.1:8790/healthz" >/dev/null 2>&1 \
      && curl -fsS --max-time 1 "http://127.0.0.1:8790/" | grep -q "ShadowScore Structure Editor" \
      && curl -fsS --max-time 1 "http://127.0.0.1:8790/matrix-edit" | grep -q "ShadowScore Matrix Edit" \
      && curl -fsS --max-time 1 "http://127.0.0.1:8790/event-list" | grep -q "ShadowScore Event List"; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [[ "$ready" != "1" ]]; then
    echo "ShadowscoreServer did not serve /healthz, /, and /event-list successfully" >&2
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
