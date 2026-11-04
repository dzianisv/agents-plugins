#!/usr/bin/env python3
"""PostToolUse hook: record a landed push so the next Stop can check its CI."""

import os
import subprocess
import sys

from common import BIN, is_push_command, read_hook_input


def main() -> int:
    data = read_hook_input()
    if data.get("tool_name") != "Bash":
        return 0
    command = (data.get("tool_input") or {}).get("command")
    if not is_push_command(command):
        return 0
    session = data.get("session_id")
    cwd = data.get("cwd") or os.getcwd()
    subprocess.run(
        [
            sys.executable, str(BIN), "record",
            "--runtime", "claude",
            "--session", str(session or "unknown"),
            "--cwd", cwd,
            "--command", command,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - a recorder must never break the session
        sys.exit(0)
