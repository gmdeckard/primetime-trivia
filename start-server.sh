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

# The server already works out which address the room can reach, and it knows
# things this script does not: which adapters are virtual, which is WSL's NAT
# gateway, whether PRIMETIME_HOST_IP was set. This used to recompute it with
# `ip ... | head -1`, which takes whatever the kernel lists first — under WSL
# that is the 10.255.255.254 gateway on loopback, so the script confidently
# printed the one address in the room no phone can reach while the server was
# printing the right one into the log. One source of truth now: the server's.
join_banner() {
  local port="$1" log="$2" ip suffix
  if [ -n "$log" ] && [ -f "$log" ] && grep -q "Players join at" "$log" 2>/dev/null; then
    echo "────────────────────────────────────────────"
    sed -n '/Players join at/,/Question editor/p' "$log"
    echo "────────────────────────────────────────────"
    return
  fi
  # Only reached before the server has written its banner, e.g. the service
  # path. Skip loopback so this cannot repeat the bug it replaced.
  ip="$(ip -4 -o addr show scope global 2>/dev/null | grep -v ' lo ' | awk '{print $4}' | cut -d/ -f1 | head -1)"
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
    join_banner "${PORT_IN_USE:-80}" ""
    # Capture first and branch on emptiness: `cut` exits 0 on empty input, so
    # `|| echo ...` never fired and a box still on PRIMETIME_PIN printed nothing.
    PW_LINE="$(grep -E '^(PRIMETIME_PASSWORD|PRIMETIME_PIN)=' /etc/default/primetime-trivia 2>/dev/null | head -1)"
    PW_VALUE="${PW_LINE#*=}"
    case "$PW_LINE" in
      PRIMETIME_PIN=*) echo "  Host password     ${PW_VALUE} (from the deprecated PRIMETIME_PIN)" ;;
      PRIMETIME_PASSWORD=*) echo "  Host password     ${PW_VALUE}" ;;
      *) echo "  Host password     (see data/control-password)" ;;
    esac
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

# dist/ is gitignored, so `git pull` only ever brings source. Checking that the
# build merely EXISTS meant an updated box started yesterday's bundle: new code
# on disk, old game on the screen, and nothing saying so. Rebuild whenever any
# source is newer than what was built from it. content/ is read at run time, so
# it is not a build input.
BUILD_INPUTS="src shared package.json vite.config.ts tsconfig.json tsconfig.server.json"
needs_build() {
  local ref
  for ref in dist/src/server/index.js dist/client/index.html; do
    [ -f "$ref" ] || return 0
    # shellcheck disable=SC2086
    [ -z "$(find $BUILD_INPUTS -newer "$ref" -print -quit 2>/dev/null)" ] || return 0
  done
  return 1
}

if needs_build; then
  if [ -f dist/client/index.html ]; then
    echo "Sources changed since the last build — rebuilding..."
  else
    echo "Not built yet — building (a few minutes the first time)..."
  fi
  npm install --no-fund --no-audit
  npm run build || { echo "Build failed. The old build is still in place; fix the error above and run this again."; exit 1; }
fi

