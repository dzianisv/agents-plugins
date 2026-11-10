import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dropSuperseded } from "../src/core/gate"
import { bumpNudge, nudgeAllowed, nudgeKey, nudgeText, stopReason, type Nudges } from "../src/core/feedback"
import { classify, isPushCommand, pushBranches, pushHits, splitSegments } from "../src/core/push"
import {
  blockWindow,
  blocksInWindow,
  markReported,
  maxBlocks,
  readState,
  reported,
  writeBudget,
  safeSessionID,
  statePath,
  writeState,
  type StateEntry,
} from "../src/core/state"
import {
  check,
  ensureConfig,
  envWithSecrets,
  home,
  needsReview,
  parseVerdict,
  readModel,
  readRules,
} from "../src/core/review"

const packageDir = join(import.meta.dir, "..")
const fakeOpencode = join(packageDir, "test", "fixtures", "fake-opencode")

const entry = (sha: string, status: "pass" | "pending" | "fail" = "pending") => ({
  repo: "",
  owner: "",
  name: "",
  branch: "b",
  sha,
  pushed_at: null,
  status,
  checks: [],
  error: null,
})

describe("isPushCommand", () => {
  test.each([
    ["git push", true],
    ["cd repo && git push origin feature/x", true],
    ["git -C /repo push -u origin feature/x", true],
    ["gh stack submit", true],
    ["gh stack link 12", true],
    ["scripts/git-sign-batch -m msg", true],
    ["gh pr comment 12 -m 'done'", true],
    ["gh pr create --title t --body b", true],
    ["gh pr merge 12 --squash", true],
    ["gh issue close 3", true],
    ["gh release create v1.0", true],
    ["gh api repos/acme/widgets/issues/1/comments -f body=hi", true],
    ["gh api graphql -f query='mutation { x }'", true],
    ["gh pr view 12", false],
    ["gh pr list", false],
    ["gh issue list", false],
    ["gh api repos/acme/widgets/pulls/1", false],
    ["gh api graphql -f query='query { x }'", false],
    ["git status", false],
    ["git pushd", false],
    ["echo hi", false],
    ["echo git push", false],
  ])("%s is %s", (command, expected) => {
    expect(isPushCommand(command)).toBe(expected)
  })

  test("rejects a non-string", () => {
    expect(isPushCommand(undefined)).toBe(false)
    expect(isPushCommand({ command: "git push" })).toBe(false)
  })
})

describe("splitSegments", () => {
  test("splits on &&, ||, ; and newlines and trims the segments", () => {
    expect(splitSegments("a && b || c ; d\ne")).toEqual(["a", "b", "c", "d", "e"])
    expect(splitSegments("  ")).toEqual([])
  })
})

describe("classify", () => {
  test("finds a git push with -C and its arguments", () => {
    expect(classify(["git", "-C", "/repo", "push", "-u", "origin", "feature/x"])).toEqual({
      kind: "push",
      repo: "/repo",
      args: ["-u", "origin", "feature/x"],
    })
  })

  test("finds the other push-like commands", () => {
    expect(classify(["gh", "stack", "submit"])).toEqual({ kind: "stack" })
    expect(classify(["bin/git-sign-batch", "--dry-run"])).toEqual({ kind: "sign", dry: true })
    expect(classify(["/usr/local/bin/git-sign-batch", "--no-push"])).toEqual({ kind: "sign", dry: true })
  })

  test("finds the GitHub write commands", () => {
    expect(classify(["gh", "pr", "comment", "12", "-m", "hi"])).toEqual({ kind: "post" })
    expect(classify(["gh", "pr", "create"])).toEqual({ kind: "post" })
    expect(classify(["gh", "issue", "close", "3"])).toEqual({ kind: "post" })
    expect(classify(["gh", "release", "create", "v1"])).toEqual({ kind: "post" })
    expect(classify(["gh", "api", "repos/o/r/issues/1/comments", "-f", "body=hi"])).toEqual({ kind: "post" })
    expect(classify(["gh", "api", "graphql", "-f", "query=mutation { x }"])).toEqual({ kind: "post" })
  })

  test("ignores reads", () => {
    expect(classify(["git", "status"])).toBeNull()
    expect(classify(["gh", "stack", "list"])).toBeNull()
    expect(classify(["gh", "pr", "view", "12"])).toBeNull()
    expect(classify(["gh", "pr", "list"])).toBeNull()
    expect(classify(["gh", "issue", "list"])).toBeNull()
    expect(classify(["gh", "api", "repos/o/r/pulls/1"])).toBeNull()
    expect(classify(["gh", "api", "graphql", "-f", "query=query { x }"])).toBeNull()
  })
})

