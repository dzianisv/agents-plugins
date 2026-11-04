import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, rmSync } from "node:fs"
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
} from "./core"

const TOOLS = new Set(["bash", "shell"])

export const TaskGhGuard: Plugin = async ({ client, directory }) => {
  if (process.env.TASK_GH_GUARD_ENABLED === "0") return {}

  const commands = new Map<string, string>()
  const nudges: Nudges = {}
  const running = new Set<string>()

  const log = (level: "info" | "error", message: string) =>
    client.app.log({ body: { service: "task-gh-guard", level, message } }).catch(() => {})

  const nudge = async (sessionID: string, result: Gate) => {
    const kind = result.status === "fail" ? "fail" : "pending"
    const key = nudgeKey(result.entries)
    if (!key || !nudgeAllowed(kind, key, nudges)) return
    bumpNudge(kind, key, nudges)
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: feedback(result) }] },
    })
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!TOOLS.has(input.tool)) return
      const command = (output.args ?? {}).command
      if (isPushCommand(command)) commands.set(input.callID, command)
    },

    "tool.execute.after": async (input) => {
      if (!TOOLS.has(input.tool)) return
      const command = commands.get(input.callID) ?? (input as any).args?.command
      commands.delete(input.callID)
      if (!isPushCommand(command)) return
      try {
        await record(input.sessionID, command, directory)
      } catch (err) {
        log("error", `record failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (!sessionID || running.has(sessionID)) return
      const file = stateFile("opencode", sessionID)
      if (!existsSync(file)) return
      running.add(sessionID)
      try {
        const info = await client.session.get({ path: { id: sessionID } }).catch(() => undefined)
        if (info?.data?.parentID) return
        const result = await gate(file)
        if (result.status === "pass") {
          rmSync(file, { force: true })
          return
        }
        if (result.status !== "fail" && result.status !== "pending") return
        await nudge(sessionID, result)
      } catch (err) {
        log("error", `gate failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        running.delete(sessionID)
      }
    },
  }
}
