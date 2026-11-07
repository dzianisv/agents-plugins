#!/usr/bin/env bun
// Detached audit child started by the Stop hook: judge the transcript with `opencode run`.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { auditOnce, type AuditOutcome, type Judge } from "../core/audit"
import { record } from "../core/audit-log"
import { cliJudge } from "../core/judge-cli"
import { DEFAULT_MODEL } from "../core/prompt"
import { acquireLock, clearPending, lastAudited, markAudited, readPending, releaseLock, setRerun, stateDir, takeRerun, writePending, type Env } from "../core/state"
import { buildMessages, lastEntryUuid, loadEntries, type ClaudeEntry } from "../core/transcript-claude"
import { notify } from "../shared/notify"

/** Agent name recorded in the audit log for Claude Code. */
export const AGENT = "claude-code"

/** The judge model spec, provider/model. */
export const modelName = (env: Env = process.env): string => env.SUPERVISOR_MODEL || DEFAULT_MODEL

/** The rules file, read fresh on every audit. */
export const rulesPath = (env: Env = process.env): string => env.SUPERVISOR_RULES || join(homedir(), ".agents", "AGENTS.md")

/** The agent-output cap for one audit. */
export const maxChars = (env: Env = process.env): number => Number(env.SUPERVISOR_MAX_CHARS || 60000)

/** Seconds to wait for the transcript file to catch up before auditing. */
export const settleSeconds = (env: Env = process.env): number => Number(env.SUPERVISOR_SETTLE_SECONDS || 2)

/** Options for one audit attempt. */
export type AuditSessionOptions = { env?: Env; judge?: Judge }

/** Audit the newest state of one transcript once, wired to the file state and the CLI judge. */
export async function auditSession(sessionID: string, transcriptPath: string, options: AuditSessionOptions = {}): Promise<AuditOutcome> {
  const env = options.env ?? process.env
  let entries: ClaudeEntry[]
  try {
    entries = loadEntries(transcriptPath)
  } catch {
    return "skipped"
  }
  const msgs = buildMessages(entries)
  const messageID = lastEntryUuid(entries)
  const dir = stateDir(env)
  const model = modelName(env)
  return auditOnce({
    sessionID,
    msgs,
    messageID,
    rules: () => readFileSync(rulesPath(env), "utf8"),
    judge: options.judge ?? cliJudge({ model, env }),
    maxChars: maxChars(env),
    model,
    agent: AGENT,
    store: {
      lastAudited: () => lastAudited(sessionID, dir),
      markAudited: (id) => markAudited(sessionID, id, dir),
      readPending: () => readPending(sessionID, dir),
      writePending: (text) => writePending(sessionID, text, dir),
      clearPending: () => clearPending(sessionID, dir),
    },
    record: (entry) => record(dir, entry),
    notify: async (message) => {
      await notify("turn-check", message)
    },
    notifyFeedback: async (summary) => {
      await notify("turn-check feedback", summary, { level: "warning", dedupe: false })
    },
  })
}

/** Options for the lock loop; `once` is injectable so tests can drive the lock without a judge. */
export type RunOptions = { env?: Env; once?: (sessionID: string, transcriptPath: string) => Promise<AuditOutcome> }

/** Audit under the session lock; a Stop that arrives mid-audit sets a flag and the audit goes again. */
export async function run(sessionID: string, transcriptPath: string, options: RunOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const dir = stateDir(env)
  const once = options.once ?? ((id, path) => auditSession(id, path, { env }))
  if (!acquireLock(sessionID, dir)) {
    setRerun(sessionID, dir)
    if (!acquireLock(sessionID, dir)) return
    takeRerun(sessionID, dir)
  }
  for (;;) {
    try {
      await once(sessionID, transcriptPath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      record(dir, { agent: AGENT, sessionID, error: `audit crashed: ${message}`.slice(0, 300) })
      void notify("turn-check", `audit crashed: ${message}`)
    }
    releaseLock(sessionID, dir)
    if (!takeRerun(sessionID, dir) || !acquireLock(sessionID, dir)) return
  }
}

/** Entry point: audit.ts <session_id> <transcript_path>; waits SUPERVISOR_SETTLE_SECONDS first. */
export async function main(argv: string[], options: { env?: Env; once?: RunOptions["once"] } = {}): Promise<number> {
  if (argv.length !== 3) return 0
  const env = options.env ?? process.env
  await new Promise((resolve) => setTimeout(resolve, settleSeconds(env) * 1000))
  await run(argv[1], argv[2], { env, once: options.once })
  return 0
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(1)))
  } catch {
    process.exit(0)
  }
}
