// The `opencode run` subprocess judge used by Claude Code. The prompt goes to stdin, the reply is
// parsed from the JSON event stream, the saved audit session is deleted afterwards, and a timeout
// kills the whole process group. Also the shared event parsing used by tests.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Judge } from "./audit"
import { isRecord, squash, TRANSCRIPT_HEADER } from "./prompt"

/** Title given to every judge session so leftovers can be found and deleted. */
export const AUDIT_TITLE = "supervisor audit"
/** Judge sessions get every tool denied through this config. */
export const JUDGE_CONFIG = '{"permission":{"*":"deny"}}'
/** Default judge limit in seconds, as DESIGN.md states. */
export const DEFAULT_JUDGE_TIMEOUT = 240
/** Limit for the session list/delete cleanup commands. */
export const CLEANUP_TIMEOUT_MS = 20_000

/** The judge call failed in a way that should be logged and retried on the next Stop. */
export class JudgeError extends Error {}

/** The environment variables the judge reads, injectable for tests. */
export type Env = Record<string, string | undefined>

/** The judge limit in seconds: SUPERVISOR_JUDGE_TIMEOUT or 240. */
export const judgeTimeoutSeconds = (env: Env = process.env): number => Number(env.SUPERVISOR_JUDGE_TIMEOUT || DEFAULT_JUDGE_TIMEOUT)

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Join the assistant text events of an `opencode run --format json` stream; fall back to the raw output. */
export function replyFromEvents(stdout: string): string {
  const texts: string[] = []
  const errors: string[] = []
  let parsed = false
  for (const line of stdout.split("\n")) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(event)) continue
    parsed = true
    const part = isRecord(event.part) ? event.part : {}
    if (event.type === "text" && typeof part.text === "string") texts.push(part.text)
    else if (event.type === "error") errors.push(JSON.stringify(event.error ?? event).slice(0, 300))
  }
  if (texts.length) return texts.join("")
  if (errors.length) throw new JudgeError(`judge error: ${errors[0]}`)
  return parsed ? "" : stdout
}

/** The opencode session id carried by the first JSON event that has one, or an empty string. */
export function sessionIdFromEvents(stdout: string): string {
  for (const line of stdout.split("\n")) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (isRecord(event) && typeof event.sessionID === "string" && event.sessionID) return event.sessionID
  }
  return ""
}

/** Kill every process in the group, ignoring ones that are already gone. */
export function killGroup(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch {}
}

/** Run an opencode CLI command in its own process group and return stdout; empty on any failure. Never throws. */
export function runCli(args: string[], env: Env, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn("opencode", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], detached: true })
    } catch {
      resolve("")
      return
    }
    let out = ""
    let settled = false
    const done = (value: string) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
    }
    const timer = setTimeout(() => {
      killGroup(child.pid)
      child.kill("SIGKILL")
      done("")
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => (out += chunk))
    child.on("error", () => done(""))
    child.on("close", (code) => {
      killGroup(child.pid)
      done(code === 0 ? out : "")
    })
  })
}

const canonical = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Delete one opencode session, ignoring failure. */
export async function deleteSession(sessionID: string, env: Env, cwd: string, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<void> {
  await runCli(["session", "delete", sessionID], env, cwd, timeoutMs)
}

/** Ids of sessions titled exactly AUDIT_TITLE, created after startedMs in this run's directory, newest first. */
export async function findAuditSessions(workdir: string, startedMs: number, env: Env, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<string[]> {
  let sessions: unknown
  try {
    sessions = JSON.parse((await runCli(["session", "list", "--format", "json", "-n", "50"], env, workdir, timeoutMs)) || "[]")
  } catch {
    return []
  }
  if (!Array.isArray(sessions)) return []
  const wanted = canonical(workdir)
  return sessions
    .filter(isRecord)
    .filter(
      (s) =>
        s.title === AUDIT_TITLE &&
        typeof s.id === "string" &&
        typeof s.created === "number" &&
        s.created >= startedMs &&
        typeof s.directory === "string" &&
        canonical(s.directory) === wanted,
    )
    .sort((a, b) => (b.created as number) - (a.created as number))
    .map((s) => s.id as string)
}

type ProcessResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function communicate(child: ChildProcess, input: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid)
      child.kill("SIGKILL")
    }, timeoutMs)
    const finish = (result: ProcessResult) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
    }
    const fail = (err: Error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    }
    child.stdout?.on("data", (chunk) => (stdout += chunk))
    child.stderr?.on("data", (chunk) => (stderr += chunk))
    child.on("error", (err) => fail(new JudgeError(`could not start opencode: ${errorText(err)}`)))
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }))
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
}

