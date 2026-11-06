# task-gh-guard

Stops an agent from claiming a task is done while GitHub CI for a commit it pushed in the
current session is red or still running.

## Rules

1. **No push, no check.** Only a successful push in this session arms the guard. A session that only
   reads code never runs git or `gh` at stop time.
2. **Record exact SHAs.** After `git push`, `gh stack push|submit|link`, or `git-sign-batch` (without
   `--dry-run`/`--no-push`), record the pushed branch and its SHA, but only when
   `refs/heads/<branch>` equals `refs/remotes/origin/<branch>`. No fetch.
3. **Check only those commits.** Read check runs and statuses per recorded SHA, not per PR head. A newer
   commit from someone else on the branch does not change the verdict.
4. **Clear when proven.** When every recorded SHA passes, delete the state file.
5. **Bounded blocking.** A failing or pending check blocks the stop with every failing check, its URL
   and the PR number, at most once per turn (`stop_hook_active`) and once per pushed commit per hour
   (`TASK_GH_GUARD_BLOCK_WINDOW`, default 3600 seconds), so a new commit still blocks while the same
   commit cannot loop. Pending says "CI pending on `<branch>@<sha7>`". State survives so a later turn
   checks again. opencode nudges at most once for pending and three times for a failure per SHA set.

State lives in `~/.agents/state/task-gh-guard/<runtime>-<session_id>.json`.

## Install

Claude Code: add this repository as a marketplace, then install the plugin. After a change, bump
`version` in `.claude-plugin/plugin.json` and run `claude plugin update task-gh-guard@agents-plugins`.

```bash
claude plugin marketplace add <path-to-this-repo>
claude plugin install task-gh-guard@agents-plugins
```

opencode: add the package directory to `plugins` in `~/.config/opencode/opencode.json`, then restart
opencode. One entry serves both generations: v1 resolves `package.json` (`main` → `opencode/plugin.ts`),
v2 loads `server.ts` at the package root. The entry must be the directory, not a file.

```json
"plugins": ["/absolute/path/to/agents-plugins/packages/task-gh-guard"]
```

Requires `python3`, `git` and `gh` (authenticated) on PATH.

## Run it by hand

```bash
pr-ci-gate feature/my-branch            # local SHA of one branch
pr-ci-gate --stack                      # open branches of the current gh stack
pr-ci-gate --stack 42                   # a specific stack
pr-ci-gate --state ~/.agents/state/task-gh-guard/claude-<id>.json
pr-ci-gate --state <file> --wait 300    # poll until CI stops pending
```

Exit codes: `0` pass, `1` a check failed, `2` pending or CI unreadable. `--json` prints machine output.
`pr-ci-gate record ...` is the internal recorder used by the hooks.

## Test

```bash
bun test
python3 -m unittest discover -s claude/tests
```

Both suites use a real temp git repo with a bare origin and a fake `gh` on PATH.
