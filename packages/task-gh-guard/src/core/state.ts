// State files and block-window bookkeeping for task-gh-guard.
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

export type StateEntry = {
  repo?: string
  owner?: string
  name?: string
  branch?: string
  sha?: string
  pushed_at?: number | null
}

// The subset of a gate entry the block budget needs; keeps Entry and StateEntry both usable.
export type ReportEntry = {
  repo?: string | null
  owner?: string | null
  name?: string | null
  branch?: string | null
  sha?: string | null
}

export type StateData = {
  version: number
  runtime?: string
  session_id?: string
  entries: StateEntry[]
  reported?: Record<string, { at?: number }>
  updated_at?: number
}

/** Expands a leading `~` to the user's home directory. */
export function expandUser(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

/** The directory holding the session state files. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return expandUser(env.TASK_GH_GUARD_STATE_DIR ?? "~/.agents/state/task-gh-guard")
}

/** Replaces every character that is unsafe in a file name; an empty id becomes `unknown`. */
export function safeSessionID(sessionID: unknown): string {
  const raw = typeof sessionID === "string" ? sessionID : ""
  return raw.replace(/[^A-Za-z0-9_.-]/g, "_") || "unknown"
}

/** `<state dir>/<runtime>-<session id>.json`, the file a hook records into. */
export function statePath(runtime: string, sessionID: unknown, env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), `${runtime}-${safeSessionID(sessionID)}.json`)
}

/** Reads a state file; anything unreadable falls back to an empty state. */
export function readState(path: string): StateData {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (data && typeof data === "object" && Array.isArray((data as { entries?: unknown }).entries)) {
      return data as StateData
    }
  } catch {}
  return { version: 1, entries: [] }
}

// Python wrote the state with json.dump(sort_keys=True); keep the files deterministic.
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, item]) => [key, sortedKeys(item)]))
  }
  return value
}

/** Replaces the state file atomically, mode 0600 inside a 0700 directory. */
export function writeState(path: string, data: StateData): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  chmodSync(parent, 0o700)
  const tmp = join(parent, `.${basename(path)}.${process.pid}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(sortedKeys(data), null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Stable identity of a recorded commit for the block budget. */
export function repoKey(entry: ReportEntry): string {
  return entry.repo || (entry.owner && entry.name ? `${entry.owner}/${entry.name}` : "") || "unknown"
}

/** One report key per pushed commit: each commit is delivered for once, ever. */
export function reportKey(entry: ReportEntry): string {
  return `${repoKey(entry)}|${entry.branch ?? "?"}@${String(entry.sha ?? "").slice(0, 7)}`
}

// The report lives in its own file, next to the state file but never deleted with it: the gate
// removes the state file when every recorded commit passes, and a report stored there would reset and
// re-fire the block on the next push (that is the loop this file exists to prevent).
const budgetPathFor = (path: string): string => join(dirname(path), "budget", basename(path))

/** The recorded deliveries for a session, keyed by repo|branch@sha7. */
export function readBudget(path: string): Record<string, { at: number }> {
  try {
    const data = JSON.parse(readFileSync(budgetPathFor(path), "utf8")) as unknown
    return data && typeof data === "object" ? (data as Record<string, { at: number }>) : {}
  } catch {
    return {}
  }
}

/** Replaces the recorded deliveries for a session. */
export function writeBudget(path: string, budget: Record<string, { at: number }>): void {
  const file = budgetPathFor(path)
  const parent = dirname(file)
  mkdirSync(parent, { recursive: true })
  chmodSync(parent, 0o700)
  writeFileSync(file, `${JSON.stringify(budget, null, 2)}\n`, { mode: 0o600 })
}

/**
 * True when every given commit has already been delivered for. There is no window: a commit is
 * delivered once and never again, so a stop that repeats the same red commit only notifies.
 */
export function reported(path: string, entries: ReportEntry[]): boolean {
  if (!entries.length) return false
  const seen = readBudget(path)
  return entries.every((entry) => typeof seen[reportKey(entry)]?.at === "number")
}

/** Marks every given commit as delivered. */
export function markReported(path: string, entries: ReportEntry[], now: number): void {
  const seen = readBudget(path)
  for (const entry of entries) seen[reportKey(entry)] = { at: now }
  writeBudget(path, seen)
}
