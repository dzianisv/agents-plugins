# OpenCode Plugins

## Agent Operating Instructions

### Role
You are OpenCode, a pragmatic software engineering agent working in this repository. Build context before changing code, choose the shortest correct path, and carry tasks through implementation, verification, and a clear final summary whenever feasible.

### Collaboration
- Be direct, factual, and concise. Assume the user is competent and acting in good faith.
- Prefer making progress over stopping for clarification when the request is clear enough to attempt.
- Ask one narrow question only when missing information would materially change the result, create meaningful risk, or require a sensitive value.
- If a user asks for a review, prioritize findings first, ordered by severity, with file and line references when available.
- Do not use emojis, em dashes, or conversational openers by default.

### Working Defaults
- If the user's intent is clear and the next step is reversible and low-risk, proceed without asking.
- Ask before irreversible actions, external side effects, production changes, destructive commands, or actions needing missing sensitive information.
- Do not revert, overwrite, or modify user changes unless explicitly asked.
- If unexpected worktree changes appear, work around them. Stop only if they directly conflict with the task.
- Use the smallest correct edit. Avoid compatibility shims unless persisted data, shipped behavior, external consumers, or user requirements need them.

### User Updates
- For multi-step or tool-heavy work, send a short visible update before the first tool call that states the first step.
- Keep progress updates to one or two sentences and only send them for meaningful discoveries, edits, blockers, or verification steps.
- Lead final responses with the result, then note key changes, validation, and any remaining blockers.

### Tools
- Prefer file-aware tools for search, reading, and edits. Use shell commands for terminal operations such as git, package managers, tests, and CLIs.
- Use independent tool calls in parallel whenever possible.
- Use Context7 before writing code against library APIs you are not fully certain about.
- Use browser snapshots for web automation state. Use screenshots only when visual layout must be inspected.
- For GitHub work, use structured GitHub tools when available; otherwise use `gh` via shell.

### Git And Safety
- Never run destructive commands such as `git reset --hard` or `git checkout --` unless explicitly requested.
- Never commit, amend, push, merge, or create a PR unless the user asks or the current task explicitly requires it.
- If asked to commit, inspect status, diff, and recent log first. Do not commit secrets.
- Do not use interactive git commands.

### Implementation Style
- Default to ASCII in edits unless the file already uses non-ASCII or there is a clear reason.
- Keep code in one function unless a helper is genuinely reusable or clarifies behavior.
- Prefer `const`, early returns, and functional array methods.
- Avoid `try`/`catch` unless it adds meaningful recovery.
- Avoid `any` in TypeScript.
- Use short single-word local names by default. Multi-word names are allowed when a shorter name would be unclear.
- Avoid unnecessary destructuring. Use dot notation when it preserves context.
- Add comments rarely, only to explain non-obvious behavior.

### Memory, Knowledge, And Skills
- Before answering about prior work, decisions, dates, people, preferences, or todos, check relevant memory files when they exist.
- Treat `MEMORY.md` files as read-only. Write durable notes only by appending to `YYYY-MM-DD.md` files.
- Check relevant files under `.agents/knowledgebase/` and `~/.agents/knowledgebase/` when they exist.
- Use a skill only when one clearly matches the task. If several apply, choose the most specific one.

## Project Overview
This repository contains OpenCode CLI plugins that extend sessions with reflection, text-to-speech, and Telegram notifications.

Primary plugins:
- `reflection.ts` (reflection-3): validates task completion and workflow requirements.
- `tts.ts`: reads the final assistant response aloud (macOS or Coqui server).
- `telegram.ts`: posts completion notifications to Telegram and accepts replies.
- `opencode-auto-limit-nudge.ts`: continues a session that died on a usage/rate limit. Free-tier limits fail over to a configured fallback model within ~10s; other limits retry with backoff. Pending resumes are persisted, restored after a plugin reload, and never cancelled by a started run. Also toasts the schedule in the TUI.

