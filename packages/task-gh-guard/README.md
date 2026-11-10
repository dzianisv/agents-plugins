# task-gh-guard

Two guards for an agent that works through git and GitHub:

- It stops the agent from claiming a task is done while GitHub CI for a commit it pushed in the
  current session is red or still running.
- It reviews each git or GitHub write (commit, push, PR or issue comment, review reply, thread
  resolve) against plain-English rules with a judge model, and blocks the command that breaks one.

## Rule review

Before a `git commit|push`, `gh stack push|submit|link`, `gh pr|issue` write or a writing `gh api` call
(non-GET method, `-f`/`-F` fields, or a GraphQL `mutation`), the plugin runs
`opencode run -m "$(< model)"` with the rules and the command, and the judge answers `ALLOW` or
`DENY: <reason>`. A deny blocks the tool call and the reason goes back to the agent. Reads never reach
the judge.

Both files live in `~/.agents/plugins/task-gh-guard/` and are created with defaults on the first
session start or Bash call. An existing file is never overwritten, so edit them freely.

| File | Content |
| --- | --- |
| `model` | One `provider/model` line, default `fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest` |
| `rules` | One plain-English rule per line (a directory of `*.md` files also works) |

Default rules:

```
- Plain english. Tldr, do not write a lot.
- Remove AI slop.
- To a change request reply with commit id where it is addressed.
- Do not resolve threads when replied
```

The review fails open: no `opencode`, a timeout (`TASK_GH_GUARD_REVIEW_TIMEOUT`, default 60 seconds) or an
unreadable verdict allows the command, shows a warning, and is logged with every verdict to
`~/.agents/state/task-gh-guard/review.jsonl`. When the review or the CI check cannot run, the user gets a desktop notification (and an opencode toast) through
`packages/shared/notify`; `AGENTS_NOTIFY=0` turns it off. Missing API keys are read from `~/.env` for the judge process
only. Set `TASK_GH_GUARD_REVIEW=0` to turn the review off. Each review adds about 5 seconds to a write
command. Runs in Claude Code (`PreToolUse`) and both opencode entries (v1 `src/opencode/plugin.ts`, v2
`server.ts`).

Try it by hand:

```bash
bin/git-rules-review init
bin/git-rules-review check --command "gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:\"x\"}) { thread { id } } }'"
```

## CI gate rules

1. **No push or GitHub post, no check.** Only a push or a GitHub write (`gh pr|issue|release` post, a
   writing `gh api`) in this session arms the guard. A session that only reads code never runs git or
   `gh` at stop time. A post records the current branch when `refs/heads/<branch>` equals
   `refs/remotes/origin/<branch>`.
2. **Record exact SHAs.** After `git push`, `gh stack push|submit|link`, `git-sign-batch` (without
   `--dry-run`/`--no-push`), or a GitHub write command, record the branch and its SHA, but only when
   `refs/heads/<branch>` equals `refs/remotes/origin/<branch>`. No fetch.
3. **Check only those commits.** Read check runs and statuses per recorded SHA, not per PR head. A newer
   commit from someone else on the branch does not change the verdict. A recorded commit the branch no
   longer contains (amended, re-signed, force-pushed) is dropped without a CI lookup.
4. **Clear when proven.** When every recorded SHA passes, delete the state file.
5. **One delivery per commit.** A failing or pending check blocks the stop with every failing check,
   its URL and the PR number, exactly once per pushed commit, ever (`stop_hook_active` also stops a
   repeat in the same turn). The commit is recorded in `budget/`, beside the state file, so a passing
   gate that deletes the state cannot re-arm it; a later stop on the same commit only notifies. A
   genuinely new commit blocks once more. Pending says "CI pending on `<branch>@<sha7>`". opencode and
   the v2 server nudge the same way. Every nudge and every stop block starts with `[task-gh-guard]`, so
   the source is obvious. The rules behind this are in AGENTS.md, "Plugin loop safety".

State lives in `~/.agents/state/task-gh-guard/<runtime>-<session_id>.json`.

A `gh` call that returns `Bad credentials` (an exported `GH_TOKEN` that has expired) is retried once
with `GH_TOKEN` and `GITHUB_TOKEN` removed, so gh's own keyring auth is used and a stale token cannot
wedge a session. The judge subprocess retries once on a transport or socket drop.

Claude Code also runs `src/claude/session-end.ts`: when a session ends with CI still red or pending, it
sends a desktop notification, so an interrupted or abandoned turn is not silent. opencode has no
session-end event; its nudge is the equivalent.

## Plugin hygiene

`scripts/plugin-hygiene.ts` scans every package source for the failure classes we have hit, and
`test/plugin-hygiene.test.ts` fails the build when one comes back: a `*_CHILD` env marker that
disables a plugin outside its own judge directory, a `gh` call without the stale-token fallback, a
judge subprocess without a transient retry, and a judge or review timeout below 120 seconds. CI runs
it in the root test job and runs both packages with `bun test` in the `Plugin packages (bun)` job.

## Install

Claude Code: add this repository as a marketplace, then install the plugin. After a change, bump
`version` in `.claude-plugin/plugin.json` and run `claude plugin update task-gh-guard@agents-plugins`.

```bash
claude plugin marketplace add <path-to-this-repo>
claude plugin install task-gh-guard@agents-plugins
```

opencode: add the package directory to `plugins` in `~/.config/opencode/opencode.json`, then restart
opencode. opencode 2.x (2.0.29 and the desktop app's 2.2.5) loads `server.ts` through `package.json` `main`. The entry must be the directory, not a file. opencode 1.x needs the file entry `src/opencode/plugin.ts`.

```json
"plugins": ["/absolute/path/to/agents-plugins/packages/task-gh-guard"]
```

Claude Code runs the hooks in `hooks/hooks.json` with `bun`: `src/claude/review.ts` before a Bash call,
`src/claude/record.ts` after one, `src/claude/stop.ts` at Stop, and `src/claude/session-start.ts` for the
rules config. Each command prefixes PATH with the usual Bun install locations so a hook still finds `bun`.

Requires `bun`, `git` and `gh` (authenticated) on PATH.

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
```

The suite uses a real temp git repo with a bare origin, a fake `gh` and a fake `opencode` on PATH.
