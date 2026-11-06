// Per-session state for the Claude Code audit: pending notes, the audited-message marker, the
// session lock and rerun flag, and SessionEnd cleanup. The lock is created atomically (a hard
// link, so its pid is complete when it appears) with a pid plus mtime stale check; a stale lock is
// replaced under an exclusive claim that is re-checked while held. Only the owner releases a lock.
import { existsSync, linkSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { ensureDir, pruneDir, pruneLog, remove, writeAtomic, writePrivate, LOG_PRUNE_DAYS } from "./audit-log"

/** Session state files older than this many days are pruned at SessionEnd. */
export const PRUNE_DAYS = 7
/** A lock is stale when its owner is gone or it is older than this many seconds. */
export const LOCK_STALE_SECONDS = 600
/** A steal claim is stale when its owner is gone or it is older than this many seconds. */
const CLAIM_STALE_SECONDS = 10

/** The environment variables the state reads, injectable for tests. */
export type Env = Record<string, string | undefined>

/** Where pending notes, locks and the audit log live; SUPERVISOR_HOME moves it (read at call time). */
export const stateDir = (env: Env = process.env): string => env.SUPERVISOR_HOME || join(homedir(), ".cache", "supervisor")

/** Keep only characters that are safe in a file name. */
export function safeSessionId(raw: unknown): string {
  const text = typeof raw === "string" ? raw : ""
  return text.replace(/[^A-Za-z0-9_-]/g, "") || "unknown"
}

const sessionFile = (kind: string, sessionID: unknown, suffix: string, dir: string): string =>
  join(dir, kind, `${safeSessionId(sessionID)}${suffix}`)

/** Feedback waiting to be delivered on the next prompt. */
export const pendingPath = (sessionID: unknown, dir = stateDir()): string => sessionFile("pending", sessionID, ".txt", dir)
/** Marks a running audit. */
export const lockPath = (sessionID: unknown, dir = stateDir()): string => sessionFile("locks", sessionID, ".lock", dir)
/** Marks that a Stop arrived while an audit was running. */
export const rerunPath = (sessionID: unknown, dir = stateDir()): string => sessionFile("locks", sessionID, ".rerun", dir)
/** Holds the uuid of the last message with a valid verdict. */
export const auditedPath = (sessionID: unknown, dir = stateDir()): string => sessionFile("state", sessionID, ".json", dir)
/** Claim taken while replacing a stale lock, so two processes never replace it at once. */
export const claimPath = (sessionID: unknown, dir = stateDir()): string => `${lockPath(sessionID, dir)}.claim`

/** The JSON object Claude Code sends on stdin, or {} when it is absent or not an object. */
export function parseHookInput(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** True when a process with this pid exists. */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A lock is stale when its owner is gone or it is older than LOCK_STALE_SECONDS. */
export function lockIsStale(path: string): boolean {
  return staleLockFile(path, LOCK_STALE_SECONDS)
}

/** A claim is stale when its owner is gone or it is older than CLAIM_STALE_SECONDS. */
function claimIsStale(path: string): boolean {
  return staleLockFile(path, CLAIM_STALE_SECONDS)
}

function staleLockFile(path: string, staleSeconds: number): boolean {
  try {
    const ageSeconds = (Date.now() - statSync(path).mtimeMs) / 1000
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
    if (!Number.isFinite(pid)) return true
    return ageSeconds > staleSeconds || !pidAlive(pid)
  } catch {
    return true
  }
}

/** Create a file holding our pid exclusively; the content is complete when it appears. */
function createExclusive(path: string): boolean {
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
  writePrivate(tmp, String(process.pid))
  try {
    linkSync(tmp, path)
    return true
  } catch {
    return false
  } finally {
    remove(tmp)
  }
}

/**
 * Take the session lock; false when a live audit holds it. Creation is atomic (a hard link, so the
 * pid is complete when the lock appears). A stale lock is replaced under an exclusive claim and the
 * staleness is re-checked while holding it, so a racer that read the old lock cannot remove a fresh
 * one. Only the owner releases the lock.
 */
export function acquireLock(sessionID: unknown, dir = stateDir()): boolean {
  const path = lockPath(sessionID, dir)
  ensureDir(dir)
  ensureDir(dirname(path))
  if (createExclusive(path)) return true
  if (!lockIsStale(path)) return false

  const claim = claimPath(sessionID, dir)
  if (!takeClaim(claim)) return false
  try {
    if (!lockIsStale(path)) return false
    remove(path)
    return createExclusive(path)
  } finally {
    remove(claim)
  }
}

function takeClaim(claim: string): boolean {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (createExclusive(claim)) return true
    if (!claimIsStale(claim)) return false
    remove(claim)
  }
  return false
}

/** Drop the session lock if this process still owns it. */
export function releaseLock(sessionID: unknown, dir = stateDir()): void {
  const path = lockPath(sessionID, dir)
  try {
    const owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
    if (owner === process.pid) remove(path)
  } catch {}
}

/** Ask the running audit to go again when it finishes. */
export function setRerun(sessionID: unknown, dir = stateDir()): void {
  const path = rerunPath(sessionID, dir)
  ensureDir(dir)
  ensureDir(dirname(path))
  writePrivate(path, "")
}

/** True once if a rerun was requested; clears the flag. */
export function takeRerun(sessionID: unknown, dir = stateDir()): boolean {
  const path = rerunPath(sessionID, dir)
  if (!existsSync(path)) return false
  remove(path)
  return true
}

/** Uuid of the last audited message, or an empty string. */
export function lastAudited(sessionID: unknown, dir = stateDir()): string {
  try {
    const data = JSON.parse(readFileSync(auditedPath(sessionID, dir), "utf8")) as { messageID?: unknown }
    return typeof data?.messageID === "string" ? data.messageID : ""
  } catch {
    return ""
  }
}

/** Remember the last message that got a valid verdict. */
export function markAudited(sessionID: unknown, messageID: string, dir = stateDir()): void {
  ensureDir(dir)
  writeAtomic(auditedPath(sessionID, dir), JSON.stringify({ messageID }))
}

/** The pending feedback text for a session, or an empty string. */
export function readPending(sessionID: unknown, dir = stateDir()): string {
  try {
    return readFileSync(pendingPath(sessionID, dir), "utf8")
  } catch {
    return ""
  }
}

/** Write the pending feedback text for a session. */
export function writePending(sessionID: unknown, text: string, dir = stateDir()): void {
  ensureDir(dir)
  writeAtomic(pendingPath(sessionID, dir), text)
}

/** Delete the pending feedback text for a session. */
export function clearPending(sessionID: unknown, dir = stateDir()): void {
  remove(pendingPath(sessionID, dir))
}

/** Delete a session's lock, rerun and state files when no live audit owns the lock, then prune week-old leftovers. */
export function cleanupSession(sessionID: unknown, dir = stateDir(), now = Date.now()): void {
  const lock = lockPath(sessionID, dir)
  if (lockIsStale(lock)) {
    for (const path of [lock, rerunPath(sessionID, dir), auditedPath(sessionID, dir)]) remove(path)
  }
  pruneDir(join(dir, "pending"), "*.txt", PRUNE_DAYS, now)
  pruneDir(join(dir, "state"), "*.json", PRUNE_DAYS, now)
  pruneDir(join(dir, "locks"), "*.claim", PRUNE_DAYS, now)
  pruneDir(join(dir, "locks"), "*.tmp", PRUNE_DAYS, now)
  pruneDir(join(dir, "locks"), "*.lock", PRUNE_DAYS, now)
  pruneLog(dir, LOG_PRUNE_DAYS, now)
}
