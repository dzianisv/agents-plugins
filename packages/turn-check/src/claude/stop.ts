#!/usr/bin/env bun
// Stop hook: audit the finished turn now and hand the agent the findings, so a rule violation is
// fixed immediately instead of waiting for the next user message. An audit error never blocks.
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ERROR_PREFIX } from "../core/prompt"
import { clearPending, parseHookInput, readPending, safeSessionId, stateDir, type Env } from "../core/state"
import { run, settleSeconds, type RunOptions } from "./audit"

/** True when the cwd is the judge's own temp dir, i.e. the audit is running inside the judge session. */
function isJudgeDir(cwd: unknown): boolean {
  return typeof cwd === "string" && cwd.startsWith(join(tmpdir(), "supervisor-"))
}

/** False when the hook is disabled, runs inside the judge, repeats a Stop, or has no transcript. */
export function shouldAudit(data: Record<string, unknown>, env: Env = process.env, exists: (path: string) => boolean = existsSync): boolean {
  // The child flag only silences the judge's own session; a leaked flag must not disable audits elsewhere.
  if (env.SUPERVISOR_ENABLED === "0") return false
  if (env.SUPERVISOR_CHILD === "1" && isJudgeDir(data.cwd)) return false
  if (data.stop_hook_active) return false
  const transcript = data.transcript_path
  return typeof transcript === "string" && exists(transcript)
}

/** Audit the finished turn; block the stop with the findings when a rule was broken. */
export async function main(input: string, options: { env?: Env; once?: RunOptions["once"] } = {}): Promise<number> {
  const env = options.env ?? process.env
  const data = parseHookInput(input)
  if (!shouldAudit(data, env)) return 0
  const sessionID = safeSessionId(data.session_id)
  const dir = stateDir(env)
  await new Promise((resolve) => setTimeout(resolve, settleSeconds(env) * 1000))
  await run(sessionID, String(data.transcript_path), { env, once: options.once })
  const feedback = readPending(sessionID, dir).trim()
  if (!feedback) return 0
  // An audit error is not a violation: leave the note for the next prompt instead of blocking.
  if (feedback.startsWith(ERROR_PREFIX)) return 0
  clearPending(sessionID, dir)
  process.stdout.write(`${JSON.stringify({ decision: "block", reason: feedback })}\n`)
  return 0
}

if (import.meta.main) {
  try {
    process.exit(await main(readFileSync(0, "utf8")))
  } catch {
    process.exit(0)
  }
}
