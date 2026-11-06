import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { auditSession, run } from "../src/claude/audit"
import { pruneLog, record } from "../src/core/audit-log"
import { cliJudge, DEFAULT_JUDGE_TIMEOUT, findAuditSessions, judgeTimeoutSeconds, sessionIdFromEvents } from "../src/core/judge-cli"
import { DEFAULT_MODEL } from "../src/core/prompt"
import {
  acquireLock,
  auditedPath,
  lastAudited,
  lockPath,
  pendingPath,
  pidAlive,
  releaseLock,
  rerunPath,
  setRerun,
  writePending,
} from "../src/core/state"
import { assistant, FAIL_REPLY, makeEnv, PASS_REPLY, text, user, writeTranscript, type TestEnv } from "./helpers"

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.restore())

const decoys = () => [
  { id: "ses_user", title: "my real work", created: 1, directory: "/work" },
  { id: "ses_other_audit", title: "supervisor audit", created: Date.now() + 5000, directory: "/elsewhere" },
]

describe("auditSession", () => {
  test("a FAIL writes pending, marks audited and logs", async () => {
    process.env.FAKE_REPLY = FAIL_REPLY
    expect(await auditSession("s1", env.transcript)).toBe("fail")
    expect(readFileSync(pendingPath("s1"), "utf8")).toContain("- Max 6 lines (#1 12 lines) Fix: shorten")
    expect(lastAudited("s1")).toBe("a1")
    const [entry] = env.audits()
    expect(entry.agent).toBe("claude-code")
    expect(entry.verdict).toBe("FAIL")
    expect(entry.sessionID).toBe("s1")
    expect(entry.messageID).toBe("a1")
    expect(entry.model).toBe(DEFAULT_MODEL)
    expect(entry.violations).toHaveLength(2)
    expect(typeof entry.ms).toBe("number")
    expect(typeof entry.time).toBe("string")
  })

  test("the judge command, env and prompt", async () => {
    process.env.SUPERVISOR_MODEL = "prov/some/model"
    await auditSession("s1", env.transcript)
    const [call] = env.calls()
    const argv = call.argv
    expect(argv.slice(0, 3)).toEqual(["run", "--format", "json"])
    expect(argv).not.toContain("--pure")
    expect(argv).not.toContain("--dir")
    expect(argv[argv.indexOf("--format") + 1]).toBe("json")
    expect(argv[argv.indexOf("--model") + 1]).toBe("prov/some/model")
    expect(existsSync(call.cwd)).toBe(false)
    expect(JSON.parse(call.config)).toEqual({ permission: { "*": "deny" } })
    expect([call.enabled, call.child]).toEqual(["0", "1"])
    expect(argv.slice(-2)).toEqual(["--model", "prov/some/model"])
    expect(argv.some((a: string) => a.includes("RULES:") || a.includes("TRANSCRIPT:"))).toBe(false)
    const sent = call.stdin
    expect(sent.startsWith("You are a strict compliance auditor")).toBe(true)
    expect(sent).toContain("RULES:\nRULE: reply in 6 lines max")
    expect(sent).toContain("TRANSCRIPT:\n\n[#0 USER]\nfix it\n\n[#1 ASSISTANT]\ndone, here is a long answer")
  })

  test("a PASS clears pending", async () => {
    writePending("s1", "old feedback")
    expect(await auditSession("s1", env.transcript)).toBe("pass")
    expect(existsSync(pendingPath("s1"))).toBe(false)
    expect(env.audits()[0].verdict).toBe("PASS")
  })

  test("an unchanged transcript is not audited twice", async () => {
    await auditSession("s1", env.transcript)
    expect(await auditSession("s1", env.transcript)).toBe("skipped")
    expect(env.calls()).toHaveLength(1)
    writeTranscript(env.transcript, [user("fix it", "u1"), assistant([text("done")], "a1"), user("more", "u2"), assistant([text("ok")], "a2")])
    expect(await auditSession("s1", env.transcript)).toBe("pass")
    expect(env.calls()).toHaveLength(2)
  })

  test("a garbage reply is not marked and retries next time", async () => {
    process.env.FAKE_MODE = "garbage"
    writePending("s1", "keep me")
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(lastAudited("s1")).toBe("")
    const pending = readFileSync(pendingPath("s1"), "utf8")
    expect(pending.startsWith("keep me\nturn-check ERROR:")).toBe(true)
    expect(pending).toContain("unparseable verdict")
    const [entry] = env.audits()
    expect(entry.error).toBe("unparseable verdict")
    expect(entry.reply.length).toBeLessThanOrEqual(300)
    expect("verdict" in entry).toBe(false)
    process.env.FAKE_MODE = "reply"
    expect(await auditSession("s1", env.transcript)).toBe("pass")
  })

  test("a FAIL verdict without violations is rejected", async () => {
    process.env.FAKE_REPLY = '{"verdict":"FAIL","violations":[]}'
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(lastAudited("s1")).toBe("")
    expect(readFileSync(pendingPath("s1"), "utf8").startsWith("turn-check ERROR:")).toBe(true)
  })

  test("a nonzero exit is a loud error with stderr", async () => {
    process.env.FAKE_MODE = "exit2"
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(env.audits()[0].error).toContain("opencode exited 2: unknown flag")
    expect(readFileSync(pendingPath("s1"), "utf8")).toContain("turn-check ERROR:")
  })

  test("an audit error raises a notification", async () => {
    process.env.FAKE_MODE = "exit2"
    await auditSession("s1", env.transcript)
    const [line] = env.notifiedLines()
    const [title, message] = line.split("|")
    expect(title).toBe("turn-check")
    expect(message).toContain("audit failed: opencode exited 2")
  })

  test("repeated errors leave one error note", async () => {
    process.env.FAKE_MODE = "exit2"
    await auditSession("s1", env.transcript)
    await auditSession("s1", env.transcript)
    expect(readFileSync(pendingPath("s1"), "utf8").split("turn-check ERROR:").length - 1).toBe(1)
  })

  test("an error event is logged and not marked", async () => {
    process.env.FAKE_MODE = "error"
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(env.audits()[0].error).toContain("judge error")
    expect(lastAudited("s1")).toBe("")
  })

  test("a missing opencode is logged", async () => {
    process.env.PATH = env.home
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(env.audits()[0].error).toContain("could not start opencode")
  })

  test("a hang is killed with its whole process group", async () => {
    process.env.FAKE_MODE = "hang"
    process.env.SUPERVISOR_JUDGE_TIMEOUT = "1"
    const started = Date.now()
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(Date.now() - started).toBeLessThan(10000)
    expect(env.audits()[0].error).toContain("timed out")
    expect(lastAudited("s1")).toBe("")
    const grandchild = Number(readFileSync(env.pids, "utf8"))
    expect(await env.waitFor(() => !pidAlive(grandchild), 5)).toBe(true)
  })

  test("no agent work skips the judge", async () => {
    writeTranscript(env.transcript, [user("hello", "u1")])
    expect(await auditSession("s1", env.transcript)).toBe("skipped")
    expect(env.calls()).toEqual([])
  })

  test("a missing transcript is skipped and missing rules are loud", async () => {
    expect(await auditSession("s1", join(env.home, "nope.jsonl"))).toBe("skipped")
    process.env.SUPERVISOR_RULES = join(env.home, "nope.md")
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(env.audits()[0].error).toContain("rules unreadable")
    expect(env.calls()).toEqual([])
  })

  test("the prompt text is not logged beyond the reply clip", async () => {
    process.env.FAKE_MODE = "garbage"
    await auditSession("s1", env.transcript)
    const logged = readFileSync(join(env.home, "audits.jsonl"), "utf8")
    expect(logged).not.toContain("RULE: reply in 6 lines max")
    expect(logged).not.toContain("done, here is a long answer")
  })
})

