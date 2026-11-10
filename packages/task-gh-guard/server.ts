import { existsSync } from "node:fs"
import { nudgeText } from "./src/core/feedback"
import { gate, record } from "./src/core/gate"
import { isPushCommand } from "./src/core/push"
import { reviewCommand } from "./src/core/review"
import { markReported, reported, statePath } from "./src/core/state"
import { notify } from "./src/shared/notify"

// v2.0.29 does not emit session.idle; turn-check uses the same three events.
const TRIGGERS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])
const TOOLS = new Set(["bash", "shell"])

/** opencode v2 entry: record pushes and nudge at the end of a turn when CI is red or pending. */
export default {
  id: "task-gh-guard",
  async setup(ctx: any) {
    if (process.env.TASK_GH_GUARD_ENABLED === "0") return

    const running = new Set<string>()
    const log = (message: string) => notify("task-gh-guard", message)

    // The v2 event carries the tool args on `input`; a throw blocks the call and the message reaches the model.
    await ctx.tool.hook("execute.before", async (event: any) => {
      if (!TOOLS.has(String(event?.tool ?? ""))) return event
      const command = event?.input?.command
      if (typeof command !== "string") return event
      const warning = await reviewCommand(command)
      if (warning) await log(warning)
      return event
    })

    // v2 runs the shell tool as "shell"; v1 calls it "bash".
    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        if (!TOOLS.has(String(event?.tool ?? ""))) return event
        if (event?.status && event.status !== "completed") return event
        const command = event?.input?.command
        if (typeof command !== "string" || !isPushCommand(command)) return event
        await record("opencode", String(event.sessionID ?? ""), ctx.location?.directory ?? process.cwd(), command)
      } catch (err) {
        log(`record failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return event
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!TRIGGERS.has((event as any)?.type)) continue
          const sessionID = (event as any)?.data?.sessionID
          if (typeof sessionID !== "string" || running.has(sessionID)) continue
          const file = statePath("opencode", sessionID)
          if (!existsSync(file)) continue
          running.add(sessionID)
          try {
            const info = await ctx.session.get({ sessionID }).catch(() => undefined)
            if (info?.parentID) continue
            const result = await gate(file)
            if (result.status === "pass") continue
            if (result.status !== "fail" && result.status !== "pending") continue
            const failing = result.entries.filter((entry: any) => entry.status !== "pass")
            if (reported(file, failing)) {
              log("CI still red; already reported, not nudging again.")
              continue
            }
            await ctx.session.prompt({ sessionID, text: nudgeText(result) })
            // One delivery per commit, for good: recorded so a restart or the v1 plugin cannot re-fire it.
            markReported(file, failing, Math.floor(Date.now() / 1000))
          } catch (err) {
            log(`gate failed: ${err instanceof Error ? err.message : String(err)}`)
          } finally {
            running.delete(sessionID)
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) log(`event subscription failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()

    return () => controller.abort()
  },
}
