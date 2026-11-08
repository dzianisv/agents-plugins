import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import autoreflect  # noqa: E402

MIN = 60_000
SCRIPT = Path(autoreflect.__file__)


class AutoreflectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["AUTOREFLECT_HOME"] = self.tmp.name
        os.environ["AUTOREFLECT_INTERVAL_MS"] = str(30 * MIN)
        os.environ["AUTOREFLECT_IDLE_RESET_MS"] = str(10 * MIN)

    def tearDown(self):
        self.tmp.cleanup()
        for key in ("AUTOREFLECT_HOME", "AUTOREFLECT_INTERVAL_MS", "AUTOREFLECT_IDLE_RESET_MS"):
            os.environ.pop(key, None)

    def run_hook(self, mode, session_id, cfg=None):
        env = os.environ.copy()
        for k, v in (cfg or {}).items():
            env[k] = str(v)
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), mode],
            input=json.dumps({"session_id": session_id}),
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.strip()

    def test_idle_session_never_injects(self):
        self.assertEqual(self.run_hook("post-tool", "s1"), "")
        self.assertEqual(self.run_hook("post-tool", "s1"), "")

    def test_fires_after_the_interval_and_then_resets(self):
        self.assertEqual(self.run_hook("post-tool", "s2", {"AUTOREFLECT_INTERVAL_MS": 1}), "")
        out = self.run_hook("post-tool", "s2", {"AUTOREFLECT_INTERVAL_MS": 1})
        payload = json.loads(out)
        self.assertEqual(payload["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        self.assertIn("Did you complete the task?", payload["hookSpecificOutput"]["additionalContext"])
        self.assertIn("Then act on the answers", payload["hookSpecificOutput"]["additionalContext"])

    def test_stop_resets_the_clock(self):
        state = {"busy_ms": 29 * MIN, "last_at": 0}
        autoreflect.reset(state, 1)
        self.assertEqual(state["busy_ms"], 0)

    def test_gap_resets_busy_time(self):
        cfg = autoreflect.config()
        state = {"busy_ms": 20 * MIN, "last_at": 0}
        self.assertFalse(autoreflect.update(state, 40 * MIN, cfg))
        self.assertLess(state["busy_ms"], cfg["interval_ms"])

    def test_accumulates_busy_time(self):
        cfg = {"interval_ms": 5 * MIN, "idle_reset_ms": 10 * MIN}
        state = {}
        self.assertFalse(autoreflect.update(state, 0, cfg))
        self.assertFalse(autoreflect.update(state, 3 * MIN, cfg))
        self.assertTrue(autoreflect.update(state, 6 * MIN, cfg))
        self.assertEqual(state["busy_ms"], 0)

    def test_disabled_plugin_is_silent(self):
        self.assertEqual(self.run_hook("post-tool", "s3", {"AUTOREFLECT_ENABLED": "0"}), "")


if __name__ == "__main__":
    unittest.main()
