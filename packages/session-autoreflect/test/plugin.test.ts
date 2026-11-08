import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../server"

const dir = mkdtempSync(join(tmpdir(), "autoreflect-"))
process.env.AUTOREFLECT_HOME = join(dir, "state")

afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

const waitFor = async (cond: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
  return cond()
}

const userMessage = (id: string, text = "build the feature") => ({ id, role: "user", content: [{ type: "text", text }] })

async function boot(opts: { parentID?: string; intervalMs?: number; idleResetMs?: number } = {}) {
  process.env.AUTOREFLECT_INTERVAL_MS = String(opts.intervalMs ?? 120)
  process.env.AUTOREFLECT_IDLE_RESET_MS = String(opts.idleResetMs ?? 200)
  process.env.AUTOREFLECT_TICK_MS = "20"

  const events = channel()
  const calls = { contextHook: undefined as any }
  const ctx: any = {
    event: { subscribe: () => events },
    session: {
      get: async () => ({ parentID: opts.parentID }),
      hook: async (name: string, cb: any) => {
        if (name === "context") calls.contextHook = cb
        return { dispose: async () => {} }
      },
    },
  }
  const dispose = await plugin.setup(ctx)
  return { calls, events, dispose }
}

const executionStarted = (events: ReturnType<typeof channel>, sessionID: string) =>
  events.push({ type: "session.execution.started", data: { sessionID } })
const executionFinished = (events: ReturnType<typeof channel>, sessionID: string) =>
  events.push({ type: "session.execution.succeeded", data: { sessionID } })

describe("session-autoreflect", () => {
  test("injects the reflection prompt into the next step of a long working session", async () => {
    const { calls, events, dispose } = await boot()
    executionStarted(events, "ses_1")
    await waitFor(() => calls.contextHook !== undefined)

    const message = userMessage("m1")
    await calls.contextHook({ sessionID: "ses_1", messages: [message] })
    expect(message.content.length).toBe(1)

    await new Promise((r) => setTimeout(r, 300))
    await calls.contextHook({ sessionID: "ses_1", messages: [message] })

    expect(message.content.length).toBe(2)
    expect((message.content[1] as any).text).toContain("Did you complete the task?")
    expect((message.content[1] as any).text).toContain("Then act on the answers")
    dispose()
  })

  test("an idle session is never injected", async () => {
    const { calls, events, dispose } = await boot()
    executionStarted(events, "ses_2")
    executionFinished(events, "ses_2")
    await new Promise((r) => setTimeout(r, 300))

    const message = userMessage("m2")
    await calls.contextHook({ sessionID: "ses_2", messages: [message] })
    expect(message.content.length).toBe(1)
    dispose()
  })

  test("a new user turn does not inherit the old reminder", async () => {
    const { calls, events, dispose } = await boot()
    executionStarted(events, "ses_3")
    await waitFor(() => calls.contextHook !== undefined)

    const first = userMessage("m3")
    await new Promise((r) => setTimeout(r, 300))
    await calls.contextHook({ sessionID: "ses_3", messages: [first] })
    expect(first.content.length).toBe(2)

    const second = userMessage("m4")
    await calls.contextHook({ sessionID: "ses_3", messages: [second] })
    expect(second.content.length).toBe(1)
    dispose()
  })

  test("child sessions are skipped by default", async () => {
    const { calls, events, dispose } = await boot({ parentID: "ses_parent" })
    executionStarted(events, "ses_child")
    await waitFor(() => calls.contextHook !== undefined)
    await new Promise((r) => setTimeout(r, 300))

    const message = userMessage("m5")
    await calls.contextHook({ sessionID: "ses_child", messages: [message] })
    expect(message.content.length).toBe(1)
    dispose()
  })
})
