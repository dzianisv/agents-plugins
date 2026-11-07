# opencode-auto-limit-nudge Plugin

## Overview

The `opencode-auto-limit-nudge` plugin warns the user (via a TUI toast) when
the currently-used model hits a rate/usage limit and is expected to reset. It
does **not** nudge the session itself when the limit resets — the session
retries automatically; only the user gets a heads-up so they can plan around
the downtime.

## Trigger

Fires on the `session.status` event with `status.type === "retry"`. OpenCode
emits this whenever a provider returns a retryable error (HTTP 429, quota
exceeded, etc.), along with `attempt`, `message`, and `next` (the retry
timestamp).

The active model is tracked from the `session.next.model.switched` event so
the toast names it explicitly (e.g. `deepseek/deepseek-v4.1-flash:free`).

## Behavior

- Toast is `warning` variant, 5s duration by default.
- Debounced per session: no repeat nudge within 60s.
- Skips silently when disabled (`OPENCODE_AUTO_LIMIT_NUDGE_DISABLED=1` or
  `enabled: false`).
- `includeModel: false` suppresses the model name from the toast.
- `includeResetHint: false` suppresses the estimated reset time.

## Configuration

`~/.config/opencode/opencode-auto-limit-nudge.json`:

```json
{
  "enabled": true,
  "toastDurationMs": 5000,
  "suppressMs": 60000,
  "includeResetHint": true,
  "includeModel": true
}
```

## Files

- `opencode-auto-limit-nudge.ts` — plugin implementation (default export only)
- `opencode-auto-limit-nudge.test-helpers.ts` — pure-logic duplicates for unit testing
- `test/opencode-auto-limit-nudge.test.ts` — unit tests