# opencode-reflection

An [OpenCode](https://opencode.ai) plugin: a reflection/judge layer that verifies task completion and
forces the agent to continue until the work is actually done.

After each agent turn it asks a judge model to self-assess the turn against workflow gates (tests,
build, PR, CI), and when the work is incomplete it pushes targeted, escalating feedback back into the
session. A complete verdict is written to `.reflection/verdict_<session>.json`.

## Install

OpenCode v1 (single file):

```bash
cp reflection-3.ts ~/.config/opencode/plugin/reflection.ts
```

OpenCode v2 loads the package's `server.ts`; add the directory to `plugins`:

```json
{ "plugins": ["/path/to/agents-plugins/packages/reflection"] }
```

## Configuration

- `~/.agents/plugins/reflection/model` — one `provider/model` line, the same file every judge plugin
  reads (`gh-guard`, `agents-md-guard`). When present it wins; comments with `#` and blank lines are
  ignored; `AGENTS_PLUGINS_HOME` moves the base directory.
- `~/.config/opencode/reflection.yaml` — fallback `models:` list of judge model specs (weak models such as
  `haiku`, `mini`, `flash` are rejected), and an optional `routing:` block. Used when the model file is
  absent.
- `.reflection.md` / `reflection.md` in the project overrides the default self-assessment prompt.
- `REFLECTION_DEBUG=1` writes `.reflection/debug.log`.

## Tools

- `set_reflection` — set or clear per-runtime reflection guidance (a plan/checklist for complex work).
- `reflection` — enable or disable the judge for the current session via `.reflection/disabled`.

## Entries

Two entrypoints share the logic:

- **opencode v2** — [`server.ts`](./server.ts) with [`src/core.ts`](./src/core.ts), a `{ id, setup(ctx) }`
  definition. It runs on the `session.execution.succeeded` / `failed` / `interrupted` events, calls the
  judge through `ctx.generate.text`, and pushes feedback with `ctx.session.prompt`.
- **opencode v1** — [`reflection-3.ts`](./reflection-3.ts), the original `Plugin` factory on the
  `session.idle` event. Its pure helpers are imported by the v2 core rather than copied.

Not ported to the v2 entry (the v2 plugin context has no TUI domain and no model-targeted prompt):

- the TUI toasts ("Requesting reflection self-assessment…", "Task complete ✓", …);
- the separate judge, cross-model-review and routing-classification sessions (v2 uses
  `ctx.generate.text` for the judge instead);
- routing the feedback prompt to a task-specific model.
