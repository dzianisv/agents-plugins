"""Tests for the task-gh-guard Claude Code hooks.

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
CLAUDE = PACKAGE / "claude"
GATE = PACKAGE / "bin" / "pr-ci-gate"
FAKE_GH = PACKAGE / "test" / "fixtures" / "fake-gh"
SLUG = "acme/widgets"


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="tgg-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.state_dir = self.tmp / "state"
        self.gh_dir = self.tmp / "gh"
        self.gh_dir.mkdir()
        self.gh_log = self.tmp / "gh.log"
        self.git_log = self.tmp / "git.log"
        self.bindir = self.tmp / "bin"
        self.bindir.mkdir()
        shutil.copy2(FAKE_GH, self.bindir / "gh")
        (self.bindir / "gh").chmod(0o755)
        self.git_bin = shutil.which("git")
        self.origin = self.tmp / "origin.git"
        self.repo = self.tmp / "repo"
        self.config = self.tmp / "gitconfig"
        self.config.write_text(
            f'[url "{self.origin}"]\n'
            f"    insteadOf = git@github.com:{SLUG}.git\n"
            "[user]\n"
            "    email = t@example.com\n"
            "    name = t\n"
        )
        self.env = {
            **os.environ,
            "PATH": f"{self.bindir}:{os.environ['PATH']}",
            "FAKE_GH_DIR": str(self.gh_dir),
            "FAKE_GH_LOG": str(self.gh_log),
            "TASK_GH_GUARD_STATE_DIR": str(self.state_dir),
            "GIT_CONFIG_GLOBAL": str(self.config),
        }
        self.scenario({})

    # -- helpers ---------------------------------------------------------
    def git(self, cwd, *args):
        proc = subprocess.run(
            [self.git_bin, "-C", str(cwd), *args], env=self.env, capture_output=True, text=True
        )
        if proc.returncode != 0:
            self.fail(f"git {args} failed: {proc.stderr}")
        return proc.stdout.strip()

    def make_repo(self):
        subprocess.run([self.git_bin, "init", "--bare", str(self.origin)], env=self.env, check=True, capture_output=True)
        subprocess.run([self.git_bin, "init", "-b", "main", str(self.repo)], env=self.env, check=True, capture_output=True)
        (self.repo / "a.txt").write_text("a")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "one")
        self.git(self.repo, "remote", "add", "origin", f"git@github.com:{SLUG}.git")
        self.git(self.repo, "push", "-u", "origin", "main")

    def branch(self, name):
        self.git(self.repo, "checkout", "-B", name)
        (self.repo / f"{name.replace('/', '_')}.txt").write_text(name)
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", name)
        self.git(self.repo, "push", "-u", "origin", name)
        return self.git(self.repo, "rev-parse", f"refs/heads/{name}")

    def scenario(self, commits):
        (self.gh_dir / "scenario.json").write_text(json.dumps({"repo": SLUG, "commits": commits}))

    def hook(self, script, payload, env=None):
        return subprocess.run(
            [sys.executable, str(CLAUDE / script)],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            env=env or self.env,
            timeout=60,
        )

    def push_hook(self, session="s1", command="git push origin feature/x"):
        return self.hook(
            "record.py",
            {"session_id": session, "cwd": str(self.repo), "tool_name": "Bash", "tool_input": {"command": command}},
        )

    def stop(self, session="s1", active=False, env=None):
        return self.hook("stop.py", {"session_id": session, "cwd": str(self.repo), "stop_hook_active": active}, env=env)

    def state_path(self, session="s1"):
        return self.state_dir / f"claude-{session}.json"

    def state(self, session="s1"):
        return json.loads(self.state_path(session).read_text())

    # -- tests -----------------------------------------------------------
    def test_no_state_allows_without_calling_git_or_gh(self):
        fake = self.tmp / "fakebin"
        fake.mkdir()
        (fake / "git").write_text(f"#!/bin/sh\necho git >> {self.git_log}\nexit 1\n")
        (fake / "git").chmod(0o755)
        (fake / "gh").write_text(f"#!/bin/sh\necho gh >> {self.gh_log}\nexit 1\n")
        (fake / "gh").chmod(0o755)
        env = {**self.env, "PATH": f"{fake}:{self.bindir}:{os.environ['PATH']}"}
        result = self.stop(session="nothing", env=env)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "")
        self.assertFalse(self.git_log.exists(), "stop must not call git without a state file")
        self.assertFalse(self.gh_log.exists(), "stop must not call gh without a state file")

    def test_push_recorded_only_when_local_equals_origin(self):
        self.make_repo()
        sha = self.branch("feature/x")
        result = self.push_hook()
        self.assertEqual(result.returncode, 0)
        entries = self.state()["entries"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["branch"], "feature/x")
        self.assertEqual(entries[0]["sha"], sha)
        self.assertEqual(entries[0]["owner"], "acme")
        self.assertEqual(entries[0]["name"], "widgets")

        # The local branch moves ahead; a push that did not land must not replace the recorded sha.
        (self.repo / "later.txt").write_text("later")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "later")
        self.push_hook()
        self.assertEqual(self.state()["entries"][0]["sha"], sha)

        # A branch that was never pushed is never recorded.
        self.git(self.repo, "checkout", "-b", "feature/local")
        (self.repo / "local.txt").write_text("local")
        self.git(self.repo, "add", ".")
        self.git(self.repo, "commit", "-m", "local")
        self.push_hook(session="s2", command="git push origin feature/local")
        self.assertFalse(self.state_path("s2").exists())

    def test_fail_blocks_with_url_and_pr(self):
        self.make_repo()
        sha = self.branch("feature/x")
        self.push_hook()
        self.scenario({
            sha: {
                "check_runs": [{
                    "name": "build-and-test",
                    "status": "completed",
                    "conclusion": "failure",
                    "details_url": "https://ci.example/runs/1",
                }],
                "pr": 48,
            }
        })
        result = self.stop()
        self.assertEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["decision"], "block")
        self.assertIn("build-and-test", payload["reason"])
        self.assertIn("https://ci.example/runs/1", payload["reason"])
        self.assertIn("PR #48", payload["reason"])
        self.assertTrue(self.state_path().exists())

    def test_pending_blocks_once_then_allows_when_stop_hook_active(self):
        self.make_repo()
        sha = self.branch("feature/x")
        self.push_hook()
        self.scenario({
            sha: {
                "check_runs": [{
                    "name": "build-and-test",
                    "status": "in_progress",
                    "conclusion": None,
                    "details_url": "https://ci.example/runs/2",
                }]
            }
        })
        first = self.stop()
        payload = json.loads(first.stdout)
        self.assertEqual(payload["decision"], "block")
        self.assertIn("CI pending on feature/x@", payload["reason"])
        self.assertIn("Say it is pending; do not claim done.", payload["reason"])
        self.assertTrue(self.state_path().exists())

        second = self.stop(active=True)
        self.assertEqual(second.returncode, 0)
        self.assertEqual(second.stdout.strip(), "")
        self.assertTrue(self.state_path().exists(), "state survives so the next turn checks again")

    def test_pass_allows_and_deletes_state(self):
        self.make_repo()
        sha = self.branch("feature/x")
        self.push_hook()
        self.scenario({
            sha: {
                "check_runs": [{
                    "name": "build-and-test",
                    "status": "completed",
                    "conclusion": "success",
                    "details_url": "https://ci.example/runs/3",
                }]
            }
        })
        result = self.stop()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "")
        self.assertFalse(self.state_path().exists())

    def test_newer_foreign_commit_does_not_change_verdict(self):
        self.make_repo()
        sha = self.branch("feature/x")
        self.push_hook()
        self.scenario({sha: {
            "check_runs": [{"name": "test", "status": "completed", "conclusion": "success", "details_url": "https://ci/1"}],
        }})

        other = self.tmp / "other"
        subprocess.run([self.git_bin, "clone", str(self.origin), str(other)], env=self.env, check=True, capture_output=True)
        self.git(other, "config", "user.email", "t@example.com")
        self.git(other, "config", "user.name", "t")
        self.git(other, "checkout", "feature/x")
        (other / "foreign.txt").write_text("foreign")
        self.git(other, "add", ".")
        self.git(other, "commit", "-m", "foreign")
        self.git(other, "push", "origin", "feature/x")

        result = self.stop()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "")
        self.assertFalse(self.state_path().exists())
        calls = self.gh_log.read_text()
        self.assertIn(sha, calls)
        foreign = self.git(other, "rev-parse", "refs/heads/feature/x")
        self.assertNotIn(foreign, calls)

    def test_git_sign_batch_dry_run_is_not_recorded(self):
        self.make_repo()
        self.branch("feature/x")
        self.push_hook(session="s4", command="git-sign-batch --dry-run -m x")
        self.assertFalse(self.state_path("s4").exists())

    def test_stack_push_records_every_open_branch(self):
        self.make_repo()
        first = self.branch("stack/a")
        second = self.branch("stack/b")
        (self.repo / ".git" / "gh-stack").write_text(json.dumps({
            "schemaVersion": 1,
            "stacks": [{
                "number": 42,
                "branches": [
                    {"branch": "stack/a", "pullRequest": {"number": 1}},
                    {"branch": "stack/b", "pullRequest": {"number": 2}},
                    {"branch": "stack/merged", "pullRequest": {"number": 3, "merged": True}},
                ],
            }],
        }))
        self.push_hook(session="s3", command="gh stack push")
        entries = {e["branch"]: e["sha"] for e in self.state("s3")["entries"]}
        self.assertEqual(entries, {"stack/a": first, "stack/b": second})


class DropSupersededTest(unittest.TestCase):
    def setUp(self):
        from importlib.machinery import SourceFileLoader
        self.gate = SourceFileLoader("pr_ci_gate", str(GATE)).load_module()

    def test_cancelled_run_replaced_by_later_run_is_ignored(self):
        runs = [
            {"name": "sigscanner-check", "status": "completed", "conclusion": "cancelled", "started_at": "2026-11-04T09:02:43Z"},
            {"name": "sigscanner-check", "status": "completed", "conclusion": "success", "started_at": "2026-11-04T09:02:48Z"},
        ]
        self.assertEqual([r["conclusion"] for r in self.gate.drop_superseded(runs)], ["success"])

    def test_cancelled_run_without_replacement_still_counts(self):
        runs = [{"name": "lint", "status": "completed", "conclusion": "cancelled", "started_at": "2026-11-04T09:00:00Z"}]
        self.assertEqual(self.gate.drop_superseded(runs), runs)

    def test_failure_is_never_dropped(self):
        runs = [
            {"name": "e2e", "status": "completed", "conclusion": "failure", "started_at": "2026-11-04T09:00:00Z"},
            {"name": "e2e", "status": "completed", "conclusion": "success", "started_at": "2026-11-04T09:01:00Z"},
        ]
        self.assertEqual(len(self.gate.drop_superseded(runs)), 2)


if __name__ == "__main__":
    unittest.main()
