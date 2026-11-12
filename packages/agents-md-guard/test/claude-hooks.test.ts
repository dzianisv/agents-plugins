import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { utimesSync } from "node:fs"
import { main as promptMain } from "../src/claude/prompt"
import { main as sessionEndMain } from "../src/claude/session-end"
import { main as stopMain, inlineTimeoutSeconds } from "../src/claude/stop"
import { ERROR_PREFIX, formatFeedback } from "../src/core/prompt"
import { auditedPath, lockPath, markAudited, pendingPath, rerunPath, safeSessionId, LOCK_STALE_SECONDS, writePending } from "../src/core/state"
import { assistant, FAIL_REPLY, makeEnv, text, user, writeTranscript, type TestEnv } from "./helpers"

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.restore())

const payload = (extra: Record<string, unknown> = {}) => ({
  session_id: "s1",
  transcript_path: env.transcript,
  stop_hook_active: false,
  hook_event_name: "Stop",
  ...extra,
})

describe("stop hook", () => {
  test("blocks the stop with the findings from this turn", () => {
    const result = env.runHook("stop.ts", payload(), { FAKE_REPLY: FAIL_REPLY })
    expect([result.status, result.stderr]).toEqual([0, ""])
    const out = JSON.parse(result.stdout)
    expect(out.decision).toBe("block")
    expect(out.reason).toContain("[agents-md-guard]")
    expect(out.reason).toContain("Max 6 lines")
    expect(existsSync(pendingPath("s1"))).toBe(false)
    expect(env.audits()[0].verdict).toBe("FAIL")
  })

  test("passes when the audit finds nothing", () => {
    const result = env.runHook("stop.ts", payload())
    expect([result.status, result.stdout]).toEqual([0, ""])
    expect(env.audits()[0].verdict).toBe("PASS")
  })

  test("keeps an audit error for the next prompt instead of blocking", () => {
    const result = env.runHook("stop.ts", payload(), { FAKE_MODE: "exit2" })
    expect([result.status, result.stdout]).toEqual([0, ""])
    expect(readFileSync(pendingPath("s1"), "utf8")).toContain("agents-md-guard ERROR:")
  })

  test("a slow judge falls back to the detached child instead of blocking", async () => {
    const calls: Array<{ command: string; args: string[]; options: { detached: boolean; stdio: "ignore" } }> = []
    const spawnFn = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options })
      return { unref: () => {} }
    }
    const once = async (id: string) => {
      writePending(id, `${ERROR_PREFIX} the audit of your last turn failed (judge timed out after 1s)`)
      return "error" as const
    }
    const code = await stopMain(JSON.stringify(payload()), { env: process.env, once, spawn: spawnFn })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0].endsWith(join("src", "claude", "audit.ts"))).toBe(true)
    expect(calls[0].args.slice(1, 3)).toEqual(["s1", env.transcript])
    expect(calls[0].args[3]).toBe(process.cwd())
    expect(calls[0].options.detached).toBe(true)
    expect(calls[0].options.stdio).toBe("ignore")
    expect(readFileSync(pendingPath("s1"), "utf8")).toContain("agents-md-guard ERROR:")
  })

  test("the project AGENTS.md is judged alongside the global one", () => {
    const project = mkdtempSync(join(tmpdir(), "tc-project-"))
    writeFileSync(join(project, "AGENTS.md"), "PROJECT RULE: always cite the file")
    const result = env.runHook("stop.ts", payload({ cwd: project }), { SUPERVISOR_RULES: "", FAKE_REPLY: FAIL_REPLY })
    expect([result.status, result.stderr]).toEqual([0, ""])
    const sent = env.calls()[0].stdin
    expect(sent).toContain("PROJECT RULE: always cite the file")
    expect(sent).toContain(`# Rules from ${join(project, "AGENTS.md")}`)
    expect(sent).toContain("# Rules from ") // the global file is included too
    rmSync(project, { recursive: true, force: true })
  })

  test("never blocks twice for the same violations", () => {
    const extra = { FAKE_REPLY: FAIL_REPLY }
    const outs: string[] = []
    for (let i = 0; i < 5; i++) {
      writeTranscript(env.transcript, [user("fix it", "u1"), assistant([text("done")], `a${i}`)])
      outs.push(String(env.runHook("stop.ts", payload(), extra).stdout).trim())
    }
    expect(outs.filter((out) => out.includes("block"))).toHaveLength(1)
    expect(outs[4]).toBe("")
  })

  test("the block never re-fires when the state file is cleared between turns", () => {
    const extra = { FAKE_REPLY: FAIL_REPLY }
    const outs: string[] = []
    for (let i = 0; i < 5; i++) {
      writeTranscript(env.transcript, [user("fix it", "u1"), assistant([text("done")], `a${i}`)])
      outs.push(String(env.runHook("stop.ts", payload(), extra).stdout).trim())
      // The audited marker and the pending note are cleared as the turn progresses; the delivered
      // record, which lives in its own file, must survive that or the block would re-fire every turn.
      rmSync(join(env.home, "state", "s1.json"), { force: true })
      rmSync(join(env.home, "pending", "s1.txt"), { force: true })
    }
    expect(outs.filter((out) => out.includes("block"))).toHaveLength(1)
    expect(outs[4]).toBe("")
  })

  test("the inline wait defaults to 90 seconds", () => {
    expect(inlineTimeoutSeconds({})).toBe(90)
    expect(inlineTimeoutSeconds({ SUPERVISOR_INLINE_TIMEOUT: "30" })).toBe(30)
    expect(inlineTimeoutSeconds({ SUPERVISOR_INLINE_TIMEOUT: "nope" })).toBe(90)
  })

  test("the guards skip the audit", () => {
    const judgeCwd = mkdtempSync(join(tmpdir(), "supervisor-judge-"))
    const cases: Array<[string, Record<string, string>, unknown]> = [
      ["disabled", { SUPERVISOR_ENABLED: "0" }, payload()],
      ["child env", { SUPERVISOR_CHILD: "1" }, payload({ cwd: judgeCwd })],
      ["stop_hook_active", {}, payload({ stop_hook_active: true })],
      ["missing transcript", {}, payload({ transcript_path: join(env.home, "none.jsonl") })],
      ["no transcript path", {}, { session_id: "s1" }],
    ]
    for (const [name, overrides, input] of cases) {
      const result = env.runHook("stop.ts", input, overrides)
      expect([name, result.status, result.stdout]).toEqual([name, 0, ""])
    }
    rmSync(judgeCwd, { recursive: true, force: true })
    expect(env.calls()).toEqual([])
  })

  test("a leaked child flag outside a judge dir still audits", () => {
    const result = env.runHook("stop.ts", payload(), { SUPERVISOR_CHILD: "1", FAKE_REPLY: FAIL_REPLY })
    expect(JSON.parse(result.stdout).decision).toBe("block")
  })

  test("bad stdin exits zero", () => {
    const result = env.runHook("stop.ts", "not json")
    expect([result.status, result.stdout]).toEqual([0, ""])
    expect(env.calls()).toEqual([])
  })

  test("the whole flow delivers once from stop to the next prompt", () => {
    env.runHook("stop.ts", payload(), { FAKE_REPLY: FAIL_REPLY })
    const first = env.runHook("prompt.ts", { session_id: "s1", prompt: "next", hook_event_name: "UserPromptSubmit" })
    const second = env.runHook("prompt.ts", { session_id: "s1", prompt: "next", hook_event_name: "UserPromptSubmit" })
    expect([first.status, first.stdout]).toEqual([0, ""])
    expect([second.status, second.stdout]).toEqual([0, ""])
  })
})

