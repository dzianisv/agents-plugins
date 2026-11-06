# shared

Code that more than one package uses. A Claude Code plugin ships only its own directory, so each package
carries a copy; this directory is the source of truth.

| File | Copied to | Used by |
| --- | --- | --- |
| `notify.py` | `<package>/claude/notify.py` | turn-check, task-gh-guard |
| `notify.ts` | `<package>/opencode/notify.ts` | turn-check, task-gh-guard |

After editing, run `scripts/sync-shared.sh`. `scripts/sync-shared.sh --check` fails when a copy differs, and
the shared tests run it. To give a package a copy, add it to `packages` in the script.

## notify

`notify(title, message)` prints one line to stderr and raises a desktop notification (`osascript` on macOS,
`notify-send` on Linux). The TypeScript version also shows an opencode toast when given a v1 `client`. The
same message shows once per 10 minutes, so a failure that repeats every turn does not spam.

| Variable | Effect |
| --- | --- |
| `AGENTS_NOTIFY=0` | Turn it off |
| `AGENTS_NOTIFY_CMD` | Run this command instead; title and message are appended as arguments |
| `AGENTS_NOTIFY_WINDOW` | Seconds before the same message may show again (default 600) |
| `AGENTS_NOTIFY_STATE_DIR` | Dedupe state, default `~/.agents/state/notify` |

Tests: `python3 -m unittest discover -s packages/shared` and `bun test packages/shared`.
