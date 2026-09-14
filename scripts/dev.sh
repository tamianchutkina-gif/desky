#!/usr/bin/env bash
#
# Runs the signaling server and the agent together against localhost,
# so one machine can play both sides while developing.
#
# Stops both on Ctrl-C rather than leaving an orphaned agent holding the
# device id and looking online to the console.

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"

node scripts/sync-shared.mjs

PORT="$PORT" node packages/server/src/index.js &
SERVER_PID=$!

cleanup() {
  echo ""
  echo "Stopping..."
  kill "$SERVER_PID" 2>/dev/null || true
  kill "${AGENT_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Give the server a moment to bind, so the agent's first connection
# attempt succeeds instead of falling into backoff.
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

DESKY_SERVER="ws://localhost:$PORT/signal" \
  npm run start --workspace=@desky/host &
AGENT_PID=$!

echo ""
echo "  Operator console: http://localhost:$PORT"
echo "  Ctrl-C stops both processes"
echo ""

wait