describe("pushHits", () => {
  test("returns every push-like segment", () => {
    const hits = pushHits("git add . && git push origin a && gh stack push")
    expect(hits.map((hit) => hit.hit.kind)).toEqual(["push", "stack"])
    expect(hits[0].segment).toBe("git push origin a")
  })

  test("falls back to a plain split on unbalanced quotes", () => {
    expect(pushHits(`git commit -m "oops && git push`).map((hit) => hit.hit.kind)).toEqual(["push"])
  })
})

describe("pushBranches", () => {
  const git = async (_repo: string, ...args: string[]): Promise<string | null> =>
    args[0] === "remote" ? "origin upstream" : null
  const current = async (): Promise<string | null> => "main"

  test("skips the remote, resolves targets and refs/heads, and expands HEAD", async () => {
    const branches = await pushBranches(
      "/repo",
      ["origin", "feature/x", "local:remote", "refs/heads/thing", "HEAD", "feature/x"],
      git,
      current,
    )
    expect(branches).toEqual(["feature/x", "remote", "thing", "main"])
  })

  test("keeps the source when the target is empty", async () => {
    expect(await pushBranches("/repo", ["feature/x:"], git, current)).toEqual(["feature/x"])
  })
})

describe("dropSuperseded", () => {
  test("drops a cancelled run replaced by a later run of the same check", () => {
    const runs = [
      { name: "sigscanner-check", status: "completed", conclusion: "cancelled", started_at: "2026-11-04T09:02:43Z" },
      { name: "sigscanner-check", status: "completed", conclusion: "success", started_at: "2026-11-04T09:02:48Z" },
    ]
    expect(dropSuperseded(runs).map((run) => run.conclusion)).toEqual(["success"])
  })

  test("keeps a cancelled run with no replacement", () => {
    const runs = [{ name: "lint", status: "completed", conclusion: "cancelled", started_at: "2026-11-04T09:00:00Z" }]
    expect(dropSuperseded(runs)).toEqual(runs)
  })

  test("never drops a failure", () => {
    const runs = [
      { name: "e2e", status: "completed", conclusion: "failure", started_at: "2026-11-04T09:00:00Z" },
      { name: "e2e", status: "completed", conclusion: "success", started_at: "2026-11-04T09:01:00Z" },
    ]
    expect(dropSuperseded(runs)).toHaveLength(2)
  })
})

