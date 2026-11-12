/**
 * opencode-auto-limit-resume — state machine tests.
 *
 * These drive the REAL plugin (not a helper copy) through a fake v2 host that
 * mirrors the runtime surface we verified against opencode 2.2.5:
 *   ctx.event.subscribe() -> async iterable of {type, data}
 *   ctx.session.get / prompt / switchModel / wait
 *
 * Run: npx jest test/opencode-auto-limit-nudge.state.test.ts
 */

import assert from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../opencode-auto-limit-nudge.ts"

const PREFIX = "[auto-resume]"
const FREE_LIMIT = {
  type: "provider.quota",
  message: "Free usage limit reached. Subscribe to OpenCode Go to keep going.",
  response: { status_code: 429, body: "{}" },
}

type Event = { type: string; data: any }

class FakeHost {
  queue: Event[] = []
  waiters: Array<(value: any) => void> = []
  prompts: any[] = []
  switches: any[] = []
  toasts: any[] = []
  sessions = new Map<string, any>()
  aborted = false

  stream = {
    queue: this.queue,
    waiters: this.waiters,
    push: (event: Event) => {
      const waiter = this.waiters.shift()
      if (waiter) waiter({ value: event, done: false })
      else this.queue.push(event)
    },
    next: () => {
      const event = this.queue.shift()
      if (event) return Promise.resolve({ value: event, done: false })
      return new Promise((resolve) => this.waiters.push(resolve))
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }

  ctx = {
    tui: { ui: { toast: (toast: any) => this.toasts.push(toast) } },
    event: {
      subscribe: (_options?: any) => this.stream,
    },
    session: {
      get: async ({ sessionID }: any) => this.sessions.get(sessionID),
      wait: async () => undefined,
      prompt: async (args: any) => {
        this.prompts.push(args)
      },
      switchModel: async (args: any) => {
        this.switches.push(args)
        const session = this.sessions.get(args.sessionID)
        if (session) session.model = { providerID: args.model.providerID, id: args.model.id }
      },
    },
  }

  emit(type: string, data: any) {
    this.stream.push({ type, data })
  }

  fail(sessionID: string, error: any = FREE_LIMIT) {
    this.emit("session.execution.started", { sessionID })
    this.emit("session.execution.failed", { sessionID, error })
  }

  session(sessionID: string, overrides: any = {}) {
    this.sessions.set(sessionID, {
      id: sessionID,
      model: { providerID: "fake", id: "model-a" },
      outcome: "failed",
      time: { busy: 1, idle: 2 },
      ...overrides,
    })
  }
}

type Harness = { host: FakeHost; dir: string; config: string; dispose: () => void }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition")
    await sleep(10)
  }
}

