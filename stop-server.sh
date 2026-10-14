#!/usr/bin/env bash
#
# Stop PrimeTime Trivia, whichever way it was started.
#
#   ./stop-server.sh
#
# The game state is on disk, so starting it again resumes the night where it
# left off — teams, scores and which questions have been used.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=".server.pid"
stopped=0

if systemctl cat primetime-trivia >/dev/null 2>&1 && systemctl is-active --quiet primetime-trivia; then
  echo "Stopping the primetime-trivia service..."
  sudo systemctl stop primetime-trivia
  stopped=1
fi

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping background server (pid ${PID})..."
    kill "$PID" 2>/dev/null || true
    # Give it a moment to write its final state, then insist.
    for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    stopped=1
  fi
  rm -f "$PID_FILE"
fi

if [ "$stopped" -eq 1 ]; then
  echo "Stopped. The night is saved — starting again picks up where it left off."
else
  echo "Nothing was running."
fi