describe("block ceiling", () => {
  test("maxBlocks defaults to 3 and reads the env", () => {
    expect(maxBlocks({})).toBe(3)
    expect(maxBlocks({ TASK_GH_GUARD_MAX_BLOCKS: "1" })).toBe(1)
    expect(maxBlocks({ TASK_GH_GUARD_MAX_BLOCKS: "0" })).toBe(0)
    expect(maxBlocks({ TASK_GH_GUARD_MAX_BLOCKS: "x" })).toBe(3)
  })

  test("blocksInWindow counts this branch across every sha, inside the window only", () => {
    const dir = mkdtempSync(join(tmpdir(), "tgg-ceiling-"))
    const path = join(dir, "state.json")
    writeBudget(path, {
      "/r|b@aaa": { at: 100 },
      "/r|b@bbb": { at: 200 },
      "/r|other@ccc": { at: 300 },
      "/r|b@ddd": { at: 10 },
    })
    expect(blocksInWindow(path, { repo: "/r", branch: "b" }, 250, 3600)).toBe(3)
    expect(blocksInWindow(path, { repo: "/r", branch: "b" }, 4000, 3600)).toBe(0)
    expect(blocksInWindow(path, { repo: "/r", branch: "b" }, 250, 0)).toBe(0)
    expect(blocksInWindow(path, { repo: "/r", branch: "other" }, 250, 3600)).toBe(1)
    expect(blocksInWindow(path, { repo: "/elsewhere", branch: "b" }, 250, 3600)).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("blockWindow", () => {
  test.each([
    [undefined, 3600],
    ["0", 0],
    ["-5", 0],
    [" 900 ", 900],
    ["+30", 30],
    ["12.5", 3600],
    ["abc", 3600],
    ["", 3600],
  ])("%p seconds", (raw, expected) => {
    expect(blockWindow(raw === undefined ? {} : { TASK_GH_GUARD_BLOCK_WINDOW: raw })).toBe(expected)
  })
})

describe("state files", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tgg-state-"))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("statePath sanitizes the session id", () => {
    expect(safeSessionID("a/b c")).toBe("a_b_c")
    expect(safeSessionID("")).toBe("unknown")
    expect(safeSessionID(undefined)).toBe("unknown")
    expect(statePath("claude", "a/b", { TASK_GH_GUARD_STATE_DIR: dir })).toBe(join(dir, "claude-a_b.json"))
  })

  test("writeState is atomic, deterministic and mode 0600 in a 0700 directory", () => {
    const path = join(dir, "nested", "state.json")
    writeState(path, {
      version: 1,
      entries: [{ repo: "/r", branch: "b", sha: "abcdef123" }],
      reported: {},
    })
    expect(readState(path)).toEqual({
      version: 1,
      entries: [{ repo: "/r", branch: "b", sha: "abcdef123" }],
      reported: {},
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(path, "utf8")).entries).toBeDefined()
  })

  test("readState falls back to an empty state on junk", () => {
    const path = join(dir, "junk.json")
    writeFileSync(path, "{not json")
    expect(readState(path)).toEqual({ version: 1, entries: [] })
    writeFileSync(path, JSON.stringify({ entries: "nope" }))
    expect(readState(path)).toEqual({ version: 1, entries: [] })
  })

  test("reported is true only when every entry is inside the window", () => {
    const path = join(dir, "state.json")
    const entries: StateEntry[] = [
      { repo: "/r", branch: "b", sha: "abcdef123" },
      { repo: "/r", branch: "b", sha: "123456789" },
    ]
    writeState(path, { version: 1, entries })
    expect(reported(path, entries, 1000, 3600)).toBe(false)
    markReported(path, entries, 1000)
    expect(reported(path, entries, 2000, 3600)).toBe(true)
    expect(reported(path, entries, 5000, 3600)).toBe(false)
    expect(reported(path, entries, 2000, 0)).toBe(false)
    expect(reported(path, [], 2000, 3600)).toBe(false)
  })
})

describe("nudges", () => {
  test("pending nudges once per SHA set", () => {
    const nudges: Nudges = {}
    const key = nudgeKey([entry("a")])
    expect(nudgeAllowed("pending", key, nudges)).toBe(true)
    bumpNudge("pending", key, nudges)
    expect(nudgeAllowed("pending", key, nudges)).toBe(false)
  })

  test("fail nudges three times per SHA set, then stops", () => {
    const nudges: Nudges = {}
    const key = nudgeKey([entry("a")])
    for (let index = 0; index < 3; index++) {
      expect(nudgeAllowed("fail", key, nudges)).toBe(true)
      bumpNudge("fail", key, nudges)
    }
    expect(nudgeAllowed("fail", key, nudges)).toBe(false)
  })

  test("a new SHA set resets both counters", () => {
    const nudges: Nudges = {}
    bumpNudge("pending", nudgeKey([entry("a")]), nudges)
    bumpNudge("fail", nudgeKey([entry("a")]), nudges)
    expect(nudgeAllowed("pending", nudgeKey([entry("b")]), nudges)).toBe(true)
    expect(nudgeAllowed("fail", nudgeKey([entry("b")]), nudges)).toBe(true)
  })

  test("nudgeKey ignores passing entries and sorts", () => {
    expect(nudgeKey([entry("b"), entry("a", "pass"), entry("c")])).toBe("b@b,b@c")
    expect(nudgeKey([entry("a", "pass")])).toBe("")
  })
})

describe("nudge texts", () => {
  test("tells the agent what to say per status, prefixed with the plugin name", () => {
    expect(nudgeText({ status: "pending", message: "CI pending on x", entries: [] })).toBe(
      "[task-gh-guard] CI pending on x\n\nSay it is pending; do not claim done.",
    )
    expect(nudgeText({ status: "fail", message: "CI failed on x", entries: [] })).toBe(
      "[task-gh-guard] CI failed on x\n\nFix the failing check or report it as a known failure; do not claim the task is done.",
    )
    expect(stopReason({ status: "pending", message: "", entries: [] })).toContain(
      "[task-gh-guard]",
    )
    expect(stopReason({ status: "fail", message: "", entries: [] })).toContain(
      "Fix the failing check or report it as a known failure",
    )
  })
})

describe("needsReview", () => {
  test.each([
    "git status",
    "gh pr view 3",
    "gh api repos/o/r/pulls/1/comments",
    "gh api graphql -f query='query{a}'",
    "echo git commit",
  ])("%s never reaches the judge", (command) => {
    expect(needsReview(command)).toBe(false)
  })

  test.each([
    "git commit -m x",
    "git push origin b",
    "gh pr comment 3 -b hi",
    "gh api repos/o/r/pulls/1/comments/9/replies -f body='Thanks, fixed.'",
    "gh api graphql -f query='mutation { a }'",
  ])("%s reaches the judge", (command) => {
    expect(needsReview(command)).toBe(true)
  })

  test("a non-string is never reviewed", () => {
    expect(needsReview(undefined)).toBe(false)
  })
})

describe("parseVerdict", () => {
  const cases: Array<[string, { decision: "allow" | "deny"; reason: string } | null]> = [
    ["ALLOW", { decision: "allow", reason: "" }],
    ["DENY: no commit id.", { decision: "deny", reason: "no commit id." }],
    ["**DENY**: no commit id.", { decision: "deny", reason: "no commit id." }],
    ["  allow - fine", { decision: "allow", reason: "fine" }],
    ["I cannot decide", null],
  ]

  test.each(cases)("%p", (reply, expected) => {
    expect(parseVerdict(reply)).toEqual(expected)
  })

  test("uses the first verdict line", () => {
    expect(parseVerdict("thinking\nDENY: first\nALLOW")).toEqual({ decision: "deny", reason: "first" })
  })
})

describe("rules config", () => {
  let dir: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tgg-config-"))
    env = { ...process.env, TASK_GH_GUARD_HOME: join(dir, "home") }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("init creates the default model and rules and never overwrites edits", () => {
    ensureConfig(env)
    expect(home(env)).toBe(join(dir, "home"))
    expect(readModel(env)).toBe("fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest")
    expect(readRules(env)).toContain("Do not resolve threads when replied")
    writeFileSync(join(env.TASK_GH_GUARD_HOME as string, "rules"), "- my rule\n")
    ensureConfig(env)
    expect(readRules(env)).toBe("- my rule")
  })

  test("reads a rules directory of *.md files in order", () => {
    const base = join(dir, "home")
    mkdirSync(join(env.TASK_GH_GUARD_HOME as string, "rules"), { recursive: true })
    writeFileSync(join(base, "rules", "b.md"), "- second\n")
    writeFileSync(join(base, "rules", "a.md"), "- first\n")
    writeFileSync(join(base, "rules", "ignored.txt"), "- ignored\n")
    expect(readRules(env)).toBe("- first\n\n- second")
  })

  test("a missing rules file reads as empty", () => {
    expect(readRules(env)).toBe("")
    expect(readModel(env)).toBe("")
  })

  test("envWithSecrets adds unset ~/.env keys for the judge only", () => {
    writeFileSync(join(dir, ".env"), "# comment\nFOO=bar\nexport BAZ='quoted'\nKEEP=override\n")
    const result = envWithSecrets({ HOME: dir, KEEP: "mine" })
    expect(result.FOO).toBe("bar")
    expect(result.BAZ).toBe("quoted")
    expect(result.KEEP).toBe("mine")
    expect(result.TASK_GH_GUARD_CHILD).toBe("1")
  })
})

describe("check", () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let log: string

  const judgeCalls = (): Array<{ argv: string[]; stdin: string }> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { argv: string[]; stdin: string })
      : []

  const reviewEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...env, ...overrides })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tgg-review-"))
    const bin = join(dir, "bin")
    mkdirSync(bin)
    copyFileSync(fakeOpencode, join(bin, "opencode"))
    chmodSync(join(bin, "opencode"), 0o755)
    log = join(dir, "opencode.log")
    env = {
      ...process.env,
      HOME: dir,
      PATH: `${bin}:${process.env.PATH}`,
      TASK_GH_GUARD_HOME: join(dir, "home"),
      TASK_GH_GUARD_STATE_DIR: join(dir, "state"),
      FAKE_OPENCODE_LOG: log,
      FAKE_OPENCODE_REPLY: "ALLOW",
      AGENTS_NOTIFY_CMD: "true",
      AGENTS_NOTIFY_STATE_DIR: join(dir, "notify-state"),
    }
    delete env.TASK_GH_GUARD_CHILD
    delete env.TASK_GH_GUARD_REVIEW
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("only git writes reach the judge", async () => {
    for (const command of [
      "git status",
      "gh pr view 3",
      "gh api repos/o/r/pulls/1/comments",
      "gh api graphql -f query='query{a}'",
      "echo git commit",
    ]) {
      expect(await check(command, reviewEnv())).toEqual({ decision: "skip", reason: "not a git write" })
    }
    expect(judgeCalls()).toEqual([])
    for (const command of [
      "git commit -m x",
      "git push origin b",
      "gh pr comment 3 -b hi",
      "gh api repos/o/r/pulls/1/comments/9/replies -f body='Thanks, fixed.'",
      "gh api graphql -f query='mutation { a }'",
    ]) {
      expect((await check(command, reviewEnv())).decision).toBe("allow")
    }
  })

  test("the judge gets the model, rules and command, and its session is deleted", async () => {
    const command = "gh pr comment 3 -b hi"
    await check(command, reviewEnv())
    const calls = judgeCalls()
    expect(calls[0].argv.slice(0, 3)).toEqual([
      "run",
      "-m",
      "fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest",
    ])
    expect(calls[0].stdin).toContain("reply with commit id")
    expect(calls[0].stdin).toContain(command)
    expect(calls.at(-1)?.argv).toEqual(["session", "delete", "ses_fake"])
  })

  test("a deny verdict carries its reason", async () => {
    const command = "gh api repos/o/r/pulls/1/comments/9/replies -f body='Thanks, fixed.'"
    expect(await check(command, reviewEnv({ FAKE_OPENCODE_REPLY: "DENY: the reply cites no commit id." }))).toEqual({
      decision: "deny",
      reason: "the reply cites no commit id.",
    })
  })

  test("a deny without a reason names the rules file", async () => {
    const verdict = await check("git commit -m x", reviewEnv({ FAKE_OPENCODE_REPLY: "DENY" }))
    expect(verdict.decision).toBe("deny")
    expect(verdict.reason).toBe(`the command breaks a rule in ${join(dir, "home", "rules")}`)
  })

  test("an unreadable verdict fails open and is logged", async () => {
    const verdict = await check("git commit -m x", reviewEnv({ FAKE_OPENCODE_REPLY: "I cannot decide" }))
    expect(verdict.decision).toBe("skip")
    expect(verdict.reason.startsWith("rule review skipped")).toBe(true)
    const logged = readFileSync(join(dir, "state", "review.jsonl"), "utf8").trim()
    expect(JSON.parse(logged)).toMatchObject({ decision: "skip", model: "fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest" })
  })

  test("a missing opencode fails open", async () => {
    const empty = join(dir, "empty")
    mkdirSync(empty)
    const verdict = await check("git commit -m x", reviewEnv({ PATH: empty }))
    expect(verdict).toEqual({ decision: "skip", reason: "rule review skipped: opencode is not on PATH" })
  })

  test("a judge child is never reviewed", async () => {
    const judgeCwd = mkdtempSync(join(tmpdir(), "tgg-review-judge-"))
    expect((await check("git commit -m x", reviewEnv({ TASK_GH_GUARD_CHILD: "1" }), judgeCwd)).decision).toBe("skip")
    expect((await check("git commit -m x", reviewEnv({ TASK_GH_GUARD_REVIEW: "0" }))).decision).toBe("skip")
    expect(judgeCalls()).toEqual([])
    rmSync(judgeCwd, { recursive: true, force: true })
  })

  test("a leaked child flag outside a judge dir still reviews", async () => {
    expect((await check("git commit -m x", reviewEnv({ TASK_GH_GUARD_CHILD: "1" }))).decision).toBe("allow")
    expect(judgeCalls().length).toBeGreaterThan(0)
  })

  test("an unreadable model or rules file is a skip", async () => {
    const empty = join(dir, "empty-home")
    mkdirSync(empty)
    writeFileSync(join(empty, "model"), "")
    writeFileSync(join(empty, "rules"), "")
    expect(await check("git commit -m x", reviewEnv({ TASK_GH_GUARD_HOME: empty }))).toEqual({
      decision: "skip",
      reason: "no rules or no model configured",
    })
  })
})
