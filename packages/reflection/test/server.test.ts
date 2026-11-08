import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "reflection-v2-"))
process.env.HOME = dir

const { default: plugin } = await import("../server")

function channel() {
  const queue: any[] = []
  let waiter: ((r: IteratorResult<any>) => void) | undefined
  return {
    push(e: any) {
      if (waiter) {
        const w = waiter
        waiter = undefined
        w({ value: e, done: false })
      } else queue.push(e)
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => (queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise((r) => (waiter = r))),
      }
    },
  }
}

const turn = (user: string, assistant = "I started the work") => [
  { id: "u1", type: "user", text: user, time: { created: 1 } },
  { id: "a1", type: "assistant", time: { created: 2, completed: 3 }, model: { providerID: "fireworks-ai", id: "m" }, content: [{ type: "text", text: assistant }] },
]

function fakeCtx(opts: { messages?: any[]; reply?: string }) {
  const calls = { generated: [] as any[], prompted: [] as any[], tools: [] as string[] }
  const events = channel()
  const ctx: any = {
    location: { directory: dir },
    event: { subscribe: () => events },
    generate: {
      text: async (input: any) => {
        calls.generated.push(input)
        return { text: opts.reply ?? "" }
      },
    },
    session: {
      context: async () => opts.messages ?? turn("implement the feature"),
      prompt: async (input: any) => {
        calls.prompted.push(input)
        return {}
      },
    },
    tool: {
      transform: async (cb: any) => {
        cb({ add: (t: any) => calls.tools.push(t.name) })
      },
    },
  }
  return { ctx, calls, events }
}

const finished = (events: ReturnType<typeof channel>, sessionID: string) =>
  events.push({ type: "session.execution.succeeded", data: { sessionID } })

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
}

const verdict = (sessionID: string) => JSON.parse(readFileSync(join(dir, ".reflection", `verdict_${sessionID.slice(0, 8)}.json`), "utf8"))

describe("opencode v2 server", () => {
  test("registers the set_reflection and reflection tools", async () => {
    const { ctx, calls } = fakeCtx({})
    await plugin.setup(ctx)
    expect(calls.tools.sort()).toEqual(["reflection", "set_reflection"])
  })

  test("pushes escalating feedback when the self-assessment is incomplete", async () => {
    const reply = JSON.stringify({ status: "in_progress", confidence: 0.5, remaining_work: ["Finish the feature"] })
    const { ctx, calls, events } = fakeCtx({ reply })
    await plugin.setup(ctx)
    finished(events, "s1")
    await waitFor(() => calls.prompted.length === 1)

    expect(calls.generated[0].prompt).toContain("SELF-ASSESS REFLECTION-3")
    expect(calls.prompted).toHaveLength(1)
    expect(calls.prompted[0].sessionID).toBe("s1")
    expect(calls.prompted[0].text).toContain("## Reflection-3:")
    expect(verdict("s1").complete).toBe(false)
  })

  test("stays silent and records a complete verdict for a finished research task", async () => {
    const reply = JSON.stringify({ status: "complete", confidence: 0.95 })
    const { ctx, calls, events } = fakeCtx({ messages: turn("research the options"), reply })
    await plugin.setup(ctx)
    finished(events, "s2")
    await waitFor(() => calls.generated.length === 1)
    await new Promise((r) => setTimeout(r, 50))

    expect(calls.prompted).toHaveLength(0)
    expect(verdict("s2").complete).toBe(true)
  })

  test("does not reflect the same turn twice", async () => {
    const reply = JSON.stringify({ status: "in_progress", confidence: 0.5, remaining_work: ["x"] })
    const { ctx, calls, events } = fakeCtx({ reply })
    await plugin.setup(ctx)
    finished(events, "s3")
    await waitFor(() => calls.generated.length === 1)
    finished(events, "s3")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.generated).toHaveLength(1)
  })

  test("skips a judge session", async () => {
    const messages = turn("implement the feature")
    messages[0] = { ...messages[0], text: "SELF-ASSESS REFLECTION-3" }
    const { ctx, calls, events } = fakeCtx({ messages })
    await plugin.setup(ctx)
    finished(events, "s4")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.generated).toHaveLength(0)
  })

  test("skips a session disabled through .reflection/disabled", async () => {
    const { ctx, calls, events } = fakeCtx({ reply: "{}" })
    await plugin.setup(ctx)
    const { setSessionDisabled } = await import("../src/core")
    await setSessionDisabled(dir, "s5", true)
    finished(events, "s5")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.generated).toHaveLength(0)
    expect(existsSync(join(dir, ".reflection", "disabled"))).toBe(true)
  })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))
