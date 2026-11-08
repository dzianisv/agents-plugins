import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "auto-review-v2-"))
process.env.HOME = dir

afterEach(() => {
  delete process.env.AUTO_REVIEW_MODEL
  delete process.env.AUTO_REVIEW_DEBUG
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

const tool = (name: string) => ({ type: "tool", name, state: { input: {} } })

const conversation = (tools: number) => [
  { id: "u1", type: "user", text: "do the thing", time: { created: 1 } },
  {
    id: "a1",
    type: "assistant",
    time: { created: 2, completed: 3 },
    model: { providerID: "fireworks-ai", id: "accounts/fireworks/models/deepseek-v4p1-flash" },
    content: [...Array.from({ length: tools }, () => tool("bash")), { type: "text", text: "done" }],
  },
  { id: "i1", type: "idle", outcome: "succeeded" },
]

function fakeCtx(opts: { messages?: any[]; parentID?: string; models?: any[] } = {}) {
  const calls = { created: [] as any[], prompted: [] as any[], listed: 0 }
  const events = channel()
  const ctx: any = {
    location: { directory: dir },
    event: { subscribe: () => events },
    model: {
      list: async () => {
        calls.listed++
        return { data: opts.models ?? [] }
      },
    },
    session: {
      get: async () => ({ id: "s1", parentID: opts.parentID, location: { directory: dir } }),
      context: async () => opts.messages ?? conversation(3),
      create: async (input: any) => {
        calls.created.push(input)
        return { id: `review-${calls.created.length}` }
      },
      prompt: async (input: any) => {
        calls.prompted.push(input)
        return {}
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

describe("opencode v2 server", () => {
  test("creates a review child session with the forced model and prompts it", async () => {
    process.env.AUTO_REVIEW_MODEL = "github-copilot/gpt-5.5"
    const { ctx, calls, events } = fakeCtx()
    await plugin.setup(ctx)
    finished(events, "s1")
    await waitFor(() => calls.prompted.length === 1)

    expect(calls.created).toHaveLength(1)
    expect(calls.created[0]).toMatchObject({
      parentID: "s1",
      title: "AUTO-REVIEW",
      model: { providerID: "github-copilot", id: "gpt-5.5" },
    })
    expect(calls.prompted[0].sessionID).toBe("review-1")
    expect(calls.prompted[0].text).toContain("AUTO-REVIEW")
    expect(calls.prompted[0].text).toContain("do the thing")
  })

  test("infers a different-family review model from ctx.model.list", async () => {
    const models = [
      { providerID: "fireworks-ai", modelID: "accounts/fireworks/models/deepseek-v4p1-flash" },
      { providerID: "github-copilot", modelID: "claude-opus-4.6" },
    ]
    const { ctx, calls, events } = fakeCtx({ models })
    await plugin.setup(ctx)
    finished(events, "s2")
    await waitFor(() => calls.prompted.length === 1)

    expect(calls.listed).toBeGreaterThan(0)
    expect(calls.created[0].model).toEqual({ providerID: "github-copilot", id: "claude-opus-4.6" })
  })

  test("skips child sessions", async () => {
    const { ctx, calls, events } = fakeCtx({ parentID: "parent" })
    await plugin.setup(ctx)
    finished(events, "child")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.created).toHaveLength(0)
  })

  test("skips a turn with fewer than three tool calls", async () => {
    const { ctx, calls, events } = fakeCtx({ messages: conversation(1) })
    await plugin.setup(ctx)
    finished(events, "s3")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.created).toHaveLength(0)
  })

  test("reviews the same turn only once", async () => {
    process.env.AUTO_REVIEW_MODEL = "github-copilot/gpt-5.5"
    const { ctx, calls, events } = fakeCtx()
    await plugin.setup(ctx)
    finished(events, "s4")
    await waitFor(() => calls.prompted.length === 1)
    finished(events, "s4")
    finished(events, "s4")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.prompted).toHaveLength(1)
  })

  test("ignores sessions whose turn already carries a review marker", async () => {
    const marked = conversation(3).map((m, i) => (i === 0 ? { ...m, text: "AUTO-REVIEW please" } : m))
    const { ctx, calls, events } = fakeCtx({ messages: marked })
    await plugin.setup(ctx)
    finished(events, "s5")
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.created).toHaveLength(0)
  })
})
