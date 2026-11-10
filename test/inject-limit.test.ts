/**
 * Injection ceilings: every plugin that pushes text into a session must bound it, so a repeated
 * finding cannot drive an agent loop. See packages/shared/src/inject-limit.ts and AGENTS.md.
 */
import { describe, expect, it } from "@jest/globals"
import { countInWindow, mayInject, recordInjection, type Budget } from "../packages/shared/src/inject-limit.js"

describe("inject-limit", () => {
  it("counts every key that shares the scope prefix inside the window", () => {
    const now = 10_000
    const budget: Budget = { "s1|a": { at: 9000 }, "s1|b": { at: 100 }, "s2|c": { at: 9999 } }
    expect(countInWindow(budget, "s1|", now, 3600)).toBe(1)
    expect(countInWindow(budget, "s2|", now, 3600)).toBe(1)
    expect(countInWindow(budget, "s1|", now, 0)).toBe(0)
  })

  it("stops allowing injections at the limit", () => {
    const now = 1000
    let budget: Budget = {}
    for (let i = 0; i < 3; i++) {
      expect(mayInject(budget, "s1|", now, 3600, 3)).toBe(true)
      budget = recordInjection(budget, `s1|${i}`, now)
    }
    expect(mayInject(budget, "s1|", now, 3600, 3)).toBe(false)
    // A different scope keeps its own budget.
    expect(mayInject(budget, "s2|", now, 3600, 3)).toBe(true)
  })

  it("allows again once the window passes", () => {
    const budget = recordInjection(recordInjection({}, "s1|0", 1000), "s1|1", 1001)
    expect(mayInject(budget, "s1|", 1002, 3600, 2)).toBe(false)
    expect(mayInject(budget, "s1|", 1000 + 3601, 3600, 2)).toBe(true)
  })
})
