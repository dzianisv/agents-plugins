#!/usr/bin/env bun
// SessionEnd hook: delete this session's files, keeping a live audit's lock, and prune week-old leftovers.
import { readFileSync } from "node:fs"
import { cleanupSession, parseHookInput } from "../core/state"

/** Clean up after the session that just ended. Prints nothing. */
export function main(input: string): number {
  const data = parseHookInput(input)
  cleanupSession(data.session_id)
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main(readFileSync(0, "utf8")))
  } catch {
    process.exit(0)
  }
}
