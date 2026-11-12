#!/usr/bin/env bun
// PreToolUse hook: warn or deny a write that duplicates a declaration in the index.
import { decide } from "../core/decide"
import { shellTargets } from "../core/shell"
import { writeTarget } from "../core/write"
import { readHookInput } from "./input"

const TOOLS = new Set(["Write", "Edit", "MultiEdit"])

try {
  const data = readHookInput()
  const tool = typeof data.tool_name === "string" ? data.tool_name : ""
  const input = data.tool_input
  if (input && (TOOLS.has(tool) || tool === "Bash")) {
    const cwd = typeof data.cwd === "string" ? data.cwd : process.cwd()
    const single = TOOLS.has(tool) ? writeTarget(input, cwd) : undefined
    const targets = single
      ? [single]
      : tool === "Bash" && typeof input.command === "string"
        ? shellTargets(input.command, cwd)
        : []
    for (const target of targets) {
      const decision = decide(target, "claude")
      if (decision.action === "deny") {
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.message,
            },
          }),
        )
        break
      }
      if (decision.action === "warn") console.log(JSON.stringify({ systemMessage: decision.message }))
    }
  }
} catch {
  // a hook must never break the session
}
