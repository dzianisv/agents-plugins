#!/usr/bin/env python3
"""Stop hook: block the stop while CI for a pushed commit is red or still running."""

import json
import os
import subprocess
import sys
from pathlib import Path

from common import BIN, read_hook_input, state_path


def gate(state: Path):
    """Run the shared checker; None when it cannot answer."""
    try:
        proc = subprocess.run(
            [sys.executable, str(BIN), "--state", str(state), "--json"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=100,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode not in (1, 2):
        return None
    try:
        result = json.loads(proc.stdout)
    except ValueError:
        return None
    return result if isinstance(result, dict) else None


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
    if result["status"] == "pending" and data.get("stop_hook_active"):
        return 0  # pending does not loop; the state file survives for the next turn
    reason = result.get("message") or f"CI is {result['status']} for a commit this session pushed."
    if result["status"] == "pending":
        reason += "\nSay it is pending; do not claim done."
    else:
        reason += "\nFix the failing check or report it as a known failure; do not claim the task is done."
    print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - a hook must never break the session
        sys.exit(0)
