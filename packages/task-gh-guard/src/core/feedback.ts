// Stop and nudge texts shared by the opencode adapters.
import type { Gate } from "./gate"

/** The opencode nudge text for a failing or pending gate. */
export function nudgeText(result: Gate): string {
  const body = result.message || `CI is ${result.status} for a commit this session pushed.`
  const head = `[task-gh-guard] ${body}`
  return result.status === "pending"
    ? `${head}\n\nSay it is pending; do not claim done.`
    : `${head}\n\nFix the failing check or report it as a known failure; do not claim the task is done.`
}

/** The Claude Code stop-block reason for a failing or pending gate. */
export function stopReason(result: Gate): string {
  const body = result.message || `CI is ${result.status} for a commit this session pushed.`
  const head = `[task-gh-guard] ${body}`
  return result.status === "pending"
    ? `${head}\nSay it is pending; do not claim done.`
    : `${head}\nFix the failing check or report it as a known failure; do not claim the task is done.`
}