describe("prompt hook", () => {
  test("delivers feedback as one JSON object and deletes the file", () => {
    const feedback = formatFeedback([
      { rule: "A", evidence: "#1", fix: "f" },
      { rule: "B", evidence: "", fix: "" },
    ])
    writePending("s1", feedback)
    const result = env.runHook("prompt.ts", { session_id: "s1", prompt: "go", hook_event_name: "UserPromptSubmit" })
    expect([result.status, result.stderr]).toEqual([0, ""])
    expect(result.stdout.split("\n").length - 1).toBe(1)
    const data = JSON.parse(result.stdout)
    expect(data.systemMessage).toBe("supervisor: 2 rule violation(s) from your last turn")
    expect(data.hookSpecificOutput).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: `<system-reminder>\n${feedback}\n</system-reminder>` })
    expect(Object.keys(data).sort()).toEqual(["hookSpecificOutput", "systemMessage"])
    expect(existsSync(pendingPath("s1"))).toBe(false)
  })

  test("prints nothing without pending feedback", () => {
    const result = env.runHook("prompt.ts", { session_id: "s1", prompt: "go" })
    expect([result.status, result.stdout, result.stderr]).toEqual([0, "", ""])
  })

  test("other sessions are untouched", () => {
    writePending("other", "- x")
    const result = env.runHook("prompt.ts", { session_id: "s1" })
    expect(result.stdout).toBe("")
    expect(existsSync(pendingPath("other"))).toBe(true)
  })

  test("the session id is sanitised for file names", () => {
    expect(safeSessionId("../../etc/x y")).toBe("etcxy")
    expect(safeSessionId(null)).toBe("unknown")
    expect(safeSessionId("")).toBe("unknown")
    expect(dirname(pendingPath("../../evil"))).toBe(join(env.home, "pending"))
    writePending("../a", "- hit")
    const result = env.runHook("prompt.ts", { session_id: "../a" })
    expect(result.stdout).toContain("hit")
  })

  test("the error note is shown to the user", () => {
    writePending("s1", "agents-md-guard ERROR: the audit of your last turn failed (boom). No rules were checked. Tell the user.")
    const result = JSON.parse(env.runHook("prompt.ts", { session_id: "s1" }).stdout)
    expect(result.systemMessage.startsWith("agents-md-guard ERROR:")).toBe(true)
    expect(result.hookSpecificOutput.additionalContext).toContain("boom")
  })

  test("garbage stdin exits zero silently", () => {
    const result = env.runHook("prompt.ts", "{{{")
    expect([result.status, result.stdout]).toEqual([0, ""])
  })

  test("in-process entrypoints parse their input", () => {
    expect(promptMain("{{{")).toBe(0)
    expect(sessionEndMain("{}")).toBe(0)
  })
})

