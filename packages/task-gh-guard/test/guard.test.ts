import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bumpNudge,
  feedback,
  gate,
  isPushCommand,
  nudgeAllowed,
  nudgeKey,
  record,
  review,
  stateFile,
} from "../opencode/core"
import type { Entry, Nudges } from "../opencode/core"

const packageDir = join(import.meta.dir, "..")
const fakeGh = join(packageDir, "test", "fixtures", "fake-gh")
const saved = {
  PATH: process.env.PATH,
  FAKE_GH_DIR: process.env.FAKE_GH_DIR,
  FAKE_GH_LOG: process.env.FAKE_GH_LOG,
  TASK_GH_GUARD_STATE_DIR: process.env.TASK_GH_GUARD_STATE_DIR,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
}

let tmp: string
let repo: string
let origin: string
let ghDir: string
let ghLog: string

const git = (...args: string[]): string => {
  const result = spawnSync("git", args, { env: process.env, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return (result.stdout ?? "").trim()
}

const makeRepo = () => {
  spawnSync("git", ["init", "--bare", origin], { env: process.env, encoding: "utf8" })
  spawnSync("git", ["init", "-b", "main", repo], { env: process.env, encoding: "utf8" })
  writeFileSync(join(repo, "a.txt"), "a")
  git("-C", repo, "add", ".")
  git("-C", repo, "commit", "-m", "one")
  git("-C", repo, "remote", "add", "origin", "git@github.com:acme/widgets.git")
  git("-C", repo, "push", "-u", "origin", "main")
}

const branch = (name: string): string => {
  git("-C", repo, "checkout", "-B", name)
  writeFileSync(join(repo, `${name.replaceAll("/", "_")}.txt`), name)
  git("-C", repo, "add", ".")
  git("-C", repo, "commit", "-m", name)
  git("-C", repo, "push", "-u", "origin", name)
  return git("-C", repo, "rev-parse", `refs/heads/${name}`)
}

const scenario = (commits: Record<string, unknown>) =>
  writeFileSync(join(ghDir, "scenario.json"), JSON.stringify({ repo: "acme/widgets", commits }))

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tgg-"))
  repo = join(tmp, "repo")
  origin = join(tmp, "origin.git")
  ghDir = join(tmp, "gh")
  ghLog = join(tmp, "gh.log")
  const bin = join(tmp, "bin")
  mkdirSync(ghDir)
  mkdirSync(bin)
  copyFileSync(fakeGh, join(bin, "gh"))
  chmodSync(join(bin, "gh"), 0o755)
  writeFileSync(
    join(tmp, "gitconfig"),
    `[url "${origin}"]\n    insteadOf = git@github.com:acme/widgets.git\n[user]\n    email = t@example.com\n    name = t\n`,
  )
  process.env.PATH = `${bin}:${saved.PATH}`
  process.env.FAKE_GH_DIR = ghDir
  process.env.FAKE_GH_LOG = ghLog
  process.env.TASK_GH_GUARD_STATE_DIR = join(tmp, "state")
  process.env.GIT_CONFIG_GLOBAL = join(tmp, "gitconfig")
  scenario({})
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  process.env.PATH = saved.PATH
  process.env.FAKE_GH_DIR = saved.FAKE_GH_DIR
  process.env.FAKE_GH_LOG = saved.FAKE_GH_LOG
  process.env.TASK_GH_GUARD_STATE_DIR = saved.TASK_GH_GUARD_STATE_DIR
  process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL
})

describe("isPushCommand", () => {
  test("matches the push-like commands", () => {
    expect(isPushCommand("git push")).toBe(true)
    expect(isPushCommand("cd repo && git push origin feature/x")).toBe(true)
    expect(isPushCommand("git -C /repo push -u origin feature/x")).toBe(true)
    expect(isPushCommand("gh stack submit")).toBe(true)
    expect(isPushCommand("gh stack link 12")).toBe(true)
    expect(isPushCommand("scripts/git-sign-batch -m msg")).toBe(true)
  })

  test("ignores everything else", () => {
    expect(isPushCommand("git status")).toBe(false)
    expect(isPushCommand("git pushd")).toBe(false)
    expect(isPushCommand("echo hi")).toBe(false)
    expect(isPushCommand(undefined)).toBe(false)
  })
})

