/**
 * Plugin hygiene: every failure class we hit in the plugin packages is checked here, so the same
 * bug cannot come back in another plugin. See scripts/plugin-hygiene.ts for the rules.
 */
import { describe, expect, it } from "@jest/globals"
import { RULES, scanPluginHygiene } from "../scripts/plugin-hygiene"

describe("plugin hygiene rules", () => {
  it("flags a leaked child flag that disables a plugin everywhere", () => {
    const rule = RULES.find((item) => item.id === "child-flag-scoped")!
    expect(rule.applies('if (env.SUPERVISOR_CHILD === "1") return false')).toBe(true)
    expect(rule.ok('if (env.SUPERVISOR_CHILD === "1") return false')).toBe(false)
    expect(rule.ok('if (env.SUPERVISOR_CHILD === "1" && isJudgeDir(data.cwd)) return false')).toBe(true)
  })

  it("flags a gh call without the stale-token fallback", () => {
    const rule = RULES.find((item) => item.id === "gh-token-fallback")!
    expect(rule.applies('run("gh", args, { timeout })')).toBe(true)
    expect(rule.ok('run("gh", args, { timeout })')).toBe(false)
    expect(rule.ok('delete env.GH_TOKEN; run("gh", args, { timeout })')).toBe(true)
  })

  it("flags a judge spawn without a transient retry", () => {
    const rule = RULES.find((item) => item.id === "judge-transient-retry")!
    expect(rule.applies('spawn("opencode", cmd, {})')).toBe(true)
    expect(rule.ok('spawn("opencode", cmd, {})')).toBe(false)
    expect(rule.ok('const TRANSIENT = /socket/; spawn("opencode", cmd, {})')).toBe(true)
  })

  it("flags a starved judge or review timeout", () => {
    const rule = RULES.find((item) => item.id === "timeout-floor")!
    expect(rule.applies("const DEFAULT_JUDGE_TIMEOUT_MS = 120000")).toBe(true)
    expect(rule.ok("const DEFAULT_JUDGE_TIMEOUT_MS = 60000")).toBe(false)
    expect(rule.ok("const DEFAULT_JUDGE_TIMEOUT_MS = 240000")).toBe(true)
    expect(rule.ok('const raw = env.TASK_GH_GUARD_REVIEW_TIMEOUT ?? "60"')).toBe(false)
    expect(rule.ok('const raw = env.TASK_GH_GUARD_REVIEW_TIMEOUT ?? "120"')).toBe(true)
  })
})

describe("plugin packages", () => {
  it("passes every hygiene rule", () => {
    expect(scanPluginHygiene(process.cwd())).toEqual([])
  })
})