describe("session end hook", () => {
  const makeSessionFiles = (ownerPid: number, ageSeconds = 0) => {
    const lock = lockPath("s1")
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, String(ownerPid))
    writeFileSync(rerunPath("s1"), "")
    markAudited("s1", "a1")
    if (ageSeconds) {
      const old = new Date(Date.now() - ageSeconds * 1000)
      utimesSync(lock, old, old)
    }
  }

  test("deletes session files and prunes old ones", () => {
    for (const path of [lockPath("s1"), rerunPath("s1")]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, "999999")
    }
    markAudited("s1", "a1")
    markAudited("other", "a9")
    writePending("old", "- x")
    writePending("fresh", "- y")
    const old = new Date(Date.now() - 8 * 86400000)
    utimesSync(pendingPath("old"), old, old)
    utimesSync(auditedPath("other"), old, old)
    const result = env.runHook("session-end.ts", { session_id: "s1", hook_event_name: "SessionEnd", reason: "other" })
    expect([result.status, result.stdout, result.stderr]).toEqual([0, "", ""])
    expect(existsSync(lockPath("s1"))).toBe(false)
    expect(existsSync(rerunPath("s1"))).toBe(false)
    expect(existsSync(auditedPath("s1"))).toBe(false)
    expect(existsSync(pendingPath("old"))).toBe(false)
    expect(existsSync(auditedPath("other"))).toBe(false)
    expect(existsSync(pendingPath("fresh"))).toBe(true)
  })

  test("a live audit's lock is kept", () => {
    makeSessionFiles(process.pid)
    expect(env.runHook("session-end.ts", { session_id: "s1" }).status).toBe(0)
    expect(existsSync(lockPath("s1"))).toBe(true)
    expect(existsSync(rerunPath("s1"))).toBe(true)
    expect(existsSync(auditedPath("s1"))).toBe(true)
  })

  test("a lock of a dead owner is removed", () => {
    makeSessionFiles(999999)
    env.runHook("session-end.ts", { session_id: "s1" })
    expect(existsSync(lockPath("s1"))).toBe(false)
    expect(existsSync(rerunPath("s1"))).toBe(false)
    expect(existsSync(auditedPath("s1"))).toBe(false)
  })

  test("a lock with a stale mtime is removed even if the pid is alive", () => {
    makeSessionFiles(process.pid, LOCK_STALE_SECONDS + 60)
    env.runHook("session-end.ts", { session_id: "s1" })
    expect(existsSync(lockPath("s1"))).toBe(false)
  })

  test("works with nothing to clean", () => {
    const result = env.runHook("session-end.ts", { session_id: "s1" })
    expect([result.status, result.stdout]).toEqual([0, ""])
    expect(sessionEndMain("{}")).toBe(0)
  })
})

