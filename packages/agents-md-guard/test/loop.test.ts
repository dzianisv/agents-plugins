// Loop probe for agents-md-guard: many failing audits, with the plugin reloaded between turns (the real
// restart case) and the pending state cleared, must still deliver at most the ceiling.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readInjectBudget } from "../src/core/state"
import { FAIL_REPLY, makeEnv, type TestEnv } from "./helpers"

let env: TestEnv
const made: TestEnv[] = []

const setup = () => {
  env = makeEnv()
  made.push(env)
  return env
}

afterEach(() => {
  for (const item of made.splice(0)) item.restore()
})

describe("agents-md-guard loop probe", () => {
  test("ten failing turns with the plugin reloaded each time inject at most the ceiling", async () => {
    const testEnv = setup()
    process.env.FAKE_REPLY = FAIL_REPLY
    const prompts: unknown[] = []
    const client = {
      app: { log: async () => ({}) },
      tui: { showToast: async () => {} },
      session: {
        get: async () => ({ data: {} }),
        list: async () => ({ data: [] }),
        prompt: async (a: never) => {
          const body = (a as { body?: { agent?: string } })?.body
          if (body?.agent === "supervisor-judge") return { data: { parts: [{ type: "text", text: FAIL_REPLY }] } }
          prompts.push(a)
          return {}
        },
        delete: async () => ({}),
      },
    }
    const conversation = [
      { info: { id: "m1", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "status?" }] },
      { info: { id: "m2", role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: "line\n".repeat(12) }] },
    ]
    for (let turn = 0; turn < 10; turn++) {
      conversation.push({ info: { id: `a${turn}`, role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: `round ${turn}` }] })
      const { Supervisor } = await import("../src/opencode/plugin")
      const hooks = (await Supervisor({
        client: { ...client, session: { ...client.session, messages: async () => ({ data: conversation }), create: async () => ({ data: { id: "audit1" } }) } },
      } as never)) as never as Record<string, (a: never) => Promise<void>>
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as never)
      await new Promise((resolve) => setTimeout(resolve, 20))
      // the host deletes the pending note and the audited marker as the turn progresses
      rmSync(join(testEnv.home, "pending", "s1.txt"), { force: true })
      rmSync(join(testEnv.home, "state", "s1.json"), { force: true })
    }
    expect(prompts.length).toBeLessThanOrEqual(3)
    expect(Object.keys(readInjectBudget("s1", testEnv.home)).length).toBeLessThanOrEqual(3)
    expect(existsSync(join(testEnv.home, "inject", "s1.json"))).toBe(true)
  })
})
