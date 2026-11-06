"""Tests for notify.py and the package copies. Run: python3 -m unittest discover -s packages/shared"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import notify  # noqa: E402

SYNC = HERE.parent.parent / "scripts" / "sync-shared.sh"


class NotifyTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="notify-"))
        self.log = tmp / "calls.txt"
        recorder = tmp / "rec.sh"
        recorder.write_text(f'#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> "{self.log}"\n')
        recorder.chmod(0o755)
        self.saved = {k: os.environ.get(k) for k in ("AGENTS_NOTIFY", "AGENTS_NOTIFY_CMD", "AGENTS_NOTIFY_STATE_DIR", "AGENTS_NOTIFY_WINDOW")}
        os.environ.pop("AGENTS_NOTIFY", None)
        os.environ["AGENTS_NOTIFY_CMD"] = str(recorder)
        os.environ["AGENTS_NOTIFY_STATE_DIR"] = str(tmp / "state")
        os.environ.pop("AGENTS_NOTIFY_WINDOW", None)
        self.addCleanup(self.restore)

    def restore(self):
        for key, value in self.saved.items():
            os.environ.pop(key, None) if value is None else os.environ.__setitem__(key, value)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_shows_title_and_message(self):
        self.assertTrue(notify.notify("turn-check", "audit failed:\n  boom"))
        self.assertEqual(self.calls(), ["turn-check|audit failed: boom"])

    def test_same_message_shows_once_per_window(self):
        self.assertTrue(notify.notify("t", "m"))
        self.assertFalse(notify.notify("t", "m"))
        self.assertTrue(notify.notify("t", "other"))
        os.environ["AGENTS_NOTIFY_WINDOW"] = "0"
        self.assertTrue(notify.notify("t", "m"))
        self.assertEqual(len(self.calls()), 3)

    def test_can_be_turned_off(self):
        os.environ["AGENTS_NOTIFY"] = "0"
        self.assertFalse(notify.notify("t", "m"))
        self.assertEqual(self.calls(), [])

    def test_long_message_is_cut(self):
        notify.notify("t", "x" * 500)
        self.assertEqual(len(self.calls()[0]), len("t|") + notify.MAX_CHARS)

    def test_broken_command_never_raises(self):
        os.environ["AGENTS_NOTIFY_CMD"] = "/no/such/command"
        self.assertFalse(notify.notify("t", "m"))

    def test_package_copies_match_the_source(self):
        proc = subprocess.run([str(SYNC), "--check"], capture_output=True, text=True)
        self.assertEqual((proc.returncode, proc.stderr), (0, ""))


if __name__ == "__main__":
    unittest.main()
