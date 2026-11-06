/**
 * opencode-auto-limit-nudge Plugin — Unit Tests
 *
 * Tests the plugin's internal logic without needing a live OpenCode server.
 * Uses the test-helpers extraction pattern (same as telegram.test-helpers.ts).
 *
 * Run: npm test (included in the test suite)
 */

import assert from "node:assert"
import {
  modelLabel,
  formatNudgeMessage,
  isRetryStatus,
  isSuppressed,
  AutoLimitNudgeConfig,
} from "../opencode-auto-limit-nudge.test-helpers.ts"

// ============================================================================
// HELPERS
// ============================================================================

function makeRetryEvent(overrides: any = {}) {
  return {
    type: "session.status",
    properties: {
      sessionID: "ses_test123",
      status: {
        type: "retry",
        attempt: 1,
        message: "rate_limit_exceeded",
        next: Date.now() + 60_000,
        ...overrides.status,
      },
      ...overrides,
    },
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe("opencode-auto-limit-nudge unit: helpers", () => {
  // -- modelLabel -----------------------------------------------------------

  it("modelLabel: formats provider/model when both present", () => {
    assert.strictEqual(modelLabel("deepseek", "deepseek-v4.1-flash:free"), "deepseek/deepseek-v4.1-flash:free")
  })

  it("modelLabel: returns modelID only when providerID absent", () => {
    assert.strictEqual(modelLabel(undefined, "gpt-4o"), "gpt-4o")
  })

  it("modelLabel: returns providerID only when modelID absent", () => {
    assert.strictEqual(modelLabel("openai", undefined), "openai")
  })

  it("modelLabel: returns fallback when both absent", () => {
    assert.strictEqual(modelLabel(), "the active model")
  })

  // -- formatNudgeMessage ---------------------------------------------------

  it("formatNudgeMessage: includes the label and limit message", () => {
    const result = formatNudgeMessage("deepseek/deepseek-v4.1-flash:free", "rate_limit_exceeded")
    assert.ok(result.includes("deepseek/deepseek-v4.1-flash:free hit a limit: rate_limit_exceeded"))
    assert.ok(result.includes("Will retry automatically."))
  })

  it("formatNudgeMessage: includes reset hint when next is set and hint enabled", () => {
    const next = Date.now() + 5 * 60 * 1000
    const result = formatNudgeMessage("the active model", "quota_exhausted", next, true)
    assert.ok(result.includes("Expected reset ~"))
  })

  it("formatNudgeMessage: omits reset hint when includeResetHint is false", () => {
    const next = Date.now() + 5 * 60 * 1000
    const result = formatNudgeMessage("the active model", "quota_exhausted", next, false)
    assert.ok(!result.includes("Expected reset"))
  })

  it("formatNudgeMessage: omits reset hint when next is missing", () => {
    const result = formatNudgeMessage("the active model", "quota_exhausted", undefined, true)
    assert.ok(!result.includes("Expected reset"))
  })

  // -- isRetryStatus --------------------------------------------------------

  it("isRetryStatus: returns true for session.status retry event", () => {
    assert.strictEqual(isRetryStatus(makeRetryEvent()), true)
  })

  it("isRetryStatus: returns false for session.idle event", () => {
    assert.strictEqual(isRetryStatus({ type: "session.idle", properties: {} }), false)
  })

  it("isRetryStatus: returns false for session.status busy event", () => {
    const event = makeRetryEvent({ status: { type: "busy" } })
    assert.strictEqual(isRetryStatus(event), false)
  })

  it("isRetryStatus: returns false when status is missing", () => {
    assert.strictEqual(isRetryStatus({ type: "session.status", properties: {} }), false)
  })

  // -- isSuppressed ---------------------------------------------------------

  it("isSuppressed: returns true within the suppress window", () => {
    assert.strictEqual(isSuppressed(1000, 500, 60_000), true)
  })

  it("isSuppressed: returns false outside the suppress window", () => {
    assert.strictEqual(isSuppressed(70_000, 500, 60_000), false)
  })

  it("isSuppressed: returns false when no previous nudge", () => {
    assert.strictEqual(isSuppressed(1000, undefined, 60_000), false)
  })

  it("isSuppressed: returns false at exact boundary", () => {
    assert.strictEqual(isSuppressed(60_000, 0, 60_000), false)
  })
})

describe("opencode-auto-limit-nudge unit: config defaults", () => {
  it("AutoLimitNudgeConfig allows overriding toast duration", () => {
    const config: AutoLimitNudgeConfig = { toastDurationMs: 3000 }
    assert.strictEqual(config.toastDurationMs, 3000)
  })

  it("AutoLimitNudgeConfig allows disabling reset hint", () => {
    const config: AutoLimitNudgeConfig = { includeResetHint: false }
    assert.strictEqual(config.includeResetHint, false)
  })

  it("AutoLimitNudgeConfig allows disabling model label", () => {
    const config: AutoLimitNudgeConfig = { includeModel: false }
    assert.strictEqual(config.includeModel, false)
  })
})