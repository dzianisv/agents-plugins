# opencode-auto-limit-resume Plugin

## Overview

When a session dies because the model hit a usage or rate limit, this plugin
continues the session instead of leaving it dead:

| Failure | Action |
|---|---|
| Free-tier limit (`provider.free-limit`, "Free usage limit reached") | switch to the configured fallback model and resume immediately |
| Quota / 429 / overloaded | retry the same model with backoff; switch model after `switchAfterAttempts` failures |
| Auth, not-found, stale client | ignored |

File name is kept as `opencode-auto-limit-nudge.ts` for install compatibility.
The plugin id is `opencode-auto-limit-resume`.

## Why the previous version did nothing

The old plugin only retried the same model after 90s settle + 60s backoff. Two
real incidents on this machine:

- **2026-11-08 20:28** — failure, opencode's own retry succeeded 9ms later. No
  resume was needed; the plugin cleared its state correctly.
- **2026-11-09 07:19** — the free model hit its limit. The plugin armed a resume
  for +150s, but the user switched the model and re-sent the message 25s later.
  The old code treated any `session.execution.started` as "user took over" and
  cancelled the pending resume. Nothing resumed, and the debug trail contained
  only `failure` — no reason for the cancel.

Retrying the same exhausted free model is futile anyway. The fix is to fail
over to a working model within seconds, and to stop cancelling on `started`.

## Trigger

`session.execution.failed` with an error classified as a limit:

- `error.type` is `provider.quota`, `provider.rate_limit`, or `provider.free-limit`
- or `response.status_code` is 429/529
- or the message matches `/usage limit|rate limit|quota|too many requests|429|overloaded|capacity|try again in/`

Permanent errors are skipped: auth failures and
`"This version of OpenCode Desktop no longer supports free models"`.

Verified against opencode 2.2.5. A real failure event looks like:

```json
{
  "type": "session.execution.failed",
  "data": {
    "sessionID": "ses_...",
    "error": {
      "type": "provider.quota",
      "message": "Free usage limit reached. ...",
      "response": { "status_code": 429, "body": "{...}", "headers": { "...": "..." } }
    }
  }
}
```

## Behavior

1. **Record.** The failure is written to `state.json` (session, failed model,
   attempts, next attempt time) and to `events.jsonl`.
2. **Settle.** After `settleMs` (default 10s) of quiet, the plugin checks the
   session with `ctx.session.get`. A busy session is retried later; a
   succeeded/interrupted session clears the pending work. `started` never
   cancels a pending resume.
3. **Fail over.** On a free-tier limit, or after `switchAfterAttempts`, the
   plugin calls `ctx.session.switchModel({ sessionID, model: { id, providerID } })`
   with the first fallback that is not the model that just failed.
4. **Resume.** It then calls
   `ctx.session.prompt({ sessionID, text, delivery: "queue", metadata: { autoResume: true } })`
   with a `[auto-resume]` continuation message.
5. **Persist.** Pending work survives plugin reload, location teardown, and
   server restart: it is written to disk and restored on the next `setup`.
   A watchdog (`watchdogMs`, default 15s) re-arms anything overdue.
6. **Stop.** Clears on success or interruption; gives up after `maxAttempts` or
   `maxWindowMs`; does not schedule a retry when the provider reset is further
   out than the window.
7. **Cross-process guard.** A pending entry carries a short-lived claim, so two
   server processes do not both prompt the same session.

## Configuration

`~/.config/opencode/auto-limit-resume.json` (read at load and refreshed on each
failure; the legacy `opencode-auto-limit-nudge.json` is still read as fallback):

```json
{
  "enabled": true,
  "notify": true,
  "maxAttempts": 40,
  "baseDelayMs": 60000,
  "maxDelayMs": 1800000,
  "maxWindowMs": 86400000,
  "settleMs": 10000,
  "respectProviderReset": true,
  "toastDurationMs": 6000,
  "fallbackModels": ["opencode-go/deepseek-v4.1-flash"],
  "switchAfterAttempts": 2,
  "watchdogMs": 15000
}
```

- `fallbackModels` — `providerID/modelID` strings, tried in order. The model
  that just failed is skipped. Empty means retry the same model only.
- `switchAfterAttempts` — after how many non-free-limit failures to switch.
- Kill switch: `OPENCODE_AUTO_LIMIT_RESUME_DISABLED=1`.
- Test overrides: `OPENCODE_AUTO_LIMIT_RESUME_DIR` (state/log directory) and
  `OPENCODE_AUTO_LIMIT_RESUME_CONFIG` (config path).

Default policy in plain terms: a free-tier limit is continued on the fallback
model within ~10s; a transient 429 is retried on the same model after 60s,
doubling to 30 min, and switches model after two failures.

## Debug trail

`~/.cache/opencode-auto-limit-resume/events.jsonl`:

| event | meaning |
|---|---|
| `setup` | plugin loaded; includes how many pending resumes were restored |
| `failure` | limit classified; `action` is `switch-model` or `retry-same-model` |
| `armed` | timer set for a resume |
| `activity` | a run started; pending work is kept |
| `hold` | attempt deferred (`busy`, `session-get-failed`, `claimed-elsewhere`) |
| `switch` | session model changed |
| `prompt` | continuation prompt admitted |
| `prompt-failed` | prompt/switch failed; retrying with backoff |
| `clear` | pending work removed, with reason (`succeeded`, `interrupted`, `attempts`, ...) |
| `give-up` | stopped, with reason (`attempts`, `window`, `reset-too-far`) |
| `dispose` | plugin instance unloaded; pending state stays on disk |

`~/.cache/opencode-auto-limit-resume/state.json` holds the pending resumes.

## Files

- `opencode-auto-limit-nudge.ts` — plugin implementation (default export only)
- `opencode-auto-limit-nudge.test-helpers.ts` — pure-logic mirror for unit tests
- `test/opencode-auto-limit-nudge.test.ts` — classification/delay unit tests
- `test/opencode-auto-limit-nudge.state.test.ts` — state machine against a fake v2 host
- `test/e2e-auto-limit-resume.mjs` — end-to-end against the real opencode binary

## Verification

```bash
npm test                                   # full suite
npx jest test/opencode-auto-limit-nudge.state.test.ts --runInBand
npm run test:auto-limit                    # real opencode + fake provider
```

`npm run test:auto-limit` starts a real `opencode serve`, points it at a local
OpenAI-compatible server that returns 429 and then streams a completion, and
asserts: free-limit recorded, model switched to the fallback, continuation
prompt admitted, resumed run completed, pending state cleared. A second
scenario serves 429 forever and asserts a clean give-up with no hang.

Last run (`2026-11-10`):

```
PASS fake provider served the fallback model :: model-a,model-a,model-b,model-b
PASS free-limit failure recorded
PASS model switch recorded
PASS auto-resume prompt recorded
PASS resumed run completed
PASS pending state cleared after success
PASS run terminated instead of hanging :: 498ms
PASS give-up after attempt cap
PASS failure surfaced to the user
ALL PASS
```

Full suite: 404 passed, 20 skipped; `tsc --noEmit` clean.
