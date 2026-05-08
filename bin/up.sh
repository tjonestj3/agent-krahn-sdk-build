#!/usr/bin/env bash
# Start the Krahnborn OS dev server and the Cloudflare tunnel in one terminal.
# Output from each process is prefixed so you can tell them apart.
# Ctrl-C cleanly tears both down.

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TUNNEL_NAME="${KRAHNBORN_TUNNEL:-krahnborn-os}"
CONSOLE_DIR="${KRAHN_CONSOLE_DIR:-$REPO/../slack-agents/krahn-console}"

cd "$REPO"

# ANSI color codes (skip if NO_COLOR is set or stdout isn't a tty)
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_SERVER=$'\033[36m'   # cyan
  C_TUNNEL=$'\033[35m'   # magenta
  C_CONSOLE=$'\033[33m'  # yellow
  C_RESET=$'\033[0m'
else
  C_SERVER=''
  C_TUNNEL=''
  C_CONSOLE=''
  C_RESET=''
fi

prefix() {
  local label="$1"
  local color="$2"
  while IFS= read -r line; do
    printf '%s[%s]%s %s\n' "$color" "$label" "$C_RESET" "$line"
  done
}

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Shutting down…"
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "${TUNNEL_PID:-}" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [[ -n "${CONSOLE_PID:-}" ]] && kill -0 "$CONSOLE_PID" 2>/dev/null; then
    kill "$CONSOLE_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM EXIT

# --- preflight ---------------------------------------------------------------

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Error: cloudflared is not on PATH. Install it first." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not on PATH." >&2
  exit 1
fi
if pgrep -f "cloudflared tunnel run $TUNNEL_NAME" >/dev/null 2>&1; then
  echo "Warning: a cloudflared tunnel for '$TUNNEL_NAME' already seems to be running." >&2
  echo "         If the new one fails to bind, kill the old one first." >&2
fi

# Decide whether to bring up the Krahn Console. We skip (with a warning)
# rather than hard-failing if it isn't installed, so up.sh stays usable on
# machines where the console hasn't been set up yet.
RUN_CONSOLE=0
if [[ -d "$CONSOLE_DIR" && -f "$CONSOLE_DIR/package.json" ]]; then
  if [[ -d "$CONSOLE_DIR/node_modules" ]]; then
    RUN_CONSOLE=1
  else
    echo "Warning: $CONSOLE_DIR exists but has no node_modules — skipping console." >&2
    echo "         Run 'npm install' there to enable it." >&2
  fi
fi

# --- launch ------------------------------------------------------------------

echo "Starting Krahnborn OS"
echo "  repo:    $REPO"
echo "  tunnel:  $TUNNEL_NAME"
echo "  server:  npm run dev"
if [[ $RUN_CONSOLE -eq 1 ]]; then
  echo "  console: $CONSOLE_DIR (npm run dev)"
fi
echo

# Start the server. Both stdout and stderr go through the prefix filter.
( npm run dev 2>&1 | prefix "server" "$C_SERVER" ) &
SERVER_PID=$!

# Start the tunnel.
( cloudflared tunnel run "$TUNNEL_NAME" 2>&1 | prefix "tunnel" "$C_TUNNEL" ) &
TUNNEL_PID=$!

# Start the Krahn Console (if installed).
if [[ $RUN_CONSOLE -eq 1 ]]; then
  ( cd "$CONSOLE_DIR" && npm run dev 2>&1 | prefix "console" "$C_CONSOLE" ) &
  CONSOLE_PID=$!
fi

# Wait for any of them to exit. If one dies, the cleanup trap kills the rest.
if [[ -n "${CONSOLE_PID:-}" ]]; then
  wait -n "$SERVER_PID" "$TUNNEL_PID" "$CONSOLE_PID"
else
  wait -n "$SERVER_PID" "$TUNNEL_PID"
fi
EXIT_CODE=$?

if [[ -n "${SERVER_PID:-}" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "server exited; bringing down the rest…"
elif [[ -n "${TUNNEL_PID:-}" ]] && ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
  echo "tunnel exited; bringing down the rest…"
elif [[ -n "${CONSOLE_PID:-}" ]] && ! kill -0 "$CONSOLE_PID" 2>/dev/null; then
  echo "console exited; bringing down the rest…"
fi

exit "$EXIT_CODE"
