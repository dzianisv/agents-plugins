#!/usr/bin/env python3
"""Stop hook: block the stop while CI for a pushed commit is red or still running."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from common import (
    BIN,
    block_window,
    read_hook_input,
    read_state,
    report_key,
    state_path,
    write_state,
)
from notify import notify


def gate(state: Path):
    """Run the shared checker; None when it passes or cannot answer (a failed run is reported loudly)."""
    try:
        proc = subprocess.run(
            [sys.executable, str(BIN), "--state", str(state), "--json"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=100,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        notify("task-gh-guard", f"CI check could not run: {exc}")
        return None
    if proc.returncode == 0:
        return None
    if proc.returncode not in (1, 2):
        notify("task-gh-guard", f"CI check exited {proc.returncode}: {(proc.stderr or '').strip()[:120]}")
        return None
    try:
        result = json.loads(proc.stdout)
    except ValueError:
        notify("task-gh-guard", "CI check printed no readable result")
        return None
    return result if isinstance(result, dict) else None


def failing(result: dict) -> list:
    return [entry for entry in result.get("entries") or [] if entry.get("status") != "pass"]


def reported(state: Path, result: dict, now: int, window: int) -> bool:
    """True when every failing commit blocked a stop within the window."""
    entries = failing(result)
    if not entries or window <= 0:
        return False
    seen = read_state(state).get("reported")
    seen = seen if isinstance(seen, dict) else {}
    for entry in entries:
        item = seen.get(report_key(entry))
        at = item.get("at") if isinstance(item, dict) else None
        if not isinstance(at, int) or now - at >= window:
            return False
    return True


def mark(state: Path, result: dict, now: int) -> None:
    data = read_state(state)
    seen = data.get("reported") if isinstance(data.get("reported"), dict) else {}
    for entry in failing(result):
        seen[report_key(entry)] = {"at": now}
    data["reported"] = seen
    data["updated_at"] = now
    write_state(state, data)


def main() -> int:
    if os.environ.get("TASK_GH_GUARD_ENABLED") == "0":
        return 0
    data = read_hook_input()
    state = state_path(data.get("session_id"))
    if not state.is_file():
        return 0  # no push this session: never run git or gh
    result = gate(state)
    if not result or result.get("status") not in {"fail", "pending"}:
        return 0
    for entry in result.get("entries") or []:
        if entry.get("error"):
            notify("task-gh-guard", f"CI check could not read {entry.get('branch')}@{str(entry.get('sha'))[:7]}: {entry['error']}")
    if data.get("stop_hook_active"):
        return 0  # one block per turn; the state file survives for the next turn
    now = int(time.time())
    if reported(state, result, now, block_window()):
        return 0  # this commit already blocked within the window; do not burn another turn
    reason = result.get("message") or f"CI is {result['status']} for a commit this session pushed."
    if result["status"] == "pending":
        reason += "\nSay it is pending; do not claim done."
    else:
        reason += "\nFix the failing check or report it as a known failure; do not claim the task is done."
    mark(state, result, now)
    print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - a hook must never break the session
        sys.exit(0)
