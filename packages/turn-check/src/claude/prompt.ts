#!/usr/bin/env bun
// UserPromptSubmit hook: hand the agent the pending audit feedback once, then delete it.
import { readFileSync } from "node:fs"
import { ERROR_PREFIX } from "../core/prompt"
import { remove } from "../core/audit-log"
import { parseHookInput, pendingPath } from "../core/state"

/** Number of bullet lines in the feedback text. */
export function countViolations(feedback: string): number {
  return feedback.split("\n").filter((line) => line.startsWith("- ")).length
}

/** The hook JSON for one pending note: the ERROR line when the audit failed, the count otherwise. Null when there is nothing to show. */
export function hookOutput(feedback: string): { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } } | null {
  if (!feedback) return null
  const failed = feedback.split("\n").find((line) => line.startsWith(ERROR_PREFIX))
  return {
    systemMessage: failed ?? `supervisor: ${countViolations(feedback)} rule violation(s) from your last turn`,
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `<system-reminder>\n${feedback}\n</system-reminder>` },
  }
}

/** Print the hook output for this session's pending feedback and delete the file. Prints nothing when there is none. */
export function main(input: string): number {
  const data = parseHookInput(input)
  const path = pendingPath(data.session_id)
  let feedback: string
  try {
    feedback = readFileSync(path, "utf8").trim()
  } catch {
    return 0
  }
  remove(path)
  const output = hookOutput(feedback)
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main(readFileSync(0, "utf8")))
  } catch {
    process.exit(0)
  }
}
