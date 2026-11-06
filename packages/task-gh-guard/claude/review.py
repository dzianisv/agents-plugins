#!/usr/bin/env python3
"""PreToolUse hook: deny a git or GitHub write that breaks the plain-English rules."""

import json
import subprocess
import sys
from pathlib import Path

from common import read_hook_input

REVIEW = Path(__file__).resolve().parent.parent / "bin" / "git-rules-review"


def main() -> int:
    data = read_hook_input()
    command = (data.get("tool_input") or {}).get("command")
    if data.get("tool_name") != "Bash" or not isinstance(command, str):
        return 0
    proc = subprocess.run(
        [sys.executable, str(REVIEW), "check", "--command", command],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120,
    )
    try:
        verdict = json.loads(proc.stdout)
    except ValueError:
        return 0
    if verdict.get("decision") == "deny":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"task-gh-guard rules: {verdict.get('reason')}",
        }}))
    elif verdict.get("decision") == "skip" and str(verdict.get("reason", "")).startswith("rule review skipped"):
        note = f"task-gh-guard: {verdict['reason']}. The git command ran without its rule check; tell the user."
        print(json.dumps({"systemMessage": note, "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": note}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - a hook must never break the session
        sys.exit(0)
