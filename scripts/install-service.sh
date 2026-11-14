#!/usr/bin/env bash
#
# Install PrimeTime Trivia as a boot service on a Linux box — a Raspberry Pi,
# a Jetson, a mini PC, anything with systemd.
#
#   sudo ./scripts/install-service.sh
#
# Safe to re-run: it pulls the latest code, rebuilds, and restarts. Your config
# and host password are left alone.
#
# One caveat before re-running it on a box you have edited by hand: the source
# step is `git reset --hard origin/main`, which throws away local changes to
# tracked files. Untracked files and data/ are left alone. Commit anything you
# want to keep first.
#
# Set PORT=8080 when the box is reached through a tunnel or reverse proxy rather
# than directly: no human reads that address, so it does not need to be port 80,
# and the unit then asks for no port-binding capability at all.
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
  cat > "$ENV_FILE" <<EOF
# PrimeTime Trivia settings.
# After editing:  sudo systemctl restart primetime-trivia
#
# Port 80 means players type a bare address with no ":8080" on the end.
PORT=${PORT}
PRIMETIME_VENUE=PrimeTime Trivia
# The MC types this once per phone. It does not change between games, so set it
# here and restart to change it — that signs every device out. Left unset, the
# server generates one on first boot and saves it to data/control-password,
# which is the value printed below.
#PRIMETIME_PASSWORD=
PRIMETIME_DATA=${APP_DIR}/data
# Shown on the join screen so players know which wifi to join first.
#PRIMETIME_SSID=Clubhouse-Guest
#
# Reached from the internet through a tunnel or reverse proxy? Set both of
# these, and set PORT above to 8080. BIND closes the plain-HTTP port to
# everything but the proxy on this machine, so the LAN cannot reach an
# unencrypted copy. PUBLIC_URL is the only address the big screen, the QR code
# and the join panel will show — without it the server advertises a private
# address no phone at the venue can dial.
#PRIMETIME_BIND=127.0.0.1
#PRIMETIME_PUBLIC_URL=https://trivia.example.com
EOF
  chmod 600 "$ENV_FILE"
  echo "    wrote $ENV_FILE (the server will generate the password on first boot)"
fi

echo "==> 5/5  Service"
# A privileged port needs a capability. A high port does not, so don't hand one
# out: a box behind a tunnel runs on 8080 and should hold no port-binding
# capability at all.
if printf '%s' "$PORT" | grep -qE '^[0-9]+$' && [ "$PORT" -lt 1024 ]; then
  CAP_BLOCK="# Lets an unprivileged process bind a low port without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
else
  CAP_BLOCK="# PORT is above 1024, so no port-binding capability is granted.
CapabilityBoundingSet="
fi

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
${CAP_BLOCK}
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
  # A box behind a tunnel has a public hostname, and that is the only address
  # anyone will ever type. Printing this machine's LAN address there would be
  # actively wrong, so PRIMETIME_PUBLIC_URL wins when it is set.
  PUBLIC_LINE="$(grep -E '^PRIMETIME_PUBLIC_URL=' "$ENV_FILE" 2>/dev/null | head -1)"
  if [ -n "$PUBLIC_LINE" ]; then
    BASE="${PUBLIC_LINE#*=}"
  else
    IP=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
    SUFFIX=""; [ "$PORT" = "80" ] || SUFFIX=":${PORT}"
    BASE="http://${IP}${SUFFIX}"
  fi
  echo "────────────────────────────────────────────"
  echo "  Players join at   ${BASE}"
  echo "  Big screen        ${BASE}/host"
  echo "  MC controls       ${BASE}/control"
  echo "  Question editor   ${BASE}/author"
  PW_LINE="$(grep -E '^(PRIMETIME_PASSWORD|PRIMETIME_PIN)=' "$ENV_FILE" 2>/dev/null | head -1)"
  PW_VALUE="${PW_LINE#*=}"
  case "$PW_LINE" in
    PRIMETIME_PIN=*) echo "  Host password     ${PW_VALUE} (from the deprecated PRIMETIME_PIN)" ;;
    PRIMETIME_PASSWORD=*) echo "  Host password     ${PW_VALUE}" ;;
    *) echo "  Host password     $(cat "$APP_DIR/data/control-password" 2>/dev/null || echo '(see data/control-password)')" ;;
  esac
  echo "────────────────────────────────────────────"
  echo "  Logs:    journalctl -u primetime-trivia -f"
  echo "  Restart: sudo systemctl restart primetime-trivia"
else
  echo "Service failed to start. Last 20 log lines:"
  journalctl -u primetime-trivia --no-pager --lines=20
  exit 1
fi
