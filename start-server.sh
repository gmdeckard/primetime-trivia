#!/usr/bin/env bash
#
# Start PrimeTime Trivia.
#
#   ./start-server.sh
#
# If the systemd service is installed (scripts/install-service.sh), this starts
# that and gets you boot persistence and automatic restarts. Otherwise it runs
# the server in the background on port 8080 and logs to server.log — fine for a
# try-out, but it stops when the machine does.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=".server.pid"
LOG_FILE="server.log"

have_service() { systemctl cat primetime-trivia >/dev/null 2>&1; }

join_banner() {
  local port="$1"
  local ip suffix
  ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
  [ -n "$ip" ] || ip="localhost"
  suffix=""; [ "$port" = "80" ] || suffix=":${port}"
  echo "────────────────────────────────────────────"
  echo "  Players join at   http://${ip}${suffix}"
  echo "  Big screen        http://${ip}${suffix}/host"
  echo "  MC controls       http://${ip}${suffix}/control"
  echo "  Question editor   http://${ip}${suffix}/author"
  echo "────────────────────────────────────────────"
}

# ---------------------------------------------------------------- service
if have_service; then
  if systemctl is-active --quiet primetime-trivia; then
    echo "Already running as a service."
  else
    echo "Starting the primetime-trivia service..."
    sudo systemctl start primetime-trivia
    sleep 2
  fi

  if systemctl is-active --quiet primetime-trivia; then
    PORT_IN_USE="$(grep -E '^PORT=' /etc/default/primetime-trivia 2>/dev/null | cut -d= -f2 || echo 80)"
    join_banner "${PORT_IN_USE:-80}"
    echo "  Host PIN          $(grep -E '^PRIMETIME_PIN=' /etc/default/primetime-trivia 2>/dev/null | cut -d= -f2 || echo '(see config)')"
    echo "  Logs              journalctl -u primetime-trivia -f"
  else
    echo "The service failed to start. Last 20 lines:"
    journalctl -u primetime-trivia --no-pager --lines=20
    exit 1
  fi
  exit 0
fi

# ---------------------------------------------------------------- direct
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PID_FILE")). Use ./stop-server.sh first."
  exit 0
fi

if [ ! -f dist/src/server/index.js ] || [ ! -f dist/client/index.html ]; then
  echo "Not built yet — building (a few minutes the first time)..."
  npm install --no-fund --no-audit
  npm run build
fi

# 80 needs privileges we do not have here; the service handles that properly.
PORT="${PORT:-8080}"
export PORT
export PRIMETIME_VENUE="${PRIMETIME_VENUE:-PrimeTime Trivia}"

echo "Starting in the background on port ${PORT}..."
nohup node dist/src/server/index.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 2

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  grep -E "Host PIN|Room code|questions in" "$LOG_FILE" | sed 's/^/  /' || true
  join_banner "$PORT"
  echo "  Logs              tail -f $(pwd)/${LOG_FILE}"
  echo "  Stop              ./stop-server.sh"
  echo
  echo "  Note: this stops when the machine reboots."
  echo "  For a box that runs itself: sudo ./scripts/install-service.sh"
else
  echo "Failed to start. Log:"
  cat "$LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
