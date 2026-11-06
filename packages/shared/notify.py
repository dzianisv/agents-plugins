"""Failure notifications shared by the agents-plugins packages.

Source of truth: packages/shared/notify.py. `scripts/sync-shared.sh` copies it into each package.

    notify("turn-check", "audit failed: opencode exited 2")

Writes one line to stderr and raises a desktop notification. The same message is shown at most once per
AGENTS_NOTIFY_WINDOW seconds (default 600), so a failure that repeats every turn does not spam.

Environment:
  AGENTS_NOTIFY=0           turn everything off
  AGENTS_NOTIFY_CMD         command to run instead of the platform default; title and message are appended
  AGENTS_NOTIFY_WINDOW      seconds before the same message may show again
  AGENTS_NOTIFY_STATE_DIR   dedupe state, default ~/.agents/state/notify
"""

import hashlib
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

MAX_CHARS = 200


def _state_dir() -> Path:
    return Path(os.environ.get("AGENTS_NOTIFY_STATE_DIR", "~/.agents/state/notify")).expanduser()


def _window() -> int:
    try:
        return max(0, int(os.environ.get("AGENTS_NOTIFY_WINDOW", "600")))
    except ValueError:
        return 600


def _seen_recently(title: str, message: str) -> bool:
    """True when this message was shown inside the window; otherwise marks it as shown."""
    path = _state_dir() / hashlib.sha1(f"{title}|{message}".encode()).hexdigest()
    try:
        if _window() and time.time() - path.stat().st_mtime < _window():
            return True
    except OSError:
        pass
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    except OSError:
        pass
    return False


def _command(title: str, message: str, level: str):
    override = os.environ.get("AGENTS_NOTIFY_CMD")
    if override:
        return [*override.split(), title, message]
    if platform.system() == "Darwin" and shutil.which("osascript"):
        esc = lambda text: text.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
        sound = ' sound name "Basso"' if level == "error" else ""
        return ["osascript", "-e", f'display notification "{esc(message)}" with title "{esc(title)}"{sound}']
    if shutil.which("notify-send"):
        return ["notify-send", "-u", "critical" if level == "error" else "normal", title, message]
    return None


def notify(title: str, message: str, level: str = "error") -> bool:
    """Tell the user something failed. Returns True when shown; never raises."""
    try:
        if os.environ.get("AGENTS_NOTIFY") == "0":
            return False
        message = " ".join(str(message).split())[:MAX_CHARS]
        if _seen_recently(title, message):
            return False
        print(f"[{title}] {message}", file=sys.stderr)
        command = _command(title, message, level)
        if command:
            subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=5, check=False)
        return True
    except Exception:  # noqa: BLE001 - a notifier must never break the plugin
        return False
