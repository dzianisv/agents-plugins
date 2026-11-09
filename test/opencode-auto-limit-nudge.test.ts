/**
 * opencode-auto-limit-resume Plugin — Unit Tests
 *
 * Tests the pure decision logic without a live OpenCode server. Uses the
 * test-helpers extraction pattern (the plugin file may only export default).
 *
 * Run: npm test
 */

import assert from "node:assert"
import {
  AUTO_RESUME_PREFIX,
  DEFAULTS,
  classifyFailure,
  nextDelayMs,
  parseResetAt,
  resolveConfig,
} from "../opencode-auto-limit-nudge.test-helpers.ts"

const NOW = 1_800_000_000_000

// Real payload captured from opencode 2.2.5 for an exhausted OpenAI plan.
const codexQuotaError = {
  type: "provider.quota",
  message: "The usage limit has been reached",
  response: {
    status_code: 429,
    body: JSON.stringify({
      type: "error",
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_at: 1_800_189_007,
        limit_window_minutes: 10080,
        resets_in_seconds: 189_007,
      },
    }),
    headers: {
      "X-Codex-Plan-Type": "prolite",
      "X-Codex-Primary-Reset-At": "1800189007",
      "X-Codex-Primary-Reset-After-Seconds": "189007",
    },
  },
}

// Captured from opencode free-tier exhaustion.
const freeTierError = {
  type: "provider.quota",
  message:
    "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
}

describe("auto-limit-resume: classifyFailure", () => {
  it("retries provider.quota failures", () => {
    const verdict = classifyFailure(codexQuotaError, NOW)
    assert.strictEqual(verdict.retryable, true)
    assert.strictEqual(verdict.resetsAt, 1_800_189_007_000)
  })

  it("retries free-tier usage limit failures", () => {
    assert.strictEqual(classifyFailure(freeTierError).retryable, true)
  })

  it("retries 429 API errors even without a known type", () => {
    const error = { type: "api.error", message: "Too Many Requests", response: { status_code: 429 } }
    assert.strictEqual(classifyFailure(error).retryable, true)
  })

  it("does not retry auth failures", () => {
    const error = { type: "provider.auth", message: "unauthorized" }
    assert.strictEqual(classifyFailure(error).retryable, false)
  })

  it("does not retry the stale-client free-model error", () => {
    const error = {
      type: "provider.quota",
      message: "This version of OpenCode Desktop no longer supports free models. Update to the latest version.",
    }
    const verdict = classifyFailure(error)
    assert.strictEqual(verdict.retryable, false)
    assert.strictEqual(verdict.reason, "permanent")
  })

  it("does not retry aborted runs", () => {
    assert.strictEqual(classifyFailure({ type: "message.aborted", message: "aborted by user" }).retryable, false)
  })
})

describe("auto-limit-resume: parseResetAt", () => {
  it("reads epoch seconds from the response body", () => {
    const error = { response: { body: JSON.stringify({ error: { resets_at: 1_800_000_600 } }) } }
    assert.strictEqual(parseResetAt(error, NOW), 1_800_000_600_000)
  })

  it("reads relative seconds from response headers", () => {
    const error = { response: { headers: { "retry-after": "120" } } }
    assert.strictEqual(parseResetAt(error, NOW), NOW + 120_000)
  })

  it("reads an inline try-again window from the message", () => {
    const error = { message: "Rate limited, try again in 5m" }
    assert.strictEqual(parseResetAt(error, NOW), NOW + 300_000)
  })

  it("prefers the earliest plausible future timestamp", () => {
    const error = {
      response: { body: JSON.stringify({ error: { resets_at: 1_800_003_600, resets_in_seconds: 60 } }) },
    }
    assert.strictEqual(parseResetAt(error, NOW), NOW + 60_000)
  })

  it("ignores stale timestamps in the past", () => {
    const error = { response: { body: JSON.stringify({ error: { resets_at: 1_700_000_000 } }) } }
    assert.strictEqual(parseResetAt(error, NOW), undefined)
  })

  it("returns undefined when nothing reports a reset", () => {
    assert.strictEqual(parseResetAt(freeTierError, NOW), undefined)
  })
})

describe("auto-limit-resume: nextDelayMs", () => {
  const cfg = DEFAULTS

  it("backs off exponentially without a reset hint", () => {
    assert.strictEqual(nextDelayMs({ attempt: 1, now: NOW, cfg }), 60_000)
    assert.strictEqual(nextDelayMs({ attempt: 2, now: NOW, cfg }), 120_000)
    assert.strictEqual(nextDelayMs({ attempt: 3, now: NOW, cfg }), 240_000)
  })

  it("caps the backoff at maxDelayMs", () => {
    assert.strictEqual(nextDelayMs({ attempt: 20, now: NOW, cfg }), cfg.maxDelayMs)
  })

  it("honours a provider reset time when provided", () => {
    const delay = nextDelayMs({ attempt: 1, now: NOW, cfg, resetsAt: NOW + 120_000 })
    assert.strictEqual(delay, 125_000)
  })

  it("adds a small cushion to a near-immediate reset", () => {
    assert.strictEqual(nextDelayMs({ attempt: 1, now: NOW, cfg, resetsAt: NOW + 1_000 }), 6_000)
  })

  it("refuses to schedule when the reset is beyond the retry window", () => {
    const resetsAt = NOW + 2 * 24 * 3600_000
    assert.strictEqual(nextDelayMs({ attempt: 1, now: NOW, cfg, resetsAt }), undefined)
  })

  it("ignores the reset hint when respectProviderReset is false", () => {
    const local = { ...cfg, respectProviderReset: false }
    assert.strictEqual(nextDelayMs({ attempt: 1, now: NOW, cfg: local, resetsAt: NOW + 120_000 }), 60_000)
  })
})

describe("auto-limit-resume: resolveConfig", () => {
  it("returns defaults for empty input", () => {
    assert.deepStrictEqual(resolveConfig(undefined), DEFAULTS)
  })

  it("keeps valid overrides", () => {
    const cfg = resolveConfig({ maxAttempts: 5, baseDelayMs: 1_000 })
    assert.strictEqual(cfg.maxAttempts, 5)
    assert.strictEqual(cfg.baseDelayMs, 1_000)
    assert.strictEqual(cfg.maxDelayMs, DEFAULTS.maxDelayMs)
  })

  it("drops values of the wrong type", () => {
    const cfg = resolveConfig({ maxAttempts: "lots" as any, enabled: "yes" as any })
    assert.strictEqual(cfg.maxAttempts, DEFAULTS.maxAttempts)
    assert.strictEqual(cfg.enabled, true)
  })

  it("can be disabled", () => {
    assert.strictEqual(resolveConfig({ enabled: false }).enabled, false)
  })
})

describe("auto-limit-resume: continuation marker", () => {
  it("uses a stable prefix that the plugin can recognise on the wire", () => {
    assert.strictEqual(AUTO_RESUME_PREFIX, "[auto-resume]")
    assert.ok(`${AUTO_RESUME_PREFIX} The previous run stopped...`.startsWith(AUTO_RESUME_PREFIX))
  })
})
