// opencode v1 plugin: review git writes, record pushes and nudge when CI is red or pending.
import type { Plugin } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import { nudgeText } from "../core/feedback"
import { gate, record, type Gate } from "../core/gate"
import { isPushCommand } from "../core/push"
import { reviewCommand } from "../core/review"
import { markReported, reported, statePath } from "../core/state"
import { notify } from "../shared/notify"

const TOOLS = new Set(["bash", "shell"])

/** opencode v1 plugin: review git writes, record pushes and nudge when CI is red or pending. */
export const TaskGhGuard: Plugin = async ({ client, directory }) => {
  if (process.env.TASK_GH_GUARD_ENABLED === "0") return {}

  const commands = new Map<string, string>()
  const running = new Set<string>()

  const log = (level: "info" | "error", message: string) => {
    if (level === "error") void notify("task-gh-guard", message, { client })
    return client.app.log({ body: { service: "task-gh-guard", level, message } }).catch(() => {})
  }

  const nudge = async (sessionID: string, result: Gate) => {
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: nudgeText(result) }] },
    })
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!TOOLS.has(input.tool)) return
      const command = (output.args ?? {}).command
      const warning = await reviewCommand(command)
      if (warning) log("error", warning)
      if (isPushCommand(command)) commands.set(input.callID, command)
    },

    "tool.execute.after": async (input) => {
      if (!TOOLS.has(input.tool)) return
      const fallback = (input as { args?: { command?: unknown } }).args?.command
      const command = commands.get(input.callID) ?? fallback
      commands.delete(input.callID)
      if (typeof command !== "string" || !isPushCommand(command)) return
      try {
        await record("opencode", input.sessionID, directory, command)
      } catch (err) {
        log("error", `record failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (!sessionID || running.has(sessionID)) return
      const file = statePath("opencode", sessionID)
      if (!existsSync(file)) return
      running.add(sessionID)
      try {
        const info = await client.session.get({ path: { id: sessionID } }).catch(() => undefined)
        if (info?.data?.parentID) return
        const result = await gate(file)
        if (result.status === "pass") return
        if (result.status !== "fail" && result.status !== "pending") return
        const failing = result.entries.filter((entry) => entry.status !== "pass")
        if (reported(file, failing)) {
          log("error", "CI still red; already reported, not nudging again.")
          return
        }
        await nudge(sessionID, result)
        // One delivery per commit, for good: recorded so a restart or the v2 server cannot re-fire it.
        markReported(file, failing, Math.floor(Date.now() / 1000))
      } catch (err) {
        log("error", `gate failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        running.delete(sessionID)
      }
    },
  }
}
