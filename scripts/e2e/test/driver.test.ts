import { describe, expect, test } from "bun:test"
import { redact, runtimeEnv, streamEvents, tail } from "../driver"
import type { Spec } from "../spec"

describe("streamEvents", () => {
  test("parses JSON lines and skips everything else", () => {
    const events = streamEvents('{"type":"system","subtype":"init"}\nnot json\n{"type":"result","subtype":"success"}\n')
    expect(events.length).toBe(2)
    expect(events[0].subtype).toBe("init")
    expect(events[1].subtype).toBe("success")
  })

  test("keeps hook fields", () => {
    const events = streamEvents('{"type":"system","subtype":"hook_response","hook_event":"Stop","outcome":"success"}')
    expect(events[0].hook_event).toBe("Stop")
    expect(events[0].outcome).toBe("success")
  })
})

describe("redact", () => {
  test("replaces credential-looking tokens", () => {
    const token = `${["f", "w"].join("")}_ABCDEF123456`
    const text = redact(`key ${token} and more`)
    expect(text).not.toContain(token)
    expect(text).toContain("[redacted]")
  })

  test("leaves ordinary text alone", () => {
    expect(redact("git commit --allow-empty")).toBe("git commit --allow-empty")
  })
})

describe("tail", () => {
  test("keeps the last 40 lines", () => {
    const text = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n")
    const result = tail(text)
    expect(result.startsWith("line 20")).toBe(true)
    expect(result.endsWith("line 59")).toBe(true)
  })

  test("joins parts and drops empty ones", () => {
    expect(tail("a", "", "b")).toBe("a\nb")
  })
})

describe("runtimeEnv", () => {
  const notify = { cmd: "bun recorder.ts", log: "/out/notify.log" }
  const spec: Spec = { plugin: "p", runtimes: ["opencode"], prompt: "hi", checks: [], env: { OPENCODE_SESSION_INDEX_IDLE_MS: "5000" } }

  test("layers the spec env over the base", () => {
    const env = runtimeEnv(spec, { HOME: "/home/node", OPENCODE_SESSION_INDEX_IDLE_MS: "600000" }, notify)
    expect(env.HOME).toBe("/home/node")
    expect(env.OPENCODE_SESSION_INDEX_IDLE_MS).toBe("5000")
  })

  test("the notify recorder cannot be overridden", () => {
    const env = runtimeEnv({ ...spec, env: { AGENTS_NOTIFY_CMD: "echo bad", E2E_NOTIFY_LOG: "/bad" } }, {}, notify)
    expect(env.AGENTS_NOTIFY_CMD).toBe("bun recorder.ts")
    expect(env.E2E_NOTIFY_LOG).toBe("/out/notify.log")
  })
})