describe("audit session cleanup", () => {
  test("the run is titled and its session is deleted by id", async () => {
    env.seedSessions(decoys())
    expect(await auditSession("s1", env.transcript)).toBe("pass")
    const [call] = env.calls()
    expect(call.argv[call.argv.indexOf("--title") + 1]).toBe("supervisor audit")
    const deletes = env.sessionCalls().filter((c) => c.argv[1] === "delete")
    expect(deletes).toHaveLength(1)
    expect(deletes[0].argv[2].startsWith("ses_fake_")).toBe(true)
    expect(env.sessions().map((s: any) => s.id)).toEqual(["ses_user", "ses_other_audit"])
    expect(env.sessionCalls().map((c) => c.argv[1])).toEqual(["delete"])
  })

  test("session commands run without plugins", async () => {
    process.env.FAKE_NO_SESSION_ID = "1"
    expect(await auditSession("s1", env.transcript)).toBe("pass")
    const calls = env.sessionCalls()
    expect(calls.map((c) => c.argv[1])).toEqual(["list", "delete"])
    expect(calls.some((c) => c.argv.includes("--pure"))).toBe(false)
  })

  test("a long prompt goes on stdin, not in argv", async () => {
    writeTranscript(env.transcript, [user("fix it", "u1"), assistant([text("x".repeat(300000))], "a1")])
    process.env.SUPERVISOR_MAX_CHARS = "400000"
    expect(await auditSession("s1", env.transcript)).toBe("pass")
    const [call] = env.calls()
    expect(call.stdin.length).toBeGreaterThan(300000)
    expect(call.argv.reduce((n: number, a: string) => n + a.length, 0)).toBeLessThan(1000)
  })

  test("the session is deleted after a timeout by exact title and directory", async () => {
    env.seedSessions(decoys())
    process.env.FAKE_MODE = "hang"
    process.env.SUPERVISOR_JUDGE_TIMEOUT = "1"
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(env.sessions().map((s: any) => s.id)).toEqual(["ses_user", "ses_other_audit"])
    expect(env.sessionCalls().map((c) => c.argv[1])).toEqual(["list", "delete"])
  })

  test("the session is deleted when no event carried an id", async () => {
    process.env.FAKE_NO_SESSION_ID = "1"
    expect(await auditSession("s1", env.transcript)).toBe("pass")
    expect(env.sessions()).toEqual([])
    process.env.FAKE_MODE = "garbage"
    expect(await auditSession("s2", env.transcript)).toBe("error")
    expect(env.sessions()).toEqual([])
  })

  test("an error run still deletes its session", async () => {
    process.env.FAKE_MODE = "error"
    expect(await auditSession("s1", env.transcript)).toBe("error")
    expect(env.sessions()).toEqual([])
  })

  test("the lookup only matches exact title in this directory created after start", async () => {
    const workdir = join(env.tmp, "work")
    mkdirSync(workdir)
    const real = realpathSync(workdir)
    env.seedSessions([
      { id: "ses_old", title: "supervisor audit", created: 1000, directory: real },
      { id: "ses_new_a", title: "supervisor audit", created: 5000, directory: real },
      { id: "ses_new_b", title: "supervisor audit", created: 6000, directory: workdir },
      { id: "ses_titled", title: "supervisor audit 2", created: 7000, directory: real },
      { id: "ses_dir", title: "supervisor audit", created: 7000, directory: "/elsewhere" },
    ])
    expect(await findAuditSessions(workdir, 2000, process.env)).toEqual(["ses_new_b", "ses_new_a"])
  })

  test("cleanup failures never raise or change the verdict", async () => {
    process.env.FAKE_DELETE_MODE = "fail"
    expect(await auditSession("s1", env.transcript)).toBe("pass")
    expect(env.sessions()).toHaveLength(1)
  })

  test("a cleanup hang is cut off at the timeout", async () => {
    process.env.FAKE_DELETE_MODE = "hang"
    const started = Date.now()
    const judge = cliJudge({ model: DEFAULT_MODEL, timeoutSeconds: 5, cleanupTimeoutMs: 500, env: process.env })
    expect(await auditSession("s1", env.transcript, { judge })).toBe("pass")
    expect(Date.now() - started).toBeLessThan(10000)
  })

  test("the session id is read from the first event that has one", () => {
    const stream = ["junk", JSON.stringify({ type: "step_start" }), JSON.stringify({ type: "text", sessionID: "ses_1" }), JSON.stringify({ sessionID: "ses_2" })].join("\n")
    expect(sessionIdFromEvents(stream)).toBe("ses_1")
    expect(sessionIdFromEvents("nothing")).toBe("")
  })

  test("the judge timeout defaults to 240 seconds", async () => {
    expect(DEFAULT_JUDGE_TIMEOUT).toBe(240)
    expect(judgeTimeoutSeconds({})).toBe(240)
    let seen: number | undefined
    const judge = cliJudge({
      model: "m",
      env: {},
      run: async (_prompt, options) => {
        seen = options.timeoutSeconds
        return PASS_REPLY
      },
    })
    await judge("sys", "transcript")
    expect(seen).toBe(240)
  })
})

