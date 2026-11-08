#!/usr/bin/env bun
// PreToolUse hook: deny a git or GitHub write that breaks the plain-English rules.
import { check } from "../core/review"
import { notify } from "../shared/notify"
import { readHookInput } from "./input"

try {
  const data = readHookInput()
  const command = data.tool_input?.command
  if (data.tool_name === "Bash" && typeof command === "string") {
    const verdict = await check(command)
    if (verdict.decision === "deny") {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `task-gh-guard rules: ${verdict.reason}`,
          },
        }),
      )
    } else if (verdict.decision === "skip" && verdict.reason.startsWith("rule review skipped")) {
      await notify("task-gh-guard", verdict.reason)
      const note = `task-gh-guard: ${verdict.reason}. The git command ran without its rule check; tell the user.`
      console.log(
        JSON.stringify({
          systemMessage: note,
          hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note },
        }),
      )
    }
  }
} catch {
  // a hook must never break the session
}