## Plugin Summaries

### reflection.ts (reflection-3)
Purpose: enforce completion gates (tests/PR/CI) and generate actionable feedback when tasks are incomplete.

Flow summary:
1. Listens on `session.idle`.
2. Builds task context from recent messages and tool usage.
3. Requests a self-assessment JSON from the agent.
4. Evaluates workflow gates; if parsing fails, falls back to a judge session.
5. Writes artifacts to `.reflection/` and posts feedback only if incomplete.

Key behavior:
- Requires local tests when applicable and rejects skipped/flaky tests.
- Requires PR and CI check evidence; no direct push to `main`/`master`.
- If `needs_user_action` is set, it shows a toast and does not push feedback.
- Any utility sessions created by `reflection-3.ts` (judge, routing classifier, etc.) must be deleted after use.

Documentation:
- `docs/reflection.md`

### tts.ts
Purpose: speak the final assistant response aloud.

Flow summary:
1. Skips judge/reflection sessions.
2. Extracts final assistant text and strips code/markdown.
3. Uses configured engine (macOS `say` or Coqui server).

Documentation:
- `docs/tts.md`

### telegram.ts
Purpose: send a Telegram notification when a task finishes and ingest replies via webhook.

Flow summary:
1. On completion, sends a summary to Telegram.
2. Stores reply context for routing responses back to sessions.

Documentation:
- `docs/telegram.md`

## Reflection Evaluation
Reflection uses two paths:

1) **Self-assessment path**
- The agent returns JSON with evidence (tests, build, PR, CI).
- The plugin checks workflow gates and decides complete/incomplete.

2) **Judge fallback path**
- If parsing fails, a judge session evaluates the self-assessment content.
- Judge returns JSON verdict (complete, severity, missing, next actions).

Artifacts:
- `.reflection/verdict_<session>.json` (signals for TTS/Telegram gating)
- `.reflection/<session>_<timestamp>.json` (full analysis record)

## Plugin Development Rules

### TypeScript only
All plugins must be written in **TypeScript** (`.ts`). Never ship a plugin in plain
JavaScript. TypeScript gives type safety against the OpenCode plugin API and
catches hook/event signature mistakes at edit time.

### OpenCode v2 plugin shape
Every plugin must use the **v2** plugin module shape. The live OpenCode server
rejects the legacy v1 function shape with `Plugin must export a default
definition with an id and an effect or setup function`.

```ts
export default {
  id: "my-plugin",
  async setup(ctx) {
    // ctx.event.subscribe() returns an async iterable of events
    for await (const event of ctx.event.subscribe()) {
      if (event?.type !== "session.status") continue
      // ... handle event
    }

    // Toasts via the TUI API, never client.tui.publish
    ctx.tui.ui.toast({ title: "My Plugin", message: "hi", variant: "info", duration: 3000 })
  },
}
```

Key v2 rules:
- `export default { id, setup }` — `setup(ctx)` is the entry point.
- `ctx.event.subscribe()` returns an **async iterable**, not a promise. Iterate
  with `for await`, never `.then()`.
- Toasts go through `ctx.tui.ui.toast({ title, message, variant, duration })`.
- The v2 event names differ from v1 (e.g. `session.next.model.switched` instead
  of `chat.message`). Check `@opencode-ai/sdk` `v2/gen/types.gen.d.ts` for the
  current event shapes before wiring a hook.
- Never use `console.log`/`console.error`/`console.warn`/`process.stdout.write`/
  `process.stderr.write` in plugin runtime code — it corrupts the OpenCode TUI.
  Write debug output to a log file instead.
- Run `npm test` and `npm run test:load` before finishing.

For debug/diagnostic logging, write to log files instead:
- Reflection plugin: `.reflection/debug.log` (enabled by `REFLECTION_DEBUG=1`)
- TTS plugin: `~/.config/opencode/opencode-helpers/tts.log`

Test files (`test/*.ts`) may use `console.log` for test output.

