#!/usr/bin/env bun
// SessionEnd hook: report a session that ended with CI still red or pending, so an interrupted or
// abandoned turn is not silent. It never blocks and never deletes state.
import { existsSync } from "node:fs"
import { gate } from "../core/gate"
import { statePath } from "../core/state"
import { notify } from "../shared/notify"
import { readHookInput, sessionID } from "./input"

try {
  if (process.env.TASK_GH_GUARD_ENABLED !== "0") {
    const data = readHookInput()
    const state = statePath("claude", sessionID(data))
    if (existsSync(state)) {
      const result = await gate(state)
      if (result.status === "fail" || result.status === "pending") {
        const label = result.status === "fail" ? "CI failed" : "CI pending"
        await notify("task-gh-guard", `session ended with ${label} on a commit it pushed:\n${result.message}`)
      }
    }
  }
} catch {
  // a hook must never break the session
}
