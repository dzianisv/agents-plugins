import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

export type GateStatus = "pass" | "fail" | "pending"

export type Check = {
  name: string
  state: string
  url: string
  pr: number | null
  kind: string
  message?: string
}

export type Entry = {
  repo: string
  owner: string
  name: string
  branch: string
  sha: string
  status: GateStatus
  checks: Check[]
  error?: string | null
}

export type Gate = {
  status: GateStatus
  message: string
  entries: Entry[]
  error?: string
}

export type Recorded = {
  recorded: Array<{ repo: string; owner: string; name: string; branch: string; sha: string }>
  skipped?: Array<{ branch?: string; reason?: string }>
}

export type Nudges = Record<string, { pending?: number; fail?: number }>

export const stateDir = () =>
  process.env.TASK_GH_GUARD_STATE_DIR || join(homedir(), ".agents", "state", "task-gh-guard")

export const binPath = () =>
  process.env.TASK_GH_GUARD_BIN || join(here, "..", "bin", "pr-ci-gate")

export function stateFile(runtime: string, sessionID: string): string {
  const safe = sessionID.replace(/[^A-Za-z0-9_.-]/g, "_") || "unknown"
  return join(stateDir(), `${runtime}-${safe}.json`)
}

// Mirrors the CLI detector; a false positive only costs one python spawn.
const PUSH =
  /(?:^|[;&|\n]\s*)(?:[^\s;&|]*\/)?(?:git\s+(?:-C\s+\S+\s+)?push|gh\s+stack\s+(?:push|submit|link)|git-sign-batch)\b/

export function isPushCommand(command: unknown): boolean {
  return typeof command === "string" && PUSH.test(command)
}

type Run = { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], timeout: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      })
    })
  })
}

export async function record(sessionID: string, command: string, cwd: string): Promise<Recorded> {
  if (!isPushCommand(command)) return { recorded: [] }
  const result = await run(
    "python3",
    [binPath(), "record", "--runtime", "opencode", "--session", sessionID, "--cwd", cwd, "--command", command],
    30000,
  )
  try {
    return JSON.parse(result.stdout) as Recorded
  } catch {
    return { recorded: [] }
  }
}

export type Review = { decision: "allow" | "deny" | "skip"; reason: string }

export const reviewPath = () =>
  process.env.TASK_GH_GUARD_REVIEW_BIN || join(here, "..", "bin", "git-rules-review")

// Asks the judge model whether a git or GitHub write breaks the rules file; a broken review allows.
export async function review(command: unknown): Promise<Review> {
  if (typeof command !== "string") return { decision: "skip", reason: "" }
  const result = await run("python3", [reviewPath(), "check", "--command", command], 120000)
  try {
    const parsed = JSON.parse(result.stdout) as Review
    if (parsed && ["allow", "deny", "skip"].includes(parsed.decision)) return parsed
  } catch {
    // fall through
  }
  return { decision: "skip", reason: "rule review skipped" }
}

export async function gate(file: string): Promise<Gate> {
  if (!existsSync(file)) return { status: "pass", message: "", entries: [] }
  const result = await run("python3", [binPath(), "--state", file, "--json"], 110000)
  try {
    const parsed = JSON.parse(result.stdout) as Gate
    if (parsed && (parsed.status === "pass" || parsed.status === "fail" || parsed.status === "pending")) {
      return parsed
    }
  } catch {
    // fall through: a broken check must never block a session
  }
  return { status: "pass", message: "", entries: [], error: result.stderr.trim().slice(0, 300) }
}

export function nudgeKey(entries: Entry[]): string {
  return entries
    .filter((entry) => entry.status !== "pass")
    .map((entry) => `${entry.branch}@${entry.sha}`)
    .sort()
    .join(",")
}

export function nudgeAllowed(kind: "pending" | "fail", key: string, nudges: Nudges): boolean {
  const seen = nudges[key] ?? {}
  return kind === "pending" ? !seen.pending : (seen.fail ?? 0) < 3
}

export function bumpNudge(kind: "pending" | "fail", key: string, nudges: Nudges): void {
  const seen = (nudges[key] ??= {})
  if (kind === "pending") seen.pending = (seen.pending ?? 0) + 1
  else seen.fail = (seen.fail ?? 0) + 1
}

export function feedback(result: Gate): string {
  const body = result.message || `CI is ${result.status} for a commit this session pushed.`
  return result.status === "pending"
    ? `${body}\n\nSay it is pending; do not claim done.`
    : `${body}\n\nFix the failing check or report it as a known failure; do not claim the task is done.`
}
