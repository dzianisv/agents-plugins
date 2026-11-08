#!/bin/sh
# Copies the read-only /auth mount into the fresh HOME, then runs the command with bun.
set -eu

copy() {
  [ -f "$1" ] || return 0
  mkdir -p "$(dirname "$2")"
  cp "$1" "$2"
  chmod 600 "$2"
}

copy /auth/opencode.json "$HOME/.config/opencode/opencode.json"
copy /auth/auth.json "$HOME/.local/share/opencode/auth.json"
copy /auth/claude/.credentials.json "$HOME/.claude/.credentials.json"
if [ -f /auth/claude/oauth-token ]; then
  CLAUDE_CODE_OAUTH_TOKEN="$(cat /auth/claude/oauth-token)"
  export CLAUDE_CODE_OAUTH_TOKEN
fi

exec bun "$@"
