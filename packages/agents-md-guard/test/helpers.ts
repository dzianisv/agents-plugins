// Shared test helpers: a temp SUPERVISOR_HOME with the fake opencode on PATH, the Claude
// transcript entry builders, and small wait/read utilities.
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

export const PASS_REPLY = '{"verdict":"PASS","violations":[]}'
export const FAIL_REPLY =
  '{"verdict":"FAIL","violations":[{"rule":"Max 6 lines","evidence":"#1 12 lines","fix":"shorten"},{"rule":"No emoji","evidence":"#1 x","fix":"remove"}]}'

const FIXTURE = join(import.meta.dir, "fixtures", "fake-opencode")
const SRC = join(import.meta.dir, "..", "src")

/** A transcript entry for a user message. */
export const user = (text: string, uuid = "u1", extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid,
  message: { role: "user", content: text },
  ...extra,
})
/** A transcript entry for one assistant content block list. */
export const assistant = (blocks: unknown, uuid = "a1", apiId?: string) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", id: apiId ?? uuid, content: blocks },
})
/** A text content block. */
export const text = (value: string) => ({ type: "text", text: value })
/** A tool_use content block. */
export const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input })
/** A user entry that carries a tool result. */
export const toolResult = (uuid: string, toolId: string, content: unknown) => ({
  type: "user",
  uuid,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content }] },
})
/** Write entries as JSONL. */
export const writeTranscript = (path: string, entries: unknown[]) => writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n")

const ENV_KEYS = [
  "AGENTS_NOTIFY",
  "AGENTS_MD_GUARD_HOME",
  "AGENTS_MD_GUARD_COMMANDS",
  "AGENTS_NOTIFY_CMD",
  "AGENTS_NOTIFY_STATE_DIR",
  "SUPERVISOR_HOME",
  "SUPERVISOR_RULES",
  "SUPERVISOR_SETTLE_SECONDS",
  "SUPERVISOR_JUDGE_TIMEOUT",
  "SUPERVISOR_ENABLED",
  "SUPERVISOR_CHILD",
  "SUPERVISOR_MODEL",
  "SUPERVISOR_MAX_CHARS",
  "PATH",
  "FAKE_LOG",
  "FAKE_PIDS",
  "FAKE_SESSIONS",
  "FAKE_REPLY",
  "FAKE_MODE",
  "FAKE_NO_SESSION_ID",
  "FAKE_DELETE_MODE",
]

/** An isolated state dir, rules file, fake opencode on PATH, and a notification recorder. */
export function makeEnv() {
  const tmp = mkdtempSync(join(tmpdir(), "supervisor-"))
  const home = join(tmp, "home")
  const bin = join(tmp, "bin")
  mkdirSync(bin)
  copyFileSync(FIXTURE, join(bin, "opencode"))
  chmodSync(join(bin, "opencode"), 0o755)
  const rules = join(tmp, "AGENTS.md")
  writeFileSync(rules, "RULE: reply in 6 lines max")
  const transcript = join(tmp, "t.jsonl")
  const log = join(tmp, "fake.jsonl")
  const pids = join(tmp, "pids.txt")
  const store = join(tmp, "sessions.json")
  writeFileSync(store, "[]")
  writeTranscript(transcript, [user("fix it", "u1"), assistant([text("done, here is a long answer")], "a1")])
  const recorder = join(tmp, "notify.sh")
  const notified = join(tmp, "notified.txt")
  writeFileSync(recorder, `#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> "${notified}"\n`)
  chmodSync(recorder, 0o755)

  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  Object.assign(process.env, {
    AGENTS_NOTIFY_CMD: recorder,
    AGENTS_MD_GUARD_HOME: join(tmp, "guard"),
    AGENTS_NOTIFY_STATE_DIR: join(tmp, "notify-state"),
    SUPERVISOR_HOME: home,
    SUPERVISOR_RULES: rules,
    SUPERVISOR_SETTLE_SECONDS: "0",
    SUPERVISOR_JUDGE_TIMEOUT: "20",
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    FAKE_LOG: log,
    FAKE_PIDS: pids,
    FAKE_SESSIONS: store,
    FAKE_REPLY: PASS_REPLY,
    FAKE_MODE: "reply",
  })
  for (const name of ["AGENTS_NOTIFY", "AGENTS_MD_GUARD_COMMANDS", "SUPERVISOR_ENABLED", "SUPERVISOR_CHILD", "SUPERVISOR_MODEL", "SUPERVISOR_MAX_CHARS", "FAKE_NO_SESSION_ID", "FAKE_DELETE_MODE"]) {
    delete process.env[name]
  }

  const allCalls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [])
  return {
    tmp,
    home,
    bin,
    rules,
    transcript,
    log,
    pids,
    store,
    notified,
    allCalls,
    calls: () => allCalls().filter((c) => c.argv[0] === "run"),
    sessionCalls: () => allCalls().filter((c) => c.argv[0] === "session"),
    sessions: () => JSON.parse(readFileSync(store, "utf8")),
    seedSessions: (sessions: unknown[]) => writeFileSync(store, JSON.stringify(sessions)),
    audits: () =>
      existsSync(join(home, "audits.jsonl"))
        ? readFileSync(join(home, "audits.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
    notifiedLines: () => (existsSync(notified) ? readFileSync(notified, "utf8").trim().split("\n").filter(Boolean) : []),
    runHook: (script: string, payload: unknown, env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [join(SRC, "claude", script)], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 30000,
      }),
    waitFor: async (predicate: () => boolean, seconds = 15) => {
      const end = Date.now() + seconds * 1000
      while (Date.now() < end) {
        if (predicate()) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      return false
    },
    restore() {
      for (const key of ENV_KEYS) saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key])
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/** The test environment shape returned by makeEnv. */
export type TestEnv = ReturnType<typeof makeEnv>