describe("run lock loop", () => {
  test("a running audit makes a second stop set the rerun flag", async () => {
    expect(acquireLock("s1")).toBe(true)
    let called = false
    await run("s1", env.transcript, {
      once: async () => {
        called = true
        return "pass"
      },
    })
    expect(called).toBe(false)
    expect(existsSync(rerunPath("s1"))).toBe(true)
    expect(existsSync(lockPath("s1"))).toBe(true)
  })

  test("the rerun flag makes the running audit go again", async () => {
    let calls = 0
    await run("s1", env.transcript, {
      once: async (id, path) => {
        calls++
        if (calls === 1) await run(id, path, { once: async () => "pass" })
        return "pass"
      },
    })
    expect(calls).toBe(2)
    expect(existsSync(lockPath("s1"))).toBe(false)
    expect(existsSync(rerunPath("s1"))).toBe(false)
  })

  test("a stale lock from a dead process is taken over", async () => {
    const lock = lockPath("s1")
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, "999999")
    await run("s1", env.transcript)
    expect(env.calls()).toHaveLength(1)
    expect(existsSync(lock)).toBe(false)
  })

  test("the lock is released when the audit crashes", async () => {
    await run("s1", env.transcript, {
      once: async () => {
        throw new Error("boom")
      },
    })
    expect(existsSync(lockPath("s1"))).toBe(false)
    expect(env.audits()[0].error).toContain("audit crashed")
  })
})

