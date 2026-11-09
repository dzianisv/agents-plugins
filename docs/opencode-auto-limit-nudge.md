# opencode-auto-limit-resume Plugin

## Overview

When a session dies because the model hit a usage or rate limit, this plugin
waits and then re-prompts the session so the interrupted task keeps going. It
also toasts the schedule in the TUI when one is available.

File name is kept as `opencode-auto-limit-nudge.ts` for install compatibility.
The plugin id is `opencode-auto-limit-resume`.

## Trigger

`session.execution.failed` with an error classified as a limit:

- `error.type === "provider.quota"` or `"provider.rate_limit"`
- or `response.status_code` 429/529
- or the message matches `/usage limit|rate limit|quota|too many requests|429|overloaded|capacity|try again in/`

Permanent errors are ignored: auth failures, and
`"This version of OpenCode Desktop no longer supports free models"`.

Verified against opencode 2.2.5. A real failure event looks like:

```json
{
  "type": "session.execution.failed",
  "data": {
    "sessionID": "ses_...",
    "error": {
      "type": "provider.quota",
      "message": "The usage limit has been reached",
      "response": { "status_code": 429, "body": "...resets_at...", "headers": { "...": "..." } }
    }
  }
}
```

## Behavior

1. **Settle check.** opencode may still be retrying when the failure lands. On
   every failure the plugin restarts a `settleMs` timer; only when the session
   stays quiet for that long does it arm a resume.
2. **Delay.** If the provider reported a reset time (`resets_at`,
   `resets_in_seconds`, `retry-after`, `x-codex-primary-reset-*`, or
   `try again in 5m` in the message) the plugin wakes just after it. Otherwise
   it backs off exponentially from `baseDelayMs` to `maxDelayMs`.
3. **Resume.** Waits for the session to go idle, then calls
   `ctx.session.prompt({ sessionID, text, delivery: "queue", metadata: { autoResume: true } })`
   with a `[auto-resume]` continuation message.
4. **Stop conditions.** Clears everything when a run succeeds, when the user
   starts their own run (`session.execution.started` cancels the timer), after
   `maxAttempts`, after `maxWindowMs`, or when the provider reset is further out
   than `maxWindowMs`.
5. **Give-up toast** names the model and the reason.

State is kept in a process-wide registry, so a hot reload (opencode loads the
plugin once per config) cannot create duplicate timers. The last loaded
instance owns the registry.

Debug trail: `~/.cache/opencode-auto-limit-resume/events.jsonl`
(`failure`, `armed`, `resume`, `resume-failed`, `give-up`, `skip`).

## Configuration

`~/.config/opencode/auto-limit-resume.json` (read at load and refreshed on each
failure; the legacy `opencode-auto-limit-nudge.json` is still read as a
fallback):

```json
{
  "enabled": true,
  "notify": true,
  "maxAttempts": 40,
  "baseDelayMs": 60000,
  "maxDelayMs": 1800000,
  "maxWindowMs": 86400000,
  "settleMs": 90000,
  "respectProviderReset": true,
  "toastDurationMs": 6000
}
```

Kill switch: `OPENCODE_AUTO_LIMIT_RESUME_DISABLED=1`.

Defaults in plain terms: first resume ~2.5 min after the failure (90s settle +
60s backoff), then doubling up to 30 min, at most 40 attempts within 24h. An
OpenAI weekly limit that reports a reset 2 days out is not scheduled at all; the
toast says so.

## Files

- `opencode-auto-limit-nudge.ts` — plugin implementation (default export only)
- `opencode-auto-limit-nudge.test-helpers.ts` — pure-logic mirror for unit tests
- `test/opencode-auto-limit-nudge.test.ts` — unit tests

## Verification performed

- Unit: `npx jest test/opencode-auto-limit-nudge.test.ts` (23 tests).
- Live, against opencode 2.2.5 and an exhausted OpenAI plan:
  failure -> settle -> armed -> resume -> failure -> backoff -> give-up at the
  attempt cap.
- Live success path: fail on `openai/gpt-6.1-terra`, switch the session to
  `opencode/deepseek-v4.1-flash-free` while the retry is armed. The plugin
  resumed, the run completed (`idle succeeded`), and no further retries were
  scheduled.
