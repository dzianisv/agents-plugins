"""Tests for the rule review: bin/git-rules-review and the PreToolUse hook.

Run: python3 -m unittest discover -s claude/tests
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent.parent
REVIEW = PACKAGE / "bin" / "git-rules-review"
HOOK = PACKAGE / "claude" / "review.py"
FAKE = PACKAGE / "test" / "fixtures" / "fake-opencode"
REPLY = "gh api repos/o/r/pulls/1/comments/9/replies -f body='Thanks, fixed.'"


class ReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="tgg-review-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        bindir = self.tmp / "bin"
        bindir.mkdir()
        shutil.copy2(FAKE, bindir / "opencode")
        self.home = self.tmp / "home"
        self.log = self.tmp / "opencode.log"
        self.env = {
            **os.environ,
            "PATH": f"{bindir}:{os.environ['PATH']}",
            "HOME": str(self.tmp),
            "TASK_GH_GUARD_HOME": str(self.home),
            "TASK_GH_GUARD_STATE_DIR": str(self.tmp / "state"),
            "FAKE_OPENCODE_LOG": str(self.log),
        }
        self.env.pop("TASK_GH_GUARD_CHILD", None)
        self.env.pop("TASK_GH_GUARD_REVIEW", None)

    def check(self, command, reply="ALLOW", **extra):
        env = {**self.env, "FAKE_OPENCODE_REPLY": reply, **extra}
        proc = subprocess.run([sys.executable, str(REVIEW), "check", "--command", command], env=env, capture_output=True, text=True)
        return json.loads(proc.stdout)

    def judge_calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_init_creates_defaults_and_keeps_edits(self):
        subprocess.run([sys.executable, str(REVIEW), "init"], env=self.env, check=True, capture_output=True)
        self.assertEqual(
            (self.home / "model").read_text().strip(),
            "fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest",
        )
        rules = (self.home / "rules").read_text()
        self.assertIn("Do not resolve threads when replied", rules)
        (self.home / "rules").write_text("- my rule\n")
        subprocess.run([sys.executable, str(REVIEW), "init"], env=self.env, check=True, capture_output=True)
        self.assertEqual((self.home / "rules").read_text(), "- my rule\n")

    def test_only_git_writes_reach_the_judge(self):
        for command in ["git status", "gh pr view 3", "gh api repos/o/r/pulls/1/comments", "gh api graphql -f query='query{a}'", "echo git commit"]:
            with self.subTest(command=command):
                self.assertEqual(self.check(command)["decision"], "skip")
        self.assertEqual(self.judge_calls(), [])
        for command in ["git commit -m x", "git push origin b", "gh pr comment 3 -b hi", REPLY, "gh api graphql -f query='mutation { a }'"]:
            with self.subTest(command=command):
                self.assertEqual(self.check(command)["decision"], "allow")

    def test_judge_gets_model_rules_and_command(self):
        self.check(REPLY)
        call = self.judge_calls()[0]
        self.assertEqual(call["argv"][:3], ["run", "-m", "fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest"])
        self.assertIn("reply with commit id", call["stdin"])
        self.assertIn(REPLY, call["stdin"])
        self.assertEqual(self.judge_calls()[-1]["argv"], ["session", "delete", "ses_fake"])

    def test_deny_carries_the_reason(self):
        verdict = self.check(REPLY, reply="DENY: the reply cites no commit id.")
        self.assertEqual(verdict, {"decision": "deny", "reason": "the reply cites no commit id."})

    def test_unreadable_verdict_fails_open(self):
        verdict = self.check(REPLY, reply="I cannot decide")
        self.assertEqual(verdict["decision"], "skip")
        self.assertTrue(verdict["reason"].startswith("rule review skipped"))

    def test_missing_opencode_fails_open(self):
        env = {**self.env, "PATH": "/usr/bin:/bin"}
        proc = subprocess.run([sys.executable, str(REVIEW), "check", "--command", REPLY], env=env, capture_output=True, text=True)
        self.assertEqual(json.loads(proc.stdout)["decision"], "skip")

    def test_judge_child_is_never_reviewed(self):
        self.assertEqual(self.check(REPLY, reply="DENY: x", TASK_GH_GUARD_CHILD="1")["decision"], "skip")
        self.assertEqual(self.judge_calls(), [])

    def test_hook_denies_with_the_reason(self):
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": REPLY}})
        env = {**self.env, "FAKE_OPENCODE_REPLY": "DENY: no commit id."}
        proc = subprocess.run([sys.executable, str(HOOK)], input=payload, env=env, capture_output=True, text=True)
        out = json.loads(proc.stdout)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("no commit id.", out["permissionDecisionReason"])

    def test_hook_warns_loudly_when_the_judge_cannot_run(self):
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": REPLY}})
        env = {**self.env, "FAKE_OPENCODE_REPLY": "no idea"}
        out = json.loads(subprocess.run([sys.executable, str(HOOK)], input=payload, env=env, capture_output=True, text=True).stdout)
        self.assertIn("rule review skipped", out["systemMessage"])
        self.assertIn("tell the user", out["hookSpecificOutput"]["additionalContext"])

    def test_hook_is_silent_for_other_commands_and_allowed_writes(self):
        for command, reply in [("ls", "DENY: x"), (REPLY, "ALLOW")]:
            payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
            env = {**self.env, "FAKE_OPENCODE_REPLY": reply}
            proc = subprocess.run([sys.executable, str(HOOK)], input=payload, env=env, capture_output=True, text=True)
            self.assertEqual((proc.returncode, proc.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
