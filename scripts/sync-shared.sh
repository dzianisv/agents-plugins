#!/usr/bin/env bash
# Copy packages/shared into each package that uses it. A Claude Code plugin ships only its own directory,
# so each package carries its own copy; `--check` fails when a copy differs from the source.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shared="$root/packages/shared"
packages=(turn-check task-gh-guard)
status=0
for pkg in "${packages[@]}"; do
  for pair in "notify.py:claude" "notify.ts:opencode"; do
    file="${pair%%:*}"; dir="${pair##*:}"
    target="$root/packages/$pkg/$dir/$file"
    if [[ "${1:-}" == "--check" ]]; then
      cmp -s "$shared/$file" "$target" || { echo "out of sync: packages/$pkg/$dir/$file" >&2; status=1; }
    else
      cp "$shared/$file" "$target"
    fi
  done
done
exit "$status"
