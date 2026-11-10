#!/usr/bin/env bun
// Stop hook: block the stop while CI for a pushed commit is red or still running.
import { existsSync } from "node:fs"
import { stopReason } from "../core/feedback"
import { gate, type Gate } from "../core/gate"
import { markReported, reported, statePath } from "../core/state"
import { notify } from "../shared/notify"
import { readHookInput, sessionID } from "./input"

try {
  if (process.env.TASK_GH_GUARD_ENABLED !== "0") {
    const data = readHookInput()
    const state = statePath("claude", sessionID(data))
    if (existsSync(state)) {
      let result: Gate | undefined
      try {
        result = await gate(state)
      } catch (err) {
        await notify("task-gh-guard", `CI check could not run: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (result && (result.status === "fail" || result.status === "pending")) {
        for (const entry of result.entries) {
          if (entry.error) {
            await notify("task-gh-guard", `CI check could not read ${entry.branch}@${entry.sha.slice(0, 7)}: ${entry.error}`)
          }
        }
        if (!data.stop_hook_active) {
          const failing = result.entries.filter((entry) => entry.status !== "pass")
          if (reported(state, failing)) {
            // Already delivered for this commit: a later stop on the same red commit only notifies.
            const labels = failing.map((entry) => `${entry.branch}@${entry.sha.slice(0, 7)}`).join(", ")
            await notify("task-gh-guard", `CI still red on ${labels}; already reported, not blocking again.`)
          } else {
            markReported(state, failing, Math.floor(Date.now() / 1000))
            console.log(JSON.stringify({ decision: "block", reason: stopReason(result) }))
          }
        }
      }
    }
  }
} catch {
  // a hook must never break the session
}
