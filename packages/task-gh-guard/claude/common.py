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


def block_window() -> int:
    """Seconds before the same commit may block a stop again (default: one hour)."""
    try:
        return max(0, int(os.environ.get("TASK_GH_GUARD_BLOCK_WINDOW", "3600")))
    except ValueError:
        return 3600


def read_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("entries"), list):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "entries": []}


def write_state(path: Path, data: dict) -> None:
    """Replace the state file atomically, matching the CLI's writer."""
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def repo_key(entry: dict) -> str:
    """Stable identity for the block budget."""
    return entry.get("repo") or f"{entry.get('owner')}/{entry.get('name')}" or "unknown"


def report_key(entry: dict) -> str:
    """One budget per pushed commit, so a new commit still blocks inside the window."""
    sha = str(entry.get("sha") or "")[:7]
    return f"{repo_key(entry)}|{entry.get('branch') or '?'}@{sha}"


def is_push_command(command) -> bool:
    return isinstance(command, str) and bool(PUSH.search(command))


def state_path(session_id) -> Path:
    """~/.agents/state/task-gh-guard/claude-<session>.json, matching the CLI."""
    base = Path(os.environ.get("TASK_GH_GUARD_STATE_DIR", "~/.agents/state/task-gh-guard")).expanduser()
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id if isinstance(session_id, str) else "") or "unknown"
    return base / f"claude-{safe}.json"
