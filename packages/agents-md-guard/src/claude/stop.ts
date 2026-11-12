#!/usr/bin/env bun
// Stop hook: audit the finished turn now and hand the agent the findings, so a rule violation is
// fixed immediately instead of waiting for the next user message. The inline wait is capped; a slow
// judge falls back to the detached child and the note lands on the next prompt. An error never blocks.
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isViolationFeedback } from "../core/prompt"
import { cliJudge } from "../core/judge-cli"
import { clearPending, parseHookInput, readInjectBudget, readPending, safeSessionId, stateDir, writeInjectBudget, type Env } from "../core/state"
import { countInWindow, mayInject, recordInjection } from "../shared/inject-limit"
import { notify } from "../shared/notify"
import { auditSession, modelName, run, settleSeconds, type RunOptions } from "./audit"

/** Notes a session may receive per window, so a judge that keeps finding the same violation cannot loop. */
const MAX_INJECTIONS = 3
/** The window the injection ceiling is counted over, in seconds. */
const INJECTION_WINDOW = 3600

/** How the hook starts the fallback child; injectable so tests can assert the spawn without running it. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; env: Env },
) => { unref: () => void }

/** Seconds the Stop hook waits inline before handing the audit to the detached child (default 90). */
export const inlineTimeoutSeconds = (env: Env = process.env): number => {
  const raw = env.SUPERVISOR_INLINE_TIMEOUT
  if (raw === undefined || raw === "") return 90
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 90
}

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

/** Start the audit child in its own session so a slow judge can finish after the hook returns. */
export function spawnAudit(sessionID: string, transcriptPath: string, options: { env?: Env; spawn?: SpawnFn; cwd?: string } = {}): void {
  const spawnFn: SpawnFn = options.spawn ?? spawn
  const args = [join(import.meta.dir, "audit.ts"), sessionID, transcriptPath]
  if (options.cwd) args.push(options.cwd)
  const child = spawnFn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: options.env ?? process.env,
  })
  child.unref()
}

/** Audit the finished turn; block the stop with the findings when a rule was broken. */
export async function main(
  input: string,
  options: { env?: Env; once?: RunOptions["once"]; spawn?: SpawnFn } = {},
): Promise<number> {
  const env = options.env ?? process.env
  const data = parseHookInput(input)
  if (!shouldAudit(data, env)) return 0
  const sessionID = safeSessionId(data.session_id)
  const dir = stateDir(env)
  const transcript = String(data.transcript_path)
  const inline = inlineTimeoutSeconds(env)
  const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd()
  const once =
    options.once ??
    ((id: string, path: string) =>
      auditSession(id, path, { env, cwd, judge: cliJudge({ model: modelName(env), env, timeoutSeconds: inline }) }))
  await new Promise((resolve) => setTimeout(resolve, settleSeconds(env) * 1000))
  await run(sessionID, transcript, { env, once })
  const feedback = readPending(sessionID, dir).trim()
  if (!feedback) return 0
  // An audit error is not a violation, and an empty note is not injected: let the detached child finish
  // the error case and leave the note for the next prompt instead of blocking.
  if (!isViolationFeedback(feedback)) {
    spawnAudit(sessionID, transcript, { env, spawn: options.spawn, cwd })
    return 0
  }
  const now = Math.floor(Date.now() / 1000)
  const budget = readInjectBudget(sessionID, dir)
  if (!mayInject(budget, `${sessionID}|`, now, INJECTION_WINDOW, MAX_INJECTIONS)) {
    await notify("agents-md-guard", `not blocking again this hour: ${MAX_INJECTIONS} findings already delivered for this session.`)
    clearPending(sessionID, dir)
    return 0
  }
  writeInjectBudget(sessionID, recordInjection(budget, `${sessionID}|${countInWindow(budget, `${sessionID}|`, now, INJECTION_WINDOW)}`, now), dir)
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
