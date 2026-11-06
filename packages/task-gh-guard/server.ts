import { existsSync, rmSync } from "node:fs"
import { notify } from "./opencode/notify"
import {
  bumpNudge,
  feedback,
  gate,
  isPushCommand,
  nudgeAllowed,
  nudgeKey,
  record,
  stateFile,
  type Gate,
  type Nudges,
} from "./opencode/core"

// v2.0.29 does not emit session.idle; turn-check uses the same three events.
const TRIGGERS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])
const TOOLS = new Set(["bash", "shell"])

export default {
  id: "task-gh-guard",
  async setup(ctx: any) {
    if (process.env.TASK_GH_GUARD_ENABLED === "0") return

    const nudges: Nudges = {}
    const running = new Set<string>()
    const log = (message: string) => void notify("task-gh-guard", message)

    // v2 runs the shell tool as "shell"; v1 calls it "bash".
    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        if (!TOOLS.has(String(event?.tool ?? ""))) return event
        if (event?.status && event.status !== "completed") return event
        const command = event?.input?.command
        if (!isPushCommand(command)) return event
        await record(String(event.sessionID ?? ""), command, ctx.location?.directory ?? process.cwd())
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
          const file = stateFile("opencode", sessionID)
          if (!existsSync(file)) continue
          running.add(sessionID)
          try {
            const info = await ctx.session.get({ sessionID }).catch(() => undefined)
            if (info?.parentID) continue
            const result: Gate = await gate(file)
            if (result.error) log(`CI check could not run: ${result.error}`)
            if (result.status === "pass") {
              rmSync(file, { force: true })
              continue
            }
            if (result.status !== "fail" && result.status !== "pending") continue
            const key = nudgeKey(result.entries)
            if (!key || !nudgeAllowed(result.status, key, nudges)) continue
            bumpNudge(result.status, key, nudges)
            await ctx.session.prompt({ sessionID, text: feedback(result) })
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
