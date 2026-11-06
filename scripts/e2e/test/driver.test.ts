import { describe, expect, test } from "bun:test"
import { redact, streamEvents, tail } from "../driver"

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
