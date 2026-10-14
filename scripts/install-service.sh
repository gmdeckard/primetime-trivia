#!/usr/bin/env bash
#
# Install PrimeTime Trivia as a boot service on a Linux box — a Raspberry Pi,
# a Jetson, a mini PC, anything with systemd.
#
#   sudo ./scripts/install-service.sh
#
# Safe to re-run: it pulls the latest code, rebuilds, and restarts. Your config
# and host PIN are left alone.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${SUDO_USER:-$(stat -c '%U' "$APP_DIR")}"
ENV_FILE="/etc/default/primetime-trivia"
UNIT="/etc/systemd/system/primetime-trivia.service"
PORT="${PORT:-80}"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0"; exit 1; }
id "$APP_USER" >/dev/null 2>&1 || { echo "No such user: $APP_USER"; exit 1; }

echo "==> 1/5  Node.js"
if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -c2- | cut -d. -f1)" -ge 20 ]; then
  echo "    $(node -v) already present"
else
  echo "    installing Node 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  echo "    installed $(node -v)"
fi

echo "==> 2/5  Source"
if [ -d "${APP_DIR}/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --all --quiet || true
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard origin/main --quiet || true
  echo "    at $(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)"
else
  echo "    not a git checkout, using files as they are"
fi

echo "==> 3/5  Build"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm install --no-fund --no-audit && npm run build"

echo "==> 4/5  Config"
if [ -f "$ENV_FILE" ]; then
  echo "    $ENV_FILE exists, leaving it alone"
else
  PIN=$(shuf -i 100000-999999 -n 1)
  cat > "$ENV_FILE" <<EOF
# PrimeTime Trivia settings.
# After editing:  sudo systemctl restart primetime-trivia
#
# Port 80 means players type a bare address with no ":8080" on the end.
PORT=${PORT}
PRIMETIME_VENUE=PrimeTime Trivia
PRIMETIME_PIN=${PIN}
PRIMETIME_DATA=${APP_DIR}/data
# Shown on the join screen so players know which wifi to join first.
#PRIMETIME_SSID=Clubhouse-Guest
EOF
  chmod 600 "$ENV_FILE"
  echo "    wrote $ENV_FILE (host PIN ${PIN})"
fi

echo "==> 5/5  Service"
cat > "$UNIT" <<EOF
[Unit]
Description=PrimeTime Trivia
Documentation=https://github.com/gmdeckard/primetime-trivia
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node dist/src/server/index.js
# Lets an unprivileged process bind port 80 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${APP_DIR}/data
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo -u "$APP_USER" mkdir -p "${APP_DIR}/data"
systemctl daemon-reload
systemctl enable --now primetime-trivia
sleep 3

echo
if systemctl is-active --quiet primetime-trivia; then
  IP=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
  SUFFIX=""; [ "$PORT" = "80" ] || SUFFIX=":${PORT}"
  echo "────────────────────────────────────────────"
  echo "  Players join at   http://${IP}${SUFFIX}"
  echo "  Big screen        http://${IP}${SUFFIX}/host"
  echo "  MC controls       http://${IP}${SUFFIX}/control"
  echo "  Question editor   http://${IP}${SUFFIX}/author"
  echo "  Host PIN          $(grep PRIMETIME_PIN "$ENV_FILE" | cut -d= -f2)"
  echo "────────────────────────────────────────────"
  echo "  Logs:    journalctl -u primetime-trivia -f"
  echo "  Restart: sudo systemctl restart primetime-trivia"
else
  echo "Service failed to start. Last 20 log lines:"
  journalctl -u primetime-trivia --no-pager --lines=20
  exit 1
fi
