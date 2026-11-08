// Stop and nudge texts, and the in-memory nudge budget shared by the opencode adapters.
import type { Entry, Gate } from "./gate"

export type Nudges = Record<string, { pending?: number; fail?: number }>

/** One key per failing SHA set, so a new push resets the budget. */
export function nudgeKey(entries: Entry[]): string {
  return entries
    .filter((entry) => entry.status !== "pass")
    .map((entry) => `${entry.branch}@${entry.sha}`)
    .sort()
    .join(",")
}

/** Pending nudges once per SHA set; a failure nudges up to three times. */
export function nudgeAllowed(kind: "pending" | "fail", key: string, nudges: Nudges): boolean {
  const seen = nudges[key] ?? {}
  return kind === "pending" ? !seen.pending : (seen.fail ?? 0) < 3
}

/** Records one nudge of `kind` for `key`. */
export function bumpNudge(kind: "pending" | "fail", key: string, nudges: Nudges): void {
  const seen = (nudges[key] ??= {})
  if (kind === "pending") seen.pending = (seen.pending ?? 0) + 1
  else seen.fail = (seen.fail ?? 0) + 1
}

/** The opencode nudge text for a failing or pending gate. */
export function nudgeText(result: Gate): string {
  const body = result.message || `CI is ${result.status} for a commit this session pushed.`
  return result.status === "pending"
    ? `${body}\n\nSay it is pending; do not claim done.`
    : `${body}\n\nFix the failing check or report it as a known failure; do not claim the task is done.`
}

/** The Claude Code stop-block reason for a failing or pending gate. */
export function stopReason(result: Gate): string {
  const body = result.message || `CI is ${result.status} for a commit this session pushed.`
  return result.status === "pending"
    ? `${body}\nSay it is pending; do not claim done.`
    : `${body}\nFix the failing check or report it as a known failure; do not claim the task is done.`
}