/** Options for one judge subprocess run. */
export type JudgeRunOptions = {
  model: string
  timeoutSeconds: number
  cleanupTimeoutMs?: number
  env: Env
}
/** A runner with the same contract as runJudge, injectable for tests. */
export type RunJudge = (prompt: string, options: JudgeRunOptions) => Promise<string>

/** Transient judge failures worth one retry: transport and socket drops from `opencode run`. */
const TRANSIENT = /transport|socket|ECONN|EPIPE/i

/** Run opencode as the judge in its own process group, send the prompt on stdin, return its reply text and delete its saved session. */
export async function runJudge(prompt: string, options: JudgeRunOptions): Promise<string> {
  try {
    return await attemptJudge(prompt, options)
  } catch (err) {
    if (!(err instanceof JudgeError) || !TRANSIENT.test(err.message)) throw err
    return await attemptJudge(prompt, options)
  }
}

/** One judge subprocess attempt. */
async function attemptJudge(prompt: string, options: JudgeRunOptions): Promise<string> {
  const workdir = mkdtempSync(join(tmpdir(), "supervisor-"))
  const env = { ...options.env, OPENCODE_CONFIG_CONTENT: JUDGE_CONFIG, SUPERVISOR_ENABLED: "0", SUPERVISOR_CHILD: "1" }
  const cmd = ["run", "--format", "json", "--title", AUDIT_TITLE, "--model", options.model]
  const startedMs = Date.now()
  let stdout = ""
  try {
    let child: ChildProcess
    try {
      child = spawn("opencode", cmd, { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"], detached: true })
    } catch (err) {
      throw new JudgeError(`could not start opencode: ${errorText(err)}`)
    }
    const result = await communicate(child, prompt, options.timeoutSeconds * 1000)
    stdout = result.stdout
    killGroup(child.pid)
    if (result.timedOut) throw new JudgeError(`judge timed out after ${options.timeoutSeconds}s`)
    if (result.code !== 0) {
      const detail = squash(result.stderr || result.stdout).trim().slice(0, 200)
      throw new JudgeError(`opencode exited ${result.code}: ${detail}`)
    }
    return replyFromEvents(stdout)
  } finally {
    try {
      const sessionID = sessionIdFromEvents(stdout)
      const found = sessionID ? [sessionID] : await findAuditSessions(workdir, startedMs, env, options.cleanupTimeoutMs)
      for (const id of found) await deleteSession(id, env, workdir, options.cleanupTimeoutMs)
    } catch {}
    rmSync(workdir, { recursive: true, force: true })
  }
}

/** Options for the Claude Code judge transport. */
export type CliJudgeOptions = {
  model: string
  timeoutSeconds?: number
  cleanupTimeoutMs?: number
  env?: Env
  run?: RunJudge
}

/** A Judge that runs `opencode run` in a temp directory, with the prompt (system + transcript) on stdin. */
export function cliJudge(options: CliJudgeOptions): Judge {
  const run = options.run ?? runJudge
  const env = options.env ?? process.env
  const timeoutSeconds = options.timeoutSeconds ?? judgeTimeoutSeconds(env)
  return (system, transcript) =>
    run(`${system}${TRANSCRIPT_HEADER}${transcript}`, { model: options.model, timeoutSeconds, cleanupTimeoutMs: options.cleanupTimeoutMs, env })
}
