// The shared audit log: appends, 30-day pruning, and the private file/directory helpers the
// state files use. Every created file is 0600, every created directory 0700.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/** Audit log entries older than this many days are dropped. */
export const LOG_PRUNE_DAYS = 30

/** Create a directory (and its parents) with mode 0700, tightening it when it already exists. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

/** Write text to a file created 0600 and tightened to 0600 if it already exists. */
export function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Append text to a file created 0600 and tightened to 0600 if it already exists. */
export function appendPrivate(path: string, text: string): void {
  appendFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Delete a file, ignoring a missing one. */
export function remove(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {}
}

/** Write text so a reader never sees a half-written file. */
export function writeAtomic(path: string, text: string): void {
  ensureDir(dirname(path))
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  writePrivate(tmp, text)
  renameSync(tmp, path)
}

/** Append one line to the audit log. Never throws. */
export function record(logDir: string, entry: Record<string, unknown>): void {
  try {
    ensureDir(logDir)
    appendPrivate(join(logDir, "audits.jsonl"), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
  } catch {}
}

/** Keep the JSONL lines whose time is within maxAgeMs of now; lines that are not JSON or have no valid time are dropped. */
export function pruneAuditLines(text: string, now: number, maxAgeMs: number): string {
  const kept = text.split("\n").filter((line) => {
    if (!line.trim()) return false
    try {
      const raw = JSON.parse(line) as { time?: unknown }
      if (typeof raw?.time !== "string") return false
      const t = Date.parse(raw.time)
      return Number.isFinite(t) && now - t <= maxAgeMs
    } catch {
      return false
    }
  })
  return kept.length ? kept.join("\n") + "\n" : ""
}

/** Rewrite the audit log without entries older than ttlDays and without corrupt lines; leaves it alone when nothing changes. Never throws. */
export function pruneLog(logDir: string, ttlDays = LOG_PRUNE_DAYS, now = Date.now()): void {
  try {
    const path = join(logDir, "audits.jsonl")
    const text = readFileSync(path, "utf8")
    const kept = pruneAuditLines(text, now, ttlDays * 86400000)
    if (kept === text) return
    writeAtomic(path, kept)
  } catch {}
}

/** Delete files in directory that match a `*` glob and have not changed for ttlDays. Never throws. */
export function pruneDir(dir: string, pattern: string, ttlDays: number, now = Date.now()): void {
  const oldestKept = now - ttlDays * 86400000
  const matcher = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!matcher.test(name)) continue
    const path = join(dir, name)
    try {
      if (statSync(path).mtimeMs < oldestKept) remove(path)
    } catch {}
  }
}
