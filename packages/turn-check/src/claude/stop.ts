#!/usr/bin/env bun
// Stop hook: start a detached audit of the finished turn and return at once.
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseHookInput, safeSessionId, type Env } from "../core/state"

/** How the hook starts the child; injectable so tests can assert the spawn without running it. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; env: Env },
) => { unref: () => void }

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

/** Spawn the audit child in its own session so the hook does not wait for it. */
export function spawnAudit(sessionID: string, transcriptPath: string, options: { env?: Env; spawn?: SpawnFn } = {}): void {
  const spawnFn: SpawnFn = options.spawn ?? spawn
  const child = spawnFn(process.execPath, [join(import.meta.dir, "audit.ts"), sessionID, transcriptPath], {
    detached: true,
    stdio: "ignore",
    env: options.env ?? process.env,
  })
  child.unref()
}

/** Read the hook payload and, when it passes the guards, start the detached audit. Prints nothing. */
export function main(input: string, options: { env?: Env; spawn?: SpawnFn } = {}): number {
  const env = options.env ?? process.env
  const data = parseHookInput(input)
  if (!shouldAudit(data, env)) return 0
  spawnAudit(safeSessionId(data.session_id), String(data.transcript_path), { env, spawn: options.spawn })
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main(readFileSync(0, "utf8")))
  } catch {
    process.exit(0)
  }
}
