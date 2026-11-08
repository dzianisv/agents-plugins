import { describe, expect, test } from "bun:test"
import {
  DEFAULT_IDLE_RESET_MS,
  DEFAULT_INTERVAL_MS,
  PROMPT,
  attach,
  elapsed,
  expired,
  finished,
  newState,
  resolveConfig,
  started,
  tick,
  type Config,
} from "../opencode/core"

const cfg = (over: Partial<Config> = {}): Config => ({
  enabled: true,
  intervalMs: 30 * 60_000,
  idleResetMs: 10 * 60_000,
  tickMs: 30_000,
  includeChild: false,
  ...over,
})

const MIN = 60_000

describe("resolveConfig", () => {
  test("defaults to 30 minutes of work", () => {
    const c = resolveConfig({}, {})
    expect(c.intervalMs).toBe(DEFAULT_INTERVAL_MS)
    expect(c.intervalMs).toBe(30 * MIN)
    expect(c.idleResetMs).toBe(DEFAULT_IDLE_RESET_MS)
    expect(c.enabled).toBe(true)
    expect(c.includeChild).toBe(false)
  })

  test("env wins over the config file", () => {
    const c = resolveConfig({ intervalMs: 5 * MIN }, { AUTOREFLECT_INTERVAL_MS: String(2 * MIN), AUTOREFLECT_ENABLED: "0" })
    expect(c.intervalMs).toBe(2 * MIN)
    expect(c.enabled).toBe(false)
  })
})

describe("tick", () => {
  test("does not fire while the session is idle", () => {
    const state = newState(0)
    expect(tick(state, 31 * MIN, cfg())).toBe(false)
    expect(state.pending).toBe(false)
  })

  test("fires after 30 minutes of working time", () => {
    const state = newState(0)
    const c = cfg()
    started(state, 0, c)
    expect(tick(state, 29 * MIN, c)).toBe(false)
    expect(tick(state, 30 * MIN, c)).toBe(true)
    expect(state.pending).toBe(true)
  })

  test("does not fire twice before the armed prompt lands", () => {
    const state = newState(0)
    const c = cfg()
    started(state, 0, c)
    expect(tick(state, 30 * MIN, c)).toBe(true)
    expect(tick(state, 45 * MIN, c)).toBe(false)
    expect(tick(state, 61 * MIN, c)).toBe(false)
    expect(attach(state, "m1", 61 * MIN)).toBe(true)
    expect(tick(state, 90 * MIN, c)).toBe(false)
    expect(tick(state, 92 * MIN, c)).toBe(true)
  })

  test("accumulates across executions and resets after a long idle gap", () => {
    const state = newState(0)
    const c = cfg({ idleResetMs: 10 * MIN })
    started(state, 0, c)
    finished(state, 20 * MIN)
    expect(elapsed(state, 25 * MIN)).toBe(20 * MIN)

    started(state, 25 * MIN, c)
    expect(tick(state, 35 * MIN, c)).toBe(true)

    // idle long enough: the next task starts from zero
    const fresh = newState(0)
    started(fresh, 0, c)
    finished(fresh, 20 * MIN)
    started(fresh, 40 * MIN, c)
    expect(tick(fresh, 55 * MIN, c)).toBe(false)
  })

  test("a finished execution drops an injection that never landed", () => {
    const state = newState(0)
    const c = cfg()
    started(state, 0, c)
    expect(tick(state, 30 * MIN, c)).toBe(true)
    finished(state, 30 * MIN + 1_000)
    expect(state.pending).toBe(false)
    expect(attach(state, "m1", 31 * MIN)).toBe(false)
  })
})

describe("attach", () => {
  test("attaches once per turn and re-attaches on later steps", () => {
    const state = newState(0)
    const c = cfg()
    started(state, 0, c)
    tick(state, 30 * MIN, c)

    expect(attach(state, "m1", 30 * MIN)).toBe(true)
    expect(attach(state, "m1", 31 * MIN)).toBe(true)
    expect(attach(state, "m2", 32 * MIN)).toBe(false)
    expect(attach(state, "m1", 33 * MIN)).toBe(false)
  })
})

describe("expired", () => {
  test("forgets sessions idle for a long time", () => {
    const state = newState(0)
    const c = cfg()
    expect(expired(state, 39 * MIN, c)).toBe(false)
    expect(expired(state, 40 * MIN, c)).toBe(true)
  })
})

test("the prompt asks for reflection and then action", () => {
  expect(PROMPT).toContain("What is the goal?")
  expect(PROMPT).toContain("Did you complete the task?")
  expect(PROMPT).toContain("Then act on the answers")
})
