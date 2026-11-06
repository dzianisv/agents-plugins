# shared

TypeScript code that more than one package uses. Each package links it as `src/shared` (a symlink to
`../../shared/src`). Claude Code replaces the symlink with the real files when it installs a plugin, and
opencode loads the package straight from the repo, so both see the same source.

## notify

`notify(title, message, { client })` raises a desktop notification (`osascript`
on macOS, `notify-send` on Linux). With an opencode v1 `client` it also shows a toast. The same message shows
once per 10 minutes, so a failure that repeats every turn does not spam.

| Variable | Effect |
| --- | --- |
| `AGENTS_NOTIFY=0` | Turn it off |
| `AGENTS_NOTIFY_CMD` | Run this command instead; title and message are appended as arguments |
| `AGENTS_NOTIFY_WINDOW` | Seconds before the same message may show again (default 600) |
| `AGENTS_NOTIFY_STATE_DIR` | Dedupe state, default `~/.agents/state/notify` |

Test: `bun test packages/shared`.
