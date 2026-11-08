# session-autoreflect

Long-task reflection hook for opencode and Claude Code. After **30 minutes of working time**
in a session, the agent gets a reflection prompt in its context and is told to act on the
answer:

```
AUTOREFLECT: you have been working on this task for a while. Stop and reflect before the next step.

1. What are you doing right now?
2. What is the goal?
3. What is the acceptance criteria?
4. Did you complete the task? If not, what is wrong?
5. Is the implementation plan correct, or does it have to be revisited?
6. Are you moving in the right direction, or is there a better/faster way to resolve the issues and blockers?
7. Can you unblock yourself?

Then act on the answers: take the next concrete step now.
```

Idle sessions are never touched. The clock only runs while an execution is in progress; a gap
longer than `idleResetMs` (10 minutes) starts the next task from zero.

## opencode (v2)

v2 loads a plugin directory through `server.ts`. Add the directory to `plugin` in
`~/.config/opencode/opencode.json` (a directory path, not a file — v2 rejects file paths):

```json
{
  "plugin": ["file:///absolute/path/to/opencode-plugins/packages/session-autoreflect"]
}
```

The plugin loads on the next config reload; no restart needed.

| Variable | Default | Meaning |
|---|---|---|
| `AUTOREFLECT_ENABLED` | `1` | `0` disables the plugin |
| `AUTOREFLECT_INTERVAL_MS` | `1800000` | working time before a reflection |
| `AUTOREFLECT_IDLE_RESET_MS` | `600000` | idle gap that resets the accumulator |
| `AUTOREFLECT_TICK_MS` | `30000` | timer resolution |
| `AUTOREFLECT_INCLUDE_CHILD` | `0` | also reflect inside subagent sessions |
| `AUTOREFLECT_HOME` | `~/.cache/session-autoreflect` | event log directory |

Same keys are accepted in `~/.config/opencode/session-autoreflect.json` (`enabled`,
`intervalMs`, `idleResetMs`, `tickMs`, `includeChild`); env vars win.

Each injection is logged to `$AUTOREFLECT_HOME/events.jsonl` (`armed` when the timer fires,
`inject` when the prompt reaches the model).

## Claude Code

`hooks/hooks.json` registers three hooks:

- `PostToolUse` — accumulates working time and returns `additionalContext` with the prompt.
- `Stop` — the task finished, reset the clock.
- `SessionStart` — reset the clock.

Install from the marketplace:

```bash
claude plugin marketplace add dzianisv/opencode-plugins
claude plugin install session-autoreflect@opencode-plugins
```

Or wire the script directly into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "python3 \"/abs/path/claude/autoreflect.py\" post-tool" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "python3 \"/abs/path/claude/autoreflect.py\" stop" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "python3 \"/abs/path/claude/autoreflect.py\" session-start" }] }]
  }
}
```

State lives in `~/.claude/session-autoreflect/<session_id>.json` (0700/0600). Same env vars
as above.

## Test

```bash
bun test                                        # opencode
python3 -m unittest discover -s claude/tests    # Claude Code
```