function records(dir: string): any[] {
  try {
    return readFileSync(join(dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function boot(config: Record<string, unknown>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "auto-limit-"))
  const configPath = join(dir, "config.json")
  writeFileSync(configPath, JSON.stringify(config))
  process.env.OPENCODE_AUTO_LIMIT_RESUME_DIR = dir
  process.env.OPENCODE_AUTO_LIMIT_RESUME_CONFIG = configPath

  // One shared registry per process; tests start from a clean slate. The
  // plugin captured the registry object at import time, so reset its state
  // instead of replacing the global.
  const registry = ((globalThis as any).__autoLimitResume ??= { state: { version: 1, sessions: {} } })
  registry.state = { version: 1, sessions: {} }

  const host = new FakeHost()
  const dispose = await plugin.setup(host.ctx as any)
  return { host, dir, config: configPath, dispose: () => dispose?.() }
}

const fast = {
  settleMs: 30,
  baseDelayMs: 40,
  maxDelayMs: 200,
  maxAttempts: 4,
  notify: true,
  fallbackModels: ["fake/model-b"],
  watchdogMs: 1_000,
}

describe("auto-limit-resume: state machine", () => {
  afterEach(() => {
    delete process.env.OPENCODE_AUTO_LIMIT_RESUME_DIR
    delete process.env.OPENCODE_AUTO_LIMIT_RESUME_CONFIG
    delete process.env.OPENCODE_AUTO_LIMIT_RESUME_DISABLED
  })

  it("resumes again once the re-prompt cooldown elapses", async () => {
    // The whole point of the cooldown: bounded, but it does nudge again when
    // the quota is plausibly back. A count-based cap would stay silent forever.
    const harness = await boot({ ...fast, fallbackModels: [], maxAttempts: 20, rePromptMs: 4_000 })
    harness.host.session("ses_cd")

    harness.host.fail("ses_cd")
    await waitFor(() => harness.host.prompts.length === 1)
    harness.host.fail("ses_cd")
    await waitFor(() => records(harness.dir).some((r) => r.event === "suppress" && r.reason === "cooldown"), 5_000)
    assert.strictEqual(harness.host.prompts.length, 1, "inside the cooldown")

    // Silence is only acceptable if it ends: the cooldown must release.
    await waitFor(() => harness.host.prompts.length === 2, 10_000)
    harness.dispose()
  }, 15_000)

  it("delivers one [auto-resume] per model per episode, not one per retry", async () => {
    // Production 2026-11-10 sent 19 identical continuations to the same still
    // limited model, one per retry.
    const harness = await boot({ ...fast, fallbackModels: [], maxAttempts: 60, rePromptMs: 60_000 })
    harness.host.session("ses_one")

    harness.host.fail("ses_one")
    await waitFor(() => harness.host.prompts.length === 1, 5_000)

    for (let i = 0; i < 9; i++) {
      // Our own continuation must not count as user input.
      harness.host.emit("session.next.prompted", {
        sessionID: "ses_one",
        messageID: `msg_${i}`,
        prompt: { text: `${PREFIX} continue` },
        delivery: "queue",
      })
      harness.host.fail("ses_one")
      await sleep(350)
    }
    await sleep(1_400)

    assert.strictEqual(harness.host.prompts.length, 1, "one continuation, not one per retry")
    const trail = records(harness.dir)
    assert.ok(trail.some((r) => r.event === "suppress"), "suppression recorded")
    assert.ok(!trail.some((r) => r.event === "episode-reset"), "own prompt does not reset the episode")

    harness.dispose()
  }, 20_000)

  it("allows one new resume after the user sends a real message", async () => {
    const harness = await boot({ ...fast, fallbackModels: [], maxAttempts: 20 })
    harness.host.session("ses_two")

    harness.host.fail("ses_two")
    await waitFor(() => harness.host.prompts.length === 1)
    await sleep(120)
    assert.strictEqual(harness.host.prompts.length, 1)

    harness.host.emit("session.next.prompted", {
      sessionID: "ses_two",
      messageID: "msg_user",
      prompt: { text: "keep going please" },
      delivery: "queue",
    })
    await sleep(50)
    harness.host.fail("ses_two")
    await waitFor(() => harness.host.prompts.length === 2)

    assert.ok(records(harness.dir).some((r) => r.event === "episode-reset"), "user message starts a new episode")

    harness.dispose()
  })

  it("switches to a fallback model on a free limit and resumes", async () => {
    const harness = await boot(fast)
    harness.host.session("ses_a")

    harness.host.fail("ses_a")
    await waitFor(() => harness.host.prompts.length === 1)

    assert.deepStrictEqual(harness.host.switches, [{ sessionID: "ses_a", model: { id: "model-b", providerID: "fake" } }])
    assert.ok(harness.host.prompts[0].text.startsWith(PREFIX))
    assert.strictEqual(harness.host.prompts[0].delivery, "queue")

    const trail = records(harness.dir)
    assert.ok(trail.some((r) => r.event === "failure" && r.reason === "free-limit"), "failure recorded")
    assert.ok(trail.some((r) => r.event === "switch" && r.to === "fake/model-b"), "switch recorded")
    assert.ok(trail.some((r) => r.event === "prompt" && r.switched === true), "prompt recorded")

    harness.dispose()
  })

  it("still resumes when a run starts after the failure and never finishes", async () => {
    // The production bug: opencode emits started (its own retry, a revert, or
    // the user typing) and the old plugin cancelled the pending resume.
    const harness = await boot(fast)
    harness.host.session("ses_b")

    harness.host.fail("ses_b")
    harness.host.emit("session.execution.started", { sessionID: "ses_b" })
    await sleep(10)
    harness.host.emit("session.execution.started", { sessionID: "ses_b" })

    await waitFor(() => harness.host.prompts.length === 1)
    const trail = records(harness.dir)
    assert.ok(trail.some((r) => r.event === "activity"), "activity recorded")
    assert.ok(!trail.some((r) => r.event === "clear" && r.reason === "started"), "must not cancel on started")

    harness.dispose()
  })

  it("does not resume when the retry succeeds first", async () => {
    const harness = await boot(fast)
    harness.host.session("ses_c")

    harness.host.fail("ses_c")
    await sleep(5)
    harness.host.emit("session.execution.succeeded", { sessionID: "ses_c" })

    await sleep(120)
    assert.strictEqual(harness.host.prompts.length, 0)
    assert.ok(records(harness.dir).some((r) => r.event === "clear" && r.reason === "succeeded"))

    harness.dispose()
  })

  it("restores a pending resume after a plugin reload", async () => {
    const harness = await boot(fast)
    harness.host.session("ses_d")

    harness.host.fail("ses_d")
    await waitFor(() => records(harness.dir).some((r) => r.event === "failure"))
    harness.dispose()
    assert.strictEqual(harness.host.prompts.length, 0)

    // Same process, same session, new plugin instance: simulates a location
    // teardown / plugin reconciliation.
    const dispose2 = await plugin.setup(harness.host.ctx as any)
    await waitFor(() => harness.host.prompts.length === 1)

    const trail = records(harness.dir)
    assert.ok(trail.some((r) => r.event === "restored" && r.sessionID === "ses_d"), "restored from disk")
    assert.ok(harness.host.prompts[0].text.startsWith(PREFIX))
    dispose2?.()
  })

  it("retries the same model for a normal rate limit before switching", async () => {
    const harness = await boot({ ...fast, switchAfterAttempts: 2, fallbackModels: ["fake/model-b"] })
    harness.host.session("ses_e")

    harness.host.fail("ses_e", { type: "provider.rate_limit", message: "Too Many Requests", response: { status_code: 429 } })
    await waitFor(() => harness.host.prompts.length === 1)
    assert.strictEqual(harness.host.switches.length, 0, "first retry keeps the model")

    harness.host.session("ses_e", { outcome: "failed" })
    harness.host.fail("ses_e", { type: "provider.rate_limit", message: "Too Many Requests", response: { status_code: 429 } })
    await waitFor(() => harness.host.prompts.length === 2)
    assert.strictEqual(harness.host.switches.length, 1, "second failure switches")

    harness.dispose()
  })

  it("never switches back to an already tried fallback", async () => {
    const harness = await boot({ ...fast, fallbackModels: ["fake/model-b", "fake/model-c"], switchAfterAttempts: 1 })
    harness.host.session("ses_i")

    harness.host.fail("ses_i")
    await waitFor(() => harness.host.switches.length === 1)
    harness.host.session("ses_i", { outcome: "failed" })
    harness.host.fail("ses_i")
    await waitFor(() => harness.host.switches.length === 2)
    assert.deepStrictEqual(
      harness.host.switches.map((s) => s.model.id),
      ["model-b", "model-c"],
    )

    harness.host.session("ses_i", { outcome: "failed" })
    harness.host.fail("ses_i")
    await waitFor(() => harness.host.prompts.length >= 3)
    assert.strictEqual(harness.host.switches.length, 2, "no ping-pong back to model-b")

    harness.dispose()
  })

  it("keeps working after the owning instance unloads", async () => {
    const harness = await boot(fast)
    harness.host.session("ses_j")

    const dispose2 = await plugin.setup(harness.host.ctx as any)
    harness.dispose() // instance 1 is no longer the owner; ownership moves to instance 2

    harness.host.fail("ses_j")
    await waitFor(() => harness.host.prompts.length === 1)
    assert.ok(records(harness.dir).some((r) => r.event === "dispose" && r.owner === false))

    dispose2?.()
  })

  it("never switches to another model on the same provider for a plan-wide limit", async () => {
    // Observed in production 2026-11-10: opencode-go/minimax-m3.1-flash hit the
    // weekly Go limit and the plugin switched to opencode-go/deepseek-v4.1-flash,
    // which sits on the same weekly limit. Cross-provider only.
    const harness = await boot({
      ...fast,
      fallbackModels: ["fake/model-b", "other/model-z"],
      switchAfterAttempts: 1,
      settleMs: 20,
    })
    harness.host.session("ses_l", { model: { providerID: "fake", id: "model-a" } })

    const weekly = {
      type: "provider.go-limit",
      message: "OpenCode Go weekly usage limit reached. Switch to a free model, or turn on Extra Usage.",
    }
    harness.host.fail("ses_l", weekly)
    await waitFor(() => harness.host.prompts.length === 1)

    assert.deepStrictEqual(
      harness.host.switches.map((s) => `${s.model.providerID}/${s.model.id}`),
      ["other/model-z"],
      "must leave the provider, not hop between models on it",
    )

    harness.dispose()
  })

  it("uses the long backoff for a plan-wide limit with no cross-provider fallback", async () => {
    const harness = await boot({
      ...fast,
      fallbackModels: ["fake/model-b"],
      switchAfterAttempts: 1,
      maxDelayMs: 5_000,
    })
    harness.host.session("ses_m", { model: { providerID: "fake", id: "model-a" } })

    harness.host.fail("ses_m", {
      type: "provider.go-limit",
      message: "OpenCode Go weekly usage limit reached. Switch to a free model, or turn on Extra Usage.",
    })
    await waitFor(() => harness.host.prompts.length === 1)
    await sleep(100)

    assert.strictEqual(harness.host.switches.length, 0, "same-provider fallback skipped")
    const armed = records(harness.dir).filter((r) => r.event === "armed").at(-1)
    assert.ok(armed.inMs >= 4_000, `weekly limit must back off to maxDelayMs, got ${armed.inMs}ms`)

    harness.dispose()
  })

  it("stops injecting after the rolling injection ceiling", async () => {
    // Repo rule: a plugin that pushes text into a session must bound it, and a
    // changing key must not re-arm the budget. Each resume lands on a new
    // model, so the cooldown does not mask the ceiling.
    const harness = await boot({
      ...fast,
      maxAttempts: 100,
      settleMs: 10,
      baseDelayMs: 10,
      maxDelayMs: 20,
      fallbackModels: ["f/b", "f/c", "f/d", "f/e"],
      switchAfterAttempts: 1,
      injectPerWindow: 3,
      injectWindowMs: 60_000,
    })
    harness.host.session("ses_k")

    for (let i = 0; i < 8; i++) {
      const before = records(harness.dir).filter((r) => r.event === "prompt").length
      harness.host.fail("ses_k", { type: "provider.rate_limit", message: "Too Many Requests", response: { status_code: 429 } })
      await waitFor(() => {
        const rows = records(harness.dir)
        return (
          rows.filter((r) => r.event === "prompt").length > before ||
          rows.some((r) => r.event === "give-up" && r.reason === "injection-ceiling")
        )
      }, 5_000)
      if (records(harness.dir).some((r) => r.event === "give-up" && r.reason === "injection-ceiling")) break
    }

    const injected = records(harness.dir).filter((r) => r.event === "prompt").length
    assert.ok(injected <= 3, `injected ${injected} times, ceiling is 3`)
    assert.ok(records(harness.dir).some((r) => r.event === "give-up" && r.reason === "injection-ceiling"))

    harness.dispose()
  }, 30_000)

  it("gives up after maxAttempts", async () => {
    const harness = await boot({ ...fast, maxAttempts: 2, fallbackModels: ["fake/model-b", "fake/model-c"] })
    harness.host.session("ses_f")

    harness.host.fail("ses_f", { type: "provider.rate_limit", message: "Too Many Requests", response: { status_code: 429 } })
    await waitFor(() => harness.host.prompts.length === 1)
    harness.host.fail("ses_f", { type: "provider.rate_limit", message: "Too Many Requests", response: { status_code: 429 } })
    await waitFor(() => harness.host.prompts.length === 2)

    harness.host.fail("ses_f", { type: "provider.rate_limit", message: "Too Many Requests", response: { status_code: 429 } })
    await waitFor(() => records(harness.dir).some((r) => r.event === "give-up"))

    assert.strictEqual(harness.host.prompts.length, 2)
    assert.ok(records(harness.dir).some((r) => r.event === "give-up" && r.reason === "attempts"))

    harness.dispose()
  })

  it("ignores non-limit failures", async () => {
    const harness = await boot(fast)
    harness.host.session("ses_g", { outcome: "failed" })

    harness.host.fail("ses_g", { type: "provider.auth", message: "session expired", response: { status_code: 401 } })
    await sleep(120)

    assert.strictEqual(harness.host.prompts.length, 0)
    assert.strictEqual(harness.host.switches.length, 0)
    assert.ok(records(harness.dir).some((r) => r.event === "skip" && r.reason === "auth"))

    harness.dispose()
  })

  it("waits for a busy session instead of prompting into a running run", async () => {
    const harness = await boot({ ...fast, settleMs: 10 })
    harness.host.session("ses_h", { outcome: undefined, time: { busy: 5, idle: 2 } })

    harness.host.fail("ses_h")
    await sleep(450)
    assert.strictEqual(harness.host.prompts.length, 0)
    assert.ok(records(harness.dir).some((r) => r.event === "hold" && r.reason === "busy"))

    harness.host.session("ses_h", { outcome: "failed", time: { busy: 2, idle: 9 } })
    await waitFor(() => harness.host.prompts.length === 1)

    harness.dispose()
  })
})
