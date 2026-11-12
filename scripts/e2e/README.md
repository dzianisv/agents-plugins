# Plugin end-to-end tests in containers

Every plugin gets a real-runtime test in a clean container: install the plugin the way a user does,
start the runtime, run one cheap prompt, and check that the plugin did its job. Unit tests cover the
core; this covers loading, packaging and the real runtimes. Design: [`docs/e2e-containers.md`](../../docs/e2e-containers.md).

## Run it

```bash
bun scripts/e2e/run.ts --plugin gh-guard --plugin agents-md-guard --runtime all
# or: npm run e2e:containers -- --plugin agents-md-guard --runtime opencode
```

| Flag | Meaning |
| --- | --- |
| `--plugin <name>` | Run only this plugin; repeatable; defaults to every package with `e2e/spec.ts` |
| `--runtime claude\|opencode\|all` | Which runtime(s) to run; default `all`; each spec runs only the runtimes it declares |
| `--timeout <seconds>` | Per-container wall-clock limit; default `300` |
| `--keep` | Keep the out dir (result JSONs and container output) and print its path |
| `--no-build` | Use the existing image even when the Dockerfile hash changed |

The runner builds one image (`agents-plugins-e2e:local`, rebuilt when the Dockerfile/entrypoint hash
changes), exports auth into a `mktemp -d` (0700) directory, runs one `--rm` container per plugin and
runtime (`--cpus 2 --memory 2g --pids-limit 512`), prints a results table and exits non-zero when any
check fails. Temp dirs and containers are removed in a `finally` and on Ctrl-C.

Unit tests (no docker, no network): `bun test scripts/e2e`.

## Auth

`scripts/e2e/auth.ts` writes the container auth layout into the temp dir; the entrypoint copies it
into the container's fresh `$HOME`. The user's `~/.claude`, `~/.config/opencode`, `~/.agents` and
`~/.env` are never mounted, and no secret is printed, logged or passed on a command line.

| Host source | In the temp dir | Container path |
| --- | --- | --- |
| `~/.config/opencode/opencode.json`, only the `provider["fireworks-ai"]` block | `opencode.json` (0600) | `$HOME/.config/opencode/opencode.json` |
| `~/.local/share/opencode/auth.json` | `auth.json` (0600) | `$HOME/.local/share/opencode/auth.json` |
| macOS keychain `Claude Code-credentials`, or `~/.claude/.credentials.json` on Linux | `claude/.credentials.json` (0600) | `$HOME/.claude/.credentials.json` |
| `CLAUDE_CODE_OAUTH_TOKEN` when set (wins over the keychain) | `claude/oauth-token` (0600) | exported as `CLAUDE_CODE_OAUTH_TOKEN` |

## Container layout

| Path | Mount | Purpose |
| --- | --- | --- |
| `/src` | repo, read-only | the driver copies it to `/work/agents-plugins` (minus `node_modules`, `.git`) |
| `/work` | temp dir | the writable repo copy the runtimes use |
| `/out` | temp dir | result JSONs, the notify recorder log, the driver's output |
| `/auth` | auth temp dir, read-only | copied into `$HOME` by `entrypoint.sh` |

The runtime environment also gets `AGENTS_NOTIFY_CMD=bun …/notify-recorder.ts` and
`E2E_NOTIFY_LOG=/out/notify-…log`, so a check can prove no `notify` fired.

## What the checks rely on (verified on Claude Code 2.1.283 and opencode 2.0.29)

| Runtime | What | Where | Fields used |
| --- | --- | --- | --- |
| Claude Code | plugin loaded | `system`/`init` event of `--output-format stream-json` | `plugins[].name`, `plugins[].source` = `<plugin>@<marketplace>` |
| Claude Code | hooks fired | `system`/`hook_response` events (`--include-hook-events`) | `hook_event`, `outcome` = `success` |
| Claude Code | install | `claude plugin marketplace add <dir>` + `claude plugin install <plugin>@<name>` | `claude plugin list` shows the plugin `enabled` |
| Claude Code | auth | `~/.claude/.credentials.json` | `security find-generic-password -s "Claude Code-credentials" -w` on macOS |
| Claude Code | not emitted | `SessionEnd` hook events are never emitted by headless `claude -p` runs | `agents-md-guard` declares it, the driver skips it |
| opencode | plugin loaded | `$HOME/.local/share/opencode/log/opencode.log` | `msg="loading plugin" id=<plugin dir> entrypoint=file://<plugin dir>/server.ts` |
| opencode | no plugin error | same log | no `level=ERROR` and no `message="failed to load plugin"` line mentioning the plugin dir (a bad v2 default export fails at WARN) |
| opencode | v2 entry only | same log | opencode 2.0.29 loads `server.ts`, never the v1 `src/opencode/plugin.ts` |
| opencode | auth | minimal `opencode.json` provider block | `opencode models` resolves `fireworks-ai/…` |

Notes the checks were written against:

- `claude -p` must receive the prompt before the variadic `--allowedTools` flag, or the flag eats it.
- `--allowedTools "Bash(git commit:*)"` is what lets the gh-guard spec run the commit.
- opencode runs a managed background service (default port 49374); server logs go to the log file,
  not to `--print-logs` stderr. The driver reads the file.
- opencode 2.0.29 resolves the session directory from `$PWD`, not the process cwd; the driver sets
  `PWD` to the run cwd or the agent's shell lands in the image's `/work`.
- In opencode v2 the plugin runs in the service process, so the audit continues after `opencode run`
  returns; the driver polls `audits.jsonl` for it.

## Specs

A plugin's `packages/<plugin>/e2e/spec.ts` exports `defineSpec({...})` from
[`scripts/e2e/spec.ts`](spec.ts):

```ts
export default defineSpec({
  plugin: "agents-md-guard",
  runtimes: ["claude", "opencode"],
  prompt: "Reply with the single word OK.",
  claude: { maxTurns: 2, allowedTools: ["Bash(git commit:*)"] }, // optional
  env: { OPENCODE_SESSION_INDEX_IDLE_MS: "5000" }, // optional runtime env; the notify vars win
  setup: (ctx) => { /* prepare container state; return the runtime cwd */ },
  checks: [{ name: "audit logged a verdict", run: (ctx) => ({ ok: true }) }],
})
```

Every case also asserts the runtime exited 0, the plugin loaded, its declared hooks fired (Claude
Code) and no `notify` fired; the spec adds the plugin-specific "works" checks.
