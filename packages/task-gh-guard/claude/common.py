"""Shared helpers for the task-gh-guard Claude Code hooks."""

import json
import os
import re
import sys
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin" / "pr-ci-gate"

# Mirrors the CLI's detector so a plain Bash call never spawns python.
PUSH = re.compile(
    r"(?:^|[;&|\n]\s*)(?:[^\s;&|]*/)?(?:git\s+(?:-C\s+\S+\s+)?push|gh\s+stack\s+(?:push|submit|link)|git-sign-batch)\b"
)


def read_hook_input() -> dict:
    """The JSON object Claude Code sends on stdin, or {} when it is absent or not an object."""
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return {}
    return payload if isinstance(payload, dict) else {}


def is_push_command(command) -> bool:
    return isinstance(command, str) and bool(PUSH.search(command))


def state_path(session_id) -> Path:
    """~/.agents/state/task-gh-guard/claude-<session>.json, matching the CLI."""
    base = Path(os.environ.get("TASK_GH_GUARD_STATE_DIR", "~/.agents/state/task-gh-guard")).expanduser()
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id if isinstance(session_id, str) else "") or "unknown"
    return base / f"claude-{safe}.json"
