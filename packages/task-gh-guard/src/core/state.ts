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

/** One budget key per pushed commit, so a new commit still blocks inside the window. */
export function reportKey(entry: ReportEntry): string {
  return `${repoKey(entry)}|${entry.branch ?? "?"}@${String(entry.sha ?? "").slice(0, 7)}`
}

/** Seconds before the same commit may block a stop again (default: one hour). */
export function blockWindow(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.TASK_GH_GUARD_BLOCK_WINDOW ?? "").trim()
  if (!/^[+-]?\d+$/.test(raw)) return 3600
  return Math.max(0, Number.parseInt(raw, 10))
}

/** True when every given commit blocked a stop within the window. */
export function reported(path: string, entries: ReportEntry[], now: number, window: number): boolean {
  if (!entries.length || window <= 0) return false
  const seen = readState(path).reported
  if (!seen || typeof seen !== "object") return false
  for (const entry of entries) {
    const at = seen[reportKey(entry)]?.at
    if (typeof at !== "number" || now - at >= window) return false
  }
  return true
}

/** Blocks allowed per branch inside one window (default 3), so a new commit cannot re-arm forever. */
export function maxBlocks(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.TASK_GH_GUARD_MAX_BLOCKS ?? "").trim()
  if (!/^\+?\d+$/.test(raw)) return 3
  return Number.parseInt(raw, 10)
}

/** How many stops this branch already blocked inside the window, across every sha. */
export function blocksInWindow(path: string, entry: ReportEntry, now: number, window: number): number {
  if (window <= 0) return 0
  const seen = readState(path).reported
  if (!seen || typeof seen !== "object") return 0
  const prefix = `${repoKey(entry)}|${entry.branch ?? "?"}@`
  let count = 0
  for (const [key, value] of Object.entries(seen)) {
    const at = value?.at
    if (key.startsWith(prefix) && typeof at === "number" && now - at < window) count++
  }
  return count
}

/** Marks every given commit as reported at `now`. */
export function markReported(path: string, entries: ReportEntry[], now: number): void {
  const data = readState(path)
  const seen = data.reported && typeof data.reported === "object" ? data.reported : {}
  for (const entry of entries) seen[reportKey(entry)] = { at: now }
  data.reported = seen
  data.updated_at = now
  writeState(path, data)
}