describe("hooks file and manifest", () => {
  const root = join(import.meta.dir, "..")

  test("hooks.json wires the four hooks to bun entrypoints", () => {
    const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")).hooks
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "SessionEnd", "Stop", "UserPromptSubmit"])
    const cases = [
      ["PreToolUse", "review.ts"],
      ["Stop", "stop.ts"],
      ["UserPromptSubmit", "prompt.ts"],
      ["SessionEnd", "session-end.ts"],
    ] as const
    for (const [event, script] of cases) {
      const command = hooks[event][0].hooks[0].command
      const expected = `PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin" bun "\${CLAUDE_PLUGIN_ROOT}/src/claude/${script}"`
      expect(command).toBe(expected)
      expect(existsSync(join(root, "src", "claude", script))).toBe(true)
    }
    // The Stop hook audits inline within SUPERVISOR_INLINE_TIMEOUT, so its timeout has to cover that.
    expect(hooks.Stop[0].hooks[0].timeout).toBe(150)
  })

  test("the plugin manifest names agents-md-guard", () => {
    const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"))
    expect([manifest.name, manifest.version]).toEqual(["agents-md-guard", "0.8.0"])
    expect(manifest.author).toEqual({ name: "Dzianis Vashchuk" })
  })
})

describe("pre-tool review hook", () => {
  const bash = (command: string) => payload({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } })

  test("denies a configured command that breaks a rule", () => {
    const result = env.runHook("review.ts", bash("git commit -m x"), { FAKE_REPLY: "DENY: the commit message names no ticket" })
    expect([result.status, result.stderr]).toEqual([0, ""])
    const out = JSON.parse(result.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("agents-md-guard: the commit message names no ticket")
    expect(env.calls()).toHaveLength(1)
  })

  test("allows a configured command the judge allows", () => {
    const result = env.runHook("review.ts", bash("gh pr create --title x"), { FAKE_REPLY: "ALLOW" })
    expect([result.status, result.stdout]).toEqual([0, ""])
    expect(env.calls()).toHaveLength(1)
  })

  test("skips a command that is not on the list, without a judge call", () => {
    const result = env.runHook("review.ts", bash("git status"), { FAKE_REPLY: "DENY: x" })
    expect([result.status, result.stdout]).toEqual([0, ""])
    expect(env.calls()).toHaveLength(0)
  })

  test("ignores a non-Bash tool", () => {
    const result = env.runHook("review.ts", payload({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }), { FAKE_REPLY: "DENY: x" })
    expect([result.status, result.stdout]).toEqual([0, ""])
    expect(env.calls()).toHaveLength(0)
  })
})
