#!/usr/bin/env bun
// PostToolUse hook: record a landed push so the next Stop can check its CI.
import { record } from "../core/gate"
import { isPushCommand } from "../core/push"
import { readHookInput, sessionID } from "./input"

try {
  const data = readHookInput()
  if (data.tool_name === "Bash") {
    const command = data.tool_input?.command
    if (typeof command === "string" && isPushCommand(command)) {
      const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd()
      await record("claude", sessionID(data), cwd, command)
    }
  }
} catch {
  // a recorder must never break the session
}
