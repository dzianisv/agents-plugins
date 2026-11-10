#!/usr/bin/env bun
// Stop hook: block the stop while CI for a pushed commit is red or still running.
import { existsSync } from "node:fs"
import { stopReason } from "../core/feedback"
import { gate, type Gate } from "../core/gate"
import { blockWindow, blocksInWindow, markReported, maxBlocks, reported, statePath } from "../core/state"
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
          const now = Math.floor(Date.now() / 1000)
          const window = blockWindow()
          const failing = result.entries.filter((entry) => entry.status !== "pass")
          const capped = failing.every((entry) => blocksInWindow(state, entry, now, window) >= maxBlocks())
          if (capped) {
            // A branch that keeps failing with new commits must not nag forever: notify once, stop blocking.
            const labels = failing.map((entry) => `${entry.branch}@${entry.sha.slice(0, 7)}`).join(", ")
            await notify("task-gh-guard", `CI still red on ${labels} after ${maxBlocks()} blocks this hour; not blocking again until the window passes.`)
          } else if (!reported(state, failing, now, window)) {
            markReported(state, failing, now)
            console.log(JSON.stringify({ decision: "block", reason: stopReason(result) }))
          }
        }
      }
    }
  }
} catch {
  // a hook must never break the session
}
