#!/usr/bin/env python3
"""session-autoreflect — Claude Code hook.

After AUTOREFLECT_INTERVAL_MS (default 30 minutes) of working time in a session,
Claude gets a reflection prompt as extra context and is told to act on the answer.
Idle sessions are never touched: Stop and SessionStart reset the clock.

Usage (from hooks.json):
    python3 autoreflect.py post-tool     # PostToolUse  -> accumulate + maybe inject
    python3 autoreflect.py stop          # Stop         -> task finished, reset
    python3 autoreflect.py session-start # SessionStart -> reset
"""

import json
import os
import sys
import time
from pathlib import Path

PROMPT = (
    "<system-reminder>\n"
    "AUTOREFLECT: you have been working on this task for a while. Stop and reflect before the next step.\n"
    "\n"
    "1. What are you doing right now?\n"
    "2. What is the goal?\n"
    "3. What is the acceptance criteria?\n"
    "4. Did you complete the task? If not, what is wrong?\n"
    "5. Is the implementation plan correct, or does it have to be revisited?\n"
    "6. Are you moving in the right direction, or is there a better/faster way to resolve the issues and blockers?\n"
    "7. Can you unblock yourself?\n"
    "\n"
    "Then act on the answers: take the next concrete step now (fix, unblock, finish, or change the plan). "
    "Do not answer with reflection only and do not stop.\n"
    "</system-reminder>"
)

DEFAULT_INTERVAL_MS = 30 * 60 * 1000
DEFAULT_IDLE_RESET_MS = 10 * 60 * 1000


def _int(name: str, fallback: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def config() -> dict:
    return {
        "enabled": os.environ.get("AUTOREFLECT_ENABLED", "1").lower() not in ("0", "false", "no", "off"),
        "interval_ms": _int("AUTOREFLECT_INTERVAL_MS", DEFAULT_INTERVAL_MS),
        "idle_reset_ms": _int("AUTOREFLECT_IDLE_RESET_MS", DEFAULT_IDLE_RESET_MS),
    }


def home() -> Path:
    return Path(os.environ.get("AUTOREFLECT_HOME") or (Path.home() / ".claude" / "session-autoreflect"))


def state_path(session_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in session_id)
    return home() / (safe + ".json")


def load_state(session_id: str) -> dict:
    try:
        return json.loads(state_path(session_id).read_text())
    except Exception:
        return {}


def save_state(session_id: str, state: dict) -> None:
    try:
        path = state_path(session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        path.write_text(json.dumps(state))
        os.chmod(path, 0o600)
    except Exception:
        pass


def update(state: dict, now: float, cfg: dict) -> bool:
    """Accumulate working time. Returns True when the reflection should be injected."""
    last = state.get("last_at")
    busy = float(state.get("busy_ms") or 0)
    if last is not None:
        gap = max(0.0, now - float(last))
        busy = 0.0 if gap >= cfg["idle_reset_ms"] else busy + gap
    state["last_at"] = now
    state["busy_ms"] = busy
    if busy < cfg["interval_ms"]:
        return False
    state["busy_ms"] = 0.0
    state["injected_at"] = now
    return True


def reset(state: dict, now: float) -> None:
    state["busy_ms"] = 0.0
    state["last_at"] = now


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "post-tool"
    cfg = config()
    if not cfg["enabled"]:
        return 0

    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    session_id = str(payload.get("session_id") or "")
    if not session_id:
        return 0

    now = time.time() * 1000
    state = load_state(session_id)

    if mode in ("stop", "session-start"):
        reset(state, now)
        save_state(session_id, state)
        return 0

    if update(state, now, cfg):
        save_state(session_id, state)
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PostToolUse",
                        "additionalContext": PROMPT,
                    }
                }
            )
        )
        return 0

    save_state(session_id, state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