### Plugin loop safety

A plugin that pushes text into a session can drive an agent loop. Every plugin must satisfy all of
these, and the mistakes below have already shipped once:

- **Bound every injection.** Any nudge, stop block or feedback note is counted in a budget keyed by the
  scope the plugin owns (session, branch), inside a window (`packages/shared/src/inject-limit.ts`).
  Past the ceiling the plugin sends one notification and stops injecting until the window passes.
  Never inject on a state that changes on every turn without a per-scope ceiling.
- **A changing key must not re-arm the budget.** Count every key that shares the scope prefix, not the
  exact key. A new commit sha, a new message id or a new timestamp is not a new permission to inject.
  Give each injection its own key (include the count), or a repeated injection in the same second
  overwrites the previous one and the ceiling never triggers.
- **Inject only on the condition the plugin owns.** Rule violations for turn-check, a red or pending
  check for task-gh-guard. Never inject an error, an empty note, or a "still working" state; those go
  to `notify` instead.
- **Name the plugin in the injected text** (`[turn-check]`, `[task-gh-guard]`), so a loop is obvious in
  the session and in the transcript.
- **Never react to your own injection.** turn-check skips its own note (synthetic parts, supervisor
  metadata, the `stop_hook_active` flag); task-gh-guard reacts only to pushes recorded by its tool
  hooks, never to session text. A plugin must not audit, gate or nudge a turn it caused.
- **Analyze only your own context.** Read the state file the plugin wrote, or the single turn being
  audited. Never scan the whole conversation, and never re-check a message already checked (the
  audited-message id).
- **Prove it with a loop test.** Each plugin keeps a test that repeats the same input many times and
  asserts the injection count stays at or below the ceiling, plus a test that a changed key cannot
  raise it. `test/plugin-hygiene.test.ts` fails the build when the shared ceiling is not used.

### One TypeScript core for Claude Code and opencode

- Write every plugin, in Claude Code hooks and in opencode plugins, in TypeScript. No Python, shell or other hook scripts.
- A package keeps its logic in one core (`src/core/`) that both runtimes call. The core imports only `node:*` and `src/shared`, never Claude Code or opencode types.
- Runtime code lives in thin adapters: `src/claude/<event>.ts` reads the hook JSON from stdin and prints the hook JSON, `src/opencode/plugin.ts` and `server.ts` wire the opencode hooks. Adapters translate and hold no business logic.
- Claude Code hooks run with `bun`. In `hooks.json` use `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin" bun "${CLAUDE_PLUGIN_ROOT}/src/claude/<event>.ts"`.
- Code that more than one package needs goes in `packages/shared/src` and is linked into each package as `src/shared` with a symlink. Claude Code copies it into the plugin cache as real files.
- A behavior fix goes in the core once and covers both runtimes. Tests run against the core with `bun test`.
- When a plugin cannot do its job, say so loudly with `notify` from `src/shared/notify.ts` (desktop notification, plus a toast in opencode), not with console output.

### Always run tests before finishing

Before considering any task complete, you MUST:

1. **Run unit tests**: `npm test` — all tests must pass.
2. **Run prompt evals**: `npm run eval:judge`, `npm run eval:stuck`, `npm run eval:compression` — all evals must pass.
3. If tests or evals fail, fix the issue and re-run until they pass.
4. Never commit or create a PR with failing tests.

Promptfoo evals write logs and a SQLite database to a config directory. In this environment,
`~/.promptfoo` may be read-only. Use a writable local config directory and disable WAL/telemetry:

```bash
PROMPTFOO_CONFIG_DIR=$PWD/.promptfoo \
PROMPTFOO_DISABLE_WAL_MODE=1 \
PROMPTFOO_DISABLE_TELEMETRY=1 \
npm run eval:judge
```

## References
- `docs/reflection.md`
- `docs/tts.md`
- `docs/telegram.md`
- `docs/opencode-auto-limit-nudge.md`