# ------------------------------------------------- which address the room uses
# The one failure that silently ruins a night: everything looks healthy here
# and no phone can join. The server ranks the candidates and is usually right,
# but a venue can hand out an address in the same band as a container bridge or
# a VM adapter, and then the ranking is a coin toss. The operator is standing
# in the room and knows which network the phones are on, so they get the last
# word.
#
# The list comes from the server (dist/src/server/interfaces.js), not from `ip`
# here. Recomputing it in shell is the bug this script already fixed once.
#
# Asks only with a terminal attached, so the service path, cron and any
# scripted start fall through to the server's own ranking untouched.
choose_host_ip() {
  local tab; tab="$(printf '\t')"

  # PRIMETIME_SERVER_IP is not a name this project ever used, but it is the one
  # people reach for, and an override that is silently ignored is worse than no
  # override at all: the operator believes the address is pinned and stops
  # looking, while the server goes on advertising its own pick.
  if [ -z "${PRIMETIME_HOST_IP:-}" ] && [ -n "${PRIMETIME_SERVER_IP:-}" ]; then
    PRIMETIME_HOST_IP="$PRIMETIME_SERVER_IP"
    export PRIMETIME_HOST_IP
    echo "  Note: the variable is PRIMETIME_HOST_IP, not PRIMETIME_SERVER_IP."
    echo "  Taking PRIMETIME_SERVER_IP=${PRIMETIME_SERVER_IP} as the address anyway."
  fi
  if [ -n "${PRIMETIME_HOST_IP:-}" ]; then
    echo "Using PRIMETIME_HOST_IP=${PRIMETIME_HOST_IP} (already set)."
    return 0
  fi
  # Every early exit here says `return 0`, never a bare `return`, and the
  # difference is the whole night. A bare `return` hands back the status of the
  # last command run, which on these lines is the test that just failed. Under
  # `set -e` that non-zero return kills the script at the call site below,
  # before the server is ever launched: no error, no output past this function.
  # It shipped that way and broke exactly the machines that take a shortcut.
  [ -t 0 ] || return 0
  [ -z "${PRIMETIME_NO_PICK:-}" ] || return 0

  local list count
  list="$(node dist/src/server/interfaces.js 2>/dev/null)" || list=""
  count=0
  [ -z "$list" ] || count="$(printf '%s\n' "$list" | wc -l | tr -d ' ')"

  # The default is the best candidate the server can see that carries no
  # warning. A candidate with a note is one we already know a phone may not
  # reach, so it is never what Enter means.
  local default_idx i addr iface note
  default_idx=""
  i=0
  # Guarded: a heredoc of an empty string still feeds one blank line, which
  # would read back as a candidate with no note and make it the default.
  if [ -n "$list" ]; then
    while IFS="$tab" read -r addr iface note; do
      i=$((i + 1))
      if [ -z "$default_idx" ] && [ -z "$(printf '%s' "$note" | tr -d '[:space:]')" ]; then
        default_idx="$i"
      fi
    done <<EOF
$list
EOF
  fi

  # One clean candidate is not a choice worth stopping for. One candidate that
  # is already flagged is the opposite case: that is the night where everything
  # looks healthy here and no phone can join, and typing the real address is
  # the only way out. Same when the box can see no address at all.
  # Written as an if, not an `&&` chain: a chain whose last test fails is the
  # shape of the bare-`return` bug above, and this function has paid for that
  # lesson once already.
  if [ "$count" -eq 1 ] && [ -n "$default_idx" ]; then
    return 0
  fi

  local reply attempt
  echo
  if [ "$count" -eq 0 ]; then
    echo "  No network address found on this machine."
    echo "  Connect to the venue wifi or router, or type the address to advertise."
  else
    echo "  Which address will the phones use?"
    i=0
    while IFS="$tab" read -r addr iface note; do
      i=$((i + 1))
      if [ -n "$note" ]; then
        printf '    %d) %-15s %-16s %s\n' "$i" "$addr" "$iface" "$note"
      else
        printf '    %d) %-15s %-16s\n' "$i" "$addr" "$iface"
      fi
    done <<EOF
$list
EOF
    if [ -z "$default_idx" ]; then
      echo "    (every address above is flagged — none of them is a safe default)"
    fi
    echo "    o) something else — type an address"
  fi
  echo

  for attempt in 1 2 3; do
    if [ "$count" -eq 0 ]; then
      reply="o"
    elif [ -n "$default_idx" ]; then
      printf '  Pick 1-%d, o, or Enter for %d: ' "$count" "$default_idx"
      read -r reply || reply=""
      [ -n "$reply" ] || reply="$default_idx"
    else
      printf '  Pick 1-%d, or o to type an address: ' "$count"
      read -r reply || reply=""
      if [ -z "$reply" ]; then
        echo "  Nothing above is safe to default to — pick a number or type an address."
        continue
      fi
    fi
    case "$reply" in
      o|O)
        printf '  Address: '
        read -r reply || reply=""
        # No validation beyond non-empty: an operator typing an address here is
        # overriding our guess on purpose and may know something we do not.
        if [ -n "$reply" ]; then
          PRIMETIME_HOST_IP="$reply"
          export PRIMETIME_HOST_IP
          echo "  Using ${PRIMETIME_HOST_IP}."
          return 0
        fi
        echo "  Nothing typed."
        continue
        ;;
    esac
    case "$reply" in
      *[!0-9]*|"") echo "  Not a number." ; continue ;;
    esac
    if [ "$reply" -lt 1 ] || [ "$reply" -gt "$count" ]; then
      echo "  Out of range."
      continue
    fi
    PRIMETIME_HOST_IP="$(printf '%s\n' "$list" | sed -n "${reply}p" | cut -d"$tab" -f1)"
    export PRIMETIME_HOST_IP
    echo "  Using ${PRIMETIME_HOST_IP}."
    return 0
  done
  # Three bad answers in a row: fall through to the server's ranking rather
  # than block a night on a prompt.
  echo "  Falling back to the automatic pick."
  return 0
}

# 80 needs privileges we do not have here; the service handles that properly.
PORT="${PORT:-8080}"
export PORT
export PRIMETIME_VENUE="${PRIMETIME_VENUE:-PrimeTime Trivia}"

choose_host_ip

echo "Starting in the background on port ${PORT}..."
# The banner can carry a freshly generated password, and this file outlives the
# night. Create it before the redirect so it is never briefly world-readable.
: > "$LOG_FILE"
chmod 600 "$LOG_FILE"
nohup node dist/src/server/index.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 2

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  grep -E "Host password|Room code|questions in" "$LOG_FILE" | sed 's/^/  /' || true
  join_banner "$PORT" "$LOG_FILE"
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
