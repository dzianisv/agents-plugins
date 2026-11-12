// Shared stdin reader for the Claude Code hook entrypoints.
import { readFileSync } from "node:fs"

export type HookInput = {
  session_id?: unknown
  cwd?: unknown
  tool_name?: unknown
  tool_input?: Record<string, unknown>
  stop_hook_active?: unknown
}

/** The JSON object Claude Code sends on stdin, or {} when it is absent or not an object. */
export function readHookInput(): HookInput {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8")) as unknown
    return payload && typeof payload === "object" ? (payload as HookInput) : {}
  } catch {
    return {}
  }
}