describe("session lock", () => {
  const racer = new URL("./fixtures/lock-racer.ts", import.meta.url)

  test(
    "a stale lock is taken by exactly one of many processes",
    async () => {
      const lock = lockPath("race")
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, "999999")
      const start = Date.now() + 1000
      const procs = Array.from({ length: 6 }, () =>
        Bun.spawn([process.execPath, racer.pathname], {
          env: { ...process.env, RACE_HOME: env.home, RACE_SESSION: "race", RACE_START: String(start) },
          stdout: "pipe",
        }),
      )
      const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()))
      expect(outs.map((o) => o.trim()).filter((o) => o === "true")).toHaveLength(1)
    },
    20000,
  )

  test("a live lock is not taken", () => {
    expect(acquireLock("s1")).toBe(true)
    expect(acquireLock("s1")).toBe(false)
  })

  test("release only drops a lock this process owns", () => {
    const lock = lockPath("s1")
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, String(process.pid + 1))
    releaseLock("s1")
    expect(existsSync(lock)).toBe(true)
    writeFileSync(lock, String(process.pid))
    releaseLock("s1")
    expect(existsSync(lock)).toBe(false)
  })
})

describe("private files", () => {
  const mode = (path: string) => statSync(path).mode & 0o777

  test("the state dir and files are private", async () => {
    process.env.FAKE_REPLY = FAIL_REPLY
    mkdirSync(env.home, { recursive: true, mode: 0o755 })
    chmodSync(env.home, 0o755)
    await auditSession("s1", env.transcript)
    setRerun("s1")
    for (const dir of [env.home, join(env.home, "pending"), join(env.home, "state"), join(env.home, "locks")]) expect(mode(dir)).toBe(0o700)
    for (const path of [join(env.home, "audits.jsonl"), pendingPath("s1"), auditedPath("s1"), rerunPath("s1")]) expect(mode(path)).toBe(0o600)
    expect(acquireLock("s1")).toBe(true)
    expect(mode(lockPath("s1"))).toBe(0o600)
  })

  test("an existing world-readable log is tightened", () => {
    mkdirSync(env.home, { recursive: true })
    const log = join(env.home, "audits.jsonl")
    writeFileSync(log, "")
    chmodSync(log, 0o644)
    record(env.home, { sessionID: "s1" })
    expect(mode(log)).toBe(0o600)
  })
})

describe("audit log pruning", () => {
  const line = (daysAgo: number, session: string) => JSON.stringify({ time: new Date(Date.now() - daysAgo * 86400000).toISOString(), sessionID: session })

  test("pruneLog drops old and corrupt lines and keeps recent ones", () => {
    mkdirSync(env.home, { recursive: true })
    const log = join(env.home, "audits.jsonl")
    writeFileSync(log, [line(40, "old"), "garbage", '{"sessionID":"notime"}', line(29, "edge"), line(1, "new"), ""].join("\n"))
    pruneLog(env.home)
    expect(
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).sessionID),
    ).toEqual(["edge", "new"])
    expect(statSync(log).mode & 0o777).toBe(0o600)
    expect(readdirSync(env.home)).toEqual(["audits.jsonl"])
  })

  test("pruneLog accepts javascript timestamps", () => {
    mkdirSync(env.home, { recursive: true })
    const log = join(env.home, "audits.jsonl")
    const recent = JSON.stringify({ time: new Date(Date.now() - 86400000).toISOString() })
    const old = JSON.stringify({ time: "2020-01-01T00:00:00.000Z" })
    writeFileSync(log, old + "\n" + recent + "\n")
    pruneLog(env.home)
    expect(readFileSync(log, "utf8")).toBe(recent + "\n")
  })

  test("pruneLog without a file or changes does nothing", () => {
    pruneLog(env.home)
    mkdirSync(env.home, { recursive: true })
    const log = join(env.home, "audits.jsonl")
    writeFileSync(log, line(1, "a") + "\n")
    const before = statSync(log).ino
    pruneLog(env.home)
    expect(statSync(log).ino).toBe(before)
  })

  test("session end prunes the log", () => {
    mkdirSync(env.home, { recursive: true })
    const log = join(env.home, "audits.jsonl")
    writeFileSync(log, line(45, "old") + "\n" + line(0, "new") + "\n")
    const result = env.runHook("session-end.ts", { session_id: "s1", hook_event_name: "SessionEnd" })
    expect(result.status).toBe(0)
    expect(env.audits().map((e) => e.sessionID)).toEqual(["new"])
  })
})
