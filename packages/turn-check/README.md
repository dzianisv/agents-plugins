# turn-check

Plugin for opencode and Claude Code. When the agent stops, a cheap model reads the conversation
and `~/.agents/AGENTS.md`, then lists the rules the agent broke, with quotes. The findings are
delivered immediately: in Claude Code the Stop hook blocks with them, so the agent fixes them in the
same turn; in opencode the plugin prompts the session with a `<system-reminder>`. If that delivery
fails, the note falls back to your next message. An audit error is never delivered as a block, it
waits for the next prompt. Every time findings are delivered you also get a desktop notification
("N rule violation(s): rule; rule"), on both runtimes, never deduplicated; opencode v1 adds a toast.
`AGENTS_NOTIFY=0` turns it off. Design and limits: [DESIGN.md](DESIGN.md).

## When it cannot run

A failed audit (judge exits non-zero, times out, or returns no verdict) raises a desktop notification
and, in opencode, an error toast, through `packages/shared/notify`. In Claude Code the next prompt also
carries a `turn-check ERROR:` note. `AGENTS_NOTIFY=0` turns the notification off.

## Install

Claude Code (needs `bun` and the `opencode` CLI on PATH, the audit runs through it). After any change, bump `version` in `.claude-plugin/plugin.json` and run `claude plugin update turn-check@agents-plugins`:

```bash
claude plugin marketplace add dzianisv/opencode-plugins
claude plugin install turn-check@opencode-plugins
```

opencode: add this directory to `plugins` in `~/.config/opencode/opencode.json`, then restart opencode. Logs show the plugin as `turn-check`.

```
/absolute/path/to/opencode-plugins/packages/turn-check
```

opencode 2.x (2.0.29 and the desktop app's 2.2.5) loads `server.ts` through `package.json` `main`; opencode 1.x needs the file entry `src/opencode/plugin.ts`. v2 rejects config entries that point at a file (`configured plugin path must be a directory`), so the old `.../opencode/plugin.ts` entry no longer works there.

All logic lives in one TypeScript core, `src/core/`, that both runtimes call. Claude Code hooks are thin entrypoints in `src/claude/` (wired by `hooks/hooks.json` with `bun`); the opencode v1 plugin is `src/opencode/plugin.ts` and the v2 entry is `server.ts`.

v2 differences from v1:

- The judge runs as a sessionless `ctx.generate.text` call (system prompt + transcript in one prompt). No audit child sessions, no judge agent, no toast — v2 has no server-side toast API, so a FAIL verdict raises the desktop notification only.
- Audits trigger on `session.execution.succeeded`/`failed`/`interrupted` (v2.0.29 does not emit `session.idle`). The plugin runs in the server process, so headless `opencode run` sessions served by it are audited too; `SUPERVISOR_AUDIT_RUN` is v1-only.
- Feedback is attached via the v2 `context` session hook on the last user message of the turn, re-attached on every step of that turn. A plugin instance only audits sessions from its own project directory.

## Settings (env vars)

| Variable | Default |
|---|---|
| `SUPERVISOR_ENABLED` | `1` (`0` turns it off) |
| `SUPERVISOR_MODEL` | `fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash` |
| `SUPERVISOR_RULES` | `~/.agents/AGENTS.md` |
| `SUPERVISOR_MAX_CHARS` | `60000` |
| `SUPERVISOR_HOME` | `~/.cache/supervisor` (audit log and Claude Code state; directory 0700, files 0600) |

`SUPERVISOR_JUDGE_TIMEOUT` (seconds): judge limit, default `240` in both runtimes.

`SUPERVISOR_AUDIT_RUN=1` (opencode v1 only): audit in a headless `opencode run` too. In v1 the plugin stays off there, because `run` exits at idle and the feedback could never be delivered. In v2 the plugin lives in the server, so `run` sessions are audited regardless and this flag has no effect.

Claude Code only: `SUPERVISOR_SETTLE_SECONDS` (default `2`, lets the transcript file catch up), `SUPERVISOR_CHILD` (set to `1` inside the judge so it never audits itself; do not set it yourself).

Each Claude Code audit starts `opencode run`, which saves a session. The audit titles it `supervisor audit` and deletes it afterwards. The prompt goes to `opencode run` on stdin. The opencode plugin deletes leftover child sessions titled `supervisor audit` older than 5 minutes when it starts; top-level sessions are never deleted.

Every audit is logged to `~/.cache/supervisor/audits.jsonl` (`"agent":"claude-code"` for Claude Code). Entries older than 30 days are removed at opencode plugin start and at Claude Code SessionEnd. In opencode the feedback note is re-added on every step of the turn it was first shown in.

## Test

```bash
bun test
```

Live checks against the real model need `@opencode-ai/sdk` on the module path (for example, symlink
`~/.config/opencode/node_modules` into this folder), and each starts its own opencode server:

```bash
bun test/live.ts        # FAIL on a bad transcript, PASS on a clean one
bun test/live-tools.ts  # tools run for the default agent, are blocked for the judge
```