describe("gate", () => {
  test("no state file means pass without calling gh", async () => {
    const result = await gate(join(tmp, "missing.json"))
    expect(result.status).toBe("pass")
    expect(existsSync(ghLog)).toBe(false)
  })

  test("records a landed push and passes when every check succeeds", async () => {
    makeRepo()
    const sha = branch("feature/x")
    const recorded = await record("ses_1", "git push origin feature/x", repo)
    expect(recorded.recorded.map((entry) => entry.branch)).toEqual(["feature/x"])
    expect(recorded.recorded[0].sha).toBe(sha)
    scenario({
      [sha]: {
        check_runs: [{ name: "test", status: "completed", conclusion: "success", details_url: "https://ci/1" }],
        statuses: [],
      },
    })
    const result = await gate(stateFile("opencode", "ses_1"))
    expect(result.status).toBe("pass")
    expect(existsSync(stateFile("opencode", "ses_1"))).toBe(false)
  })

  test("does not record a branch whose local head is not on origin", async () => {
    makeRepo()
    branch("feature/x")
    writeFileSync(join(repo, "later.txt"), "later")
    git("-C", repo, "add", ".")
    git("-C", repo, "commit", "-m", "later")
    const recorded = await record("ses_2", "git push origin feature/x", repo)
    expect(recorded.recorded).toEqual([])
    expect(existsSync(stateFile("opencode", "ses_2"))).toBe(false)
  })

  test("fails with the check URL and PR number", async () => {
    makeRepo()
    const sha = branch("feature/x")
    await record("ses_3", "git push origin feature/x", repo)
    scenario({
      [sha]: {
        check_runs: [
          { name: "build", status: "completed", conclusion: "failure", details_url: "https://ci/2" },
        ],
        pr: 48,
      },
    })
    const result = await gate(stateFile("opencode", "ses_3"))
    expect(result.status).toBe("fail")
    expect(result.message).toContain("build")
    expect(result.message).toContain("https://ci/2")
    expect(result.message).toContain("PR #48")
  })

  test("reports pending for a running check", async () => {
    makeRepo()
    const sha = branch("feature/x")
    await record("ses_4", "git push origin feature/x", repo)
    scenario({
      [sha]: {
        check_runs: [{ name: "build", status: "in_progress", conclusion: null, details_url: "https://ci/3" }],
        statuses: [],
      },
    })
    const result = await gate(stateFile("opencode", "ses_4"))
    expect(result.status).toBe("pending")
    expect(result.message).toContain("CI pending on feature/x@")
    expect(result.message).toContain("https://ci/3")
  })
})

describe("nudges", () => {
  const entry = (sha: string): Entry => ({
    repo: "",
    owner: "",
    name: "",
    branch: "b",
    sha,
    status: "pending",
    checks: [],
  })

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
    for (let i = 0; i < 3; i++) {
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
})

describe("feedback", () => {
  test("tells the agent what to say per status", () => {
    expect(feedback({ status: "pending", message: "CI pending on x", entries: [] })).toContain(
      "Say it is pending; do not claim done.",
    )
    expect(feedback({ status: "fail", message: "CI failed on x", entries: [] })).toContain(
      "Fix the failing check or report it as a known failure",
    )
  })
})

describe("review", () => {
  const reply = "gh api repos/o/r/pulls/1/comments/9/replies -f body='Thanks, fixed.'"

  test("a deny verdict from the judge comes back with its reason", async () => {
    copyFileSync(join(packageDir, "test", "fixtures", "fake-opencode"), join(tmp, "bin", "opencode"))
    chmodSync(join(tmp, "bin", "opencode"), 0o755)
    process.env.TASK_GH_GUARD_HOME = join(tmp, "home")
    process.env.FAKE_OPENCODE_REPLY = "DENY: no commit id."
    try {
      expect(await review(reply)).toEqual({ decision: "deny", reason: "no commit id." })
      expect((await review("git status")).decision).toBe("skip")
    } finally {
      delete process.env.TASK_GH_GUARD_HOME
      delete process.env.FAKE_OPENCODE_REPLY
    }
  })
})
