import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const packageDir = join(import.meta.dir, "..")
const claudeDir = join(packageDir, "src", "claude")
const fakeGh = join(packageDir, "test", "fixtures", "fake-gh")
const fakeOpencode = join(packageDir, "test", "fixtures", "fake-opencode")
const gateBin = join(packageDir, "bin", "pr-ci-gate")
const reviewBin = join(packageDir, "bin", "git-rules-review")
const bun = process.execPath
const SLUG = "acme/widgets"
const REPLY = "gh api repos/o/r/pulls/1/comments/9/replies -f body='Thanks, fixed.'"

let tmp: string
let repo: string
let origin: string
let ghDir: string
let ghLog: string
let gitLog: string
let homeDir: string
let stateDir: string
let env: NodeJS.ProcessEnv

const run = (cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(cmd, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 })

const git = (cwd: string, ...args: string[]): string => {
  const result = run("git", ["-C", cwd, ...args])
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(result.stderr)}`)
  return String(result.stdout).trim()
}

const makeRepo = () => {
  run("git", ["init", "--bare", origin])
  run("git", ["init", "-b", "main", repo])
  writeFileSync(join(repo, "a.txt"), "a")
  git(repo, "add", ".")
  git(repo, "commit", "-m", "one")
  git(repo, "remote", "add", "origin", `git@github.com:${SLUG}.git`)
  git(repo, "push", "-u", "origin", "main")
}

const branch = (name: string): string => {
  git(repo, "checkout", "-B", name)
  writeFileSync(join(repo, `${name.replaceAll("/", "_")}.txt`), name)
  git(repo, "add", ".")
  git(repo, "commit", "-m", name)
  git(repo, "push", "-u", "origin", name)
  return git(repo, "rev-parse", `refs/heads/${name}`)
}

const commit = (name: string): string => {
  writeFileSync(join(repo, `next-${name.replaceAll("/", "_")}.txt`), name)
  git(repo, "add", ".")
  git(repo, "commit", "-m", name)
  git(repo, "push", "origin", name)
  return git(repo, "rev-parse", `refs/heads/${name}`)
}

const scenario = (commits: Record<string, unknown>, extra: { branches?: Record<string, string>; compare?: Record<string, string> } = {}) =>
  writeFileSync(join(ghDir, "scenario.json"), JSON.stringify({ repo: SLUG, commits, ...extra }))

const hook = (script: string, payload: unknown, extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(bun, [join(claudeDir, script)], {
    input: JSON.stringify(payload),
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 120_000,
  })

const pushHook = (session = "s1", command = "git push origin feature/x") =>
  hook("record.ts", {
    session_id: session,
    cwd: repo,
    tool_name: "Bash",
    tool_input: { command },
  })

const stop = (session = "s1", active = false, extra: NodeJS.ProcessEnv = {}) =>
  hook("stop.ts", { session_id: session, cwd: repo, stop_hook_active: active }, extra)

const statePath = (session = "s1") => join(stateDir, `claude-${session}.json`)
const state = (session = "s1") => JSON.parse(readFileSync(statePath(session), "utf8"))
const blocked = (result: ReturnType<typeof stop>) => JSON.parse(String(result.stdout)) as { decision: string; reason: string }

const checkRuns = (runs: unknown[]) => ({ check_runs: runs, statuses: [] as unknown[] })

// Runs `fn` with the given process env, which the opencode plugin reads directly, then restores it.
const withProcessEnv = async <T>(values: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> => {
  const saved: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key]
    process.env[key] = values[key]
  }
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "tgg-")))
  repo = join(tmp, "repo")
  origin = join(tmp, "origin.git")
  ghDir = join(tmp, "gh")
  ghLog = join(tmp, "gh.log")
  gitLog = join(tmp, "git.log")
  homeDir = join(tmp, "home")
  stateDir = join(tmp, "state")
  const bin = join(tmp, "bin")
  mkdirSync(ghDir)
  mkdirSync(bin)
  copyFileSync(fakeGh, join(bin, "gh"))
  copyFileSync(fakeOpencode, join(bin, "opencode"))
  chmodSync(join(bin, "gh"), 0o755)
  chmodSync(join(bin, "opencode"), 0o755)
  writeFileSync(
    join(tmp, "gitconfig"),
    `[url "${origin}"]\n    insteadOf = git@github.com:${SLUG}.git\n[user]\n    email = t@example.com\n    name = t\n`,
  )
  env = {
    ...process.env,
    PATH: `${bin}:${dirname(bun)}:${process.env.PATH}`,
    HOME: tmp,
    FAKE_GH_DIR: ghDir,
    FAKE_GH_LOG: ghLog,
    FAKE_OPENCODE_LOG: join(tmp, "opencode.log"),
    FAKE_OPENCODE_REPLY: "ALLOW",
    GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"),
    GH_GUARD_HOME: homeDir,
    GH_GUARD_STATE_DIR: stateDir,
    AGENTS_NOTIFY_CMD: "true",
    AGENTS_NOTIFY_STATE_DIR: join(tmp, "notify-state"),
  }
  delete env.GH_GUARD_CHILD
  delete env.GH_GUARD_REVIEW
  delete env.GH_GUARD_ENABLED
  scenario({})
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe("record hook", () => {
  test("records a landed push only when local equals origin", () => {
    makeRepo()
    const sha = branch("feature/x")
    expect(pushHook().status).toBe(0)
    const entries = state().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ branch: "feature/x", sha, owner: "acme", name: "widgets", repo })

    writeFileSync(join(repo, "later.txt"), "later")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "later")
    pushHook()
    expect(state().entries[0].sha).toBe(sha)

    git(repo, "checkout", "-b", "feature/local")
    writeFileSync(join(repo, "local.txt"), "local")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "local")
    pushHook("s2", "git push origin feature/local")
    expect(existsSync(statePath("s2"))).toBe(false)
  })

  test("records every branch named on one git push", () => {
    makeRepo()
    const first = branch("feature/a")
    const second = branch("feature/b")
    pushHook("s6", "git push origin feature/a feature/b")
    expect(Object.fromEntries(state("s6").entries.map((entry: { branch: string; sha: string }) => [entry.branch, entry.sha]))).toEqual({
      "feature/a": first,
      "feature/b": second,
    })
  })

  test("ignores a non-push command", () => {
    makeRepo()
    branch("feature/x")
    expect(pushHook("s5", "git status").status).toBe(0)
    expect(existsSync(statePath("s5"))).toBe(false)
  })

  test("does not record a git-sign-batch dry run", () => {
    makeRepo()
    branch("feature/x")
    expect(pushHook("s4", "git-sign-batch --dry-run -m x").status).toBe(0)
    expect(existsSync(statePath("s4"))).toBe(false)
  })

  test("records every open branch of a gh stack push", () => {
    makeRepo()
    const first = branch("stack/a")
    const second = branch("stack/b")
    writeFileSync(
      join(repo, ".git", "gh-stack"),
      JSON.stringify({
        schemaVersion: 1,
        stacks: [
          {
            number: 42,
            branches: [
              { branch: "stack/a", pullRequest: { number: 1 } },
              { branch: "stack/b", pullRequest: { number: 2 } },
              { branch: "stack/merged", pullRequest: { number: 3, merged: true } },
            ],
          },
        ],
      }),
    )
    pushHook("s3", "gh stack push")
    expect(
      Object.fromEntries(state("s3").entries.map((entry: { branch: string; sha: string }) => [entry.branch, entry.sha])),
    ).toEqual({ "stack/a": first, "stack/b": second })
  })

  test("records the current branch on a GitHub post", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook("s7", "gh pr comment 12 -m 'thanks'")
    expect(state("s7").entries).toEqual([expect.objectContaining({ branch: "feature/x", sha })])
  })

  test("does not record a GitHub post from an unpushed branch", () => {
    makeRepo()
    git(repo, "checkout", "-b", "feature/local")
    pushHook("s8", "gh pr comment 12 -m hi")
    expect(existsSync(statePath("s8"))).toBe(false)
  })

  test("never breaks the session on junk input", () => {
    const result = spawnSync(bun, [join(claudeDir, "record.ts")], {
      input: "not json",
      env,
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    expect(String(result.stdout)).toBe("")
  })
})

describe("session-end hook", () => {
  test("reports a session that ended with CI still red", () => {
    makeRepo()
    const sha = branch("feature/x")
    scenario({ [sha]: { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] } })
    pushHook("s9")
    const notified = join(tmp, "ended.txt")
    const recorder = join(tmp, "ended.sh")
    writeFileSync(recorder, `#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> "${notified}"\n`)
    chmodSync(recorder, 0o755)
    const result = hook("session-end.ts", { session_id: "s9", cwd: repo }, { AGENTS_NOTIFY_CMD: recorder })
    expect(result.status).toBe(0)
    const [title, message] = readFileSync(notified, "utf8").trim().split("|")
    expect(title).toBe("gh-guard")
    expect(message).toContain("session ended with CI failed")
  })

  test("stays silent when every recorded commit passes", () => {
    makeRepo()
    const sha = branch("feature/x")
    scenario({ [sha]: { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] } })
    pushHook("s10")
    const notified = join(tmp, "ended-pass.txt")
    const recorder = join(tmp, "ended-pass.sh")
    writeFileSync(recorder, `#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> "${notified}"\n`)
    chmodSync(recorder, 0o755)
    expect(hook("session-end.ts", { session_id: "s10", cwd: repo }, { AGENTS_NOTIFY_CMD: recorder }).status).toBe(0)
    expect(existsSync(notified)).toBe(false)
  })
})

describe("stop hook", () => {
  test("allows when there is no state file and never calls git or gh", () => {
    const spy = join(tmp, "spy")
    mkdirSync(spy)
    writeFileSync(join(spy, "git"), `#!/bin/sh\necho git >> "${gitLog}"\nexit 1\n`)
    writeFileSync(join(spy, "gh"), `#!/bin/sh\necho gh >> "${ghLog}"\nexit 1\n`)
    chmodSync(join(spy, "git"), 0o755)
    chmodSync(join(spy, "gh"), 0o755)
    const result = stop("nothing", false, { PATH: `${spy}:${env.PATH}` })
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe("")
    expect(existsSync(gitLog)).toBe(false)
    expect(existsSync(ghLog)).toBe(false)
  })

  test("a failure blocks with the URL and the PR number", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({
      [sha]: {
        ...checkRuns([
          { name: "build-and-test", status: "completed", conclusion: "failure", details_url: "https://ci.example/runs/1" },
        ]),
        pr: 48,
      },
    })
    const result = stop()
    expect(result.status).toBe(0)
    const payload = blocked(result)
    expect(payload.decision).toBe("block")
    expect(payload.reason).toContain("build-and-test")
    expect(payload.reason).toContain("https://ci.example/runs/1")
    expect(payload.reason).toContain("PR #48")
    expect(existsSync(statePath())).toBe(true)
  })

  test("pending blocks once, then stop_hook_active allows while the state survives", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({
      [sha]: checkRuns([
        { name: "build-and-test", status: "in_progress", conclusion: null, details_url: "https://ci.example/runs/2" },
      ]),
    })
    const first = blocked(stop())
    expect(first.decision).toBe("block")
    expect(first.reason).toContain("CI pending on feature/x@")
    expect(first.reason).toContain("Say it is pending; do not claim done.")
    expect(existsSync(statePath())).toBe(true)

    const second = stop("s1", true)
    expect(second.status).toBe(0)
    expect(String(second.stdout).trim()).toBe("")
    expect(existsSync(statePath())).toBe(true)
  })

  test("pending blocks once per commit", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({ [sha]: checkRuns([{ name: "build-and-test", status: "in_progress", conclusion: null }]) })
    expect(blocked(stop()).decision).toBe("block")
    expect(String(stop().stdout).trim()).toBe("")
    expect(existsSync(statePath())).toBe(true)
  })

  test("pending never blocks twice for the same commit", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({ [sha]: checkRuns([{ name: "build-and-test", status: "in_progress", conclusion: null }]) })
    expect(blocked(stop()).decision).toBe("block")
    expect(String(stop().stdout).trim()).toBe("")
  })

  test("a failure blocks once per turn", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({
      [sha]: checkRuns([
        { name: "build-and-test", status: "completed", conclusion: "failure", details_url: "https://ci.example/runs/1" },
      ]),
    })
    expect(blocked(stop()).decision).toBe("block")
    const second = stop("s1", true)
    expect(second.status).toBe(0)
    expect(String(second.stdout).trim()).toBe("")
    expect(existsSync(statePath())).toBe(true)
  })

  test("a failure blocks once per commit", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({ [sha]: checkRuns([{ name: "build-and-test", status: "completed", conclusion: "failure" }]) })
    expect(blocked(stop()).decision).toBe("block")
    expect(String(stop().stdout).trim()).toBe("")
    const keys = Object.keys(JSON.parse(readFileSync(join(stateDir, "budget", "claude-s1.json"), "utf8")))
    expect(keys.some((key) => key.endsWith(`|feature/x@${sha.slice(0, 7)}`))).toBe(true)
  })

  test("a new commit in the same repo blocks again", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({ [sha]: checkRuns([{ name: "build-and-test", status: "completed", conclusion: "failure" }]) })
    expect(blocked(stop()).decision).toBe("block")

    const newer = commit("feature/x")
    pushHook()
    scenario({
      [sha]: checkRuns([{ name: "build-and-test", status: "completed", conclusion: "failure" }]),
      [newer]: checkRuns([{ name: "build-and-test", status: "completed", conclusion: "failure" }]),
    })
    const result = stop()
    expect(blocked(result).decision).toBe("block")
    expect(String(result.stdout)).toContain(`feature/x@${newer.slice(0, 7)}`)
  })

  test("a failure never blocks twice for the same commit", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({ [sha]: checkRuns([{ name: "build-and-test", status: "completed", conclusion: "failure" }]) })
    expect(blocked(stop()).decision).toBe("block")
    expect(String(stop().stdout).trim()).toBe("")
  })

  test("a stale GH_TOKEN is retried with gh's own auth", () => {
    makeRepo()
    const sha = branch("feature/x")
    scenario({ [sha]: { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] } })
    pushHook()
    const result = stop("s1", false, { GH_TOKEN: "ghp_expired", FAKE_GH_BAD_TOKEN: "1" })
    expect(String(result.stdout)).toBe("")
    expect(existsSync(statePath("s1"))).toBe(false)
  })

  test("a new commit blocks again while the same commit does not", () => {
    makeRepo()
    const first = branch("feature/x")
    scenario({ [first]: checkRuns([{ name: "ci", status: "completed", conclusion: "failure" }]) })
    pushHook()
    expect(blocked(stop()).decision).toBe("block")
    expect(String(stop().stdout).trim()).toBe("")

    const second = commit("feature/x")
    scenario({ [second]: checkRuns([{ name: "ci", status: "completed", conclusion: "failure" }]) })
    pushHook()
    const result = stop()
    expect(blocked(result).decision).toBe("block")
    expect(String(result.stdout)).toContain(`feature/x@${second.slice(0, 7)}`)
  })

  test("ten identical stops block once", () => {
    makeRepo()
    const sha = branch("feature/x")
    scenario({ [sha]: checkRuns([{ name: "ci", status: "completed", conclusion: "failure" }]) })
    pushHook()
    let blocks = 0
    for (let i = 0; i < 10; i++) if (String(stop().stdout).includes("block")) blocks++
    expect(blocks).toBe(1)
  })

  test("a repo with no report still blocks", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({ [sha]: checkRuns([{ name: "build-and-test", status: "completed", conclusion: "failure" }]) })
    const data = state()
    const entry = data.entries[0]
    data.entries.push({ ...entry, repo: "/tmp/other-repo" })
    writeFileSync(statePath(), JSON.stringify(data))
    const budgetDir = join(stateDir, "budget")
    mkdirSync(budgetDir, { recursive: true })
    writeFileSync(join(budgetDir, "claude-s1.json"), JSON.stringify({ [`${entry.repo}|feature/x@${sha.slice(0, 7)}`]: { at: 2 ** 31 - 1 } }))
    expect(blocked(stop()).decision).toBe("block")
  })

  test("a pass allows and deletes the state", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({
      [sha]: checkRuns([
        { name: "build-and-test", status: "completed", conclusion: "success", details_url: "https://ci.example/runs/3" },
      ]),
    })
    const result = stop()
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe("")
    expect(existsSync(statePath())).toBe(false)
  })

  test("a newer foreign commit does not change the verdict", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({
      [sha]: checkRuns([{ name: "test", status: "completed", conclusion: "success", details_url: "https://ci/1" }]),
    })

    const other = join(tmp, "other")
    expect(run("git", ["clone", origin, other]).status).toBe(0)
    git(other, "config", "user.email", "t@example.com")
    git(other, "config", "user.name", "t")
    git(other, "checkout", "feature/x")
    writeFileSync(join(other, "foreign.txt"), "foreign")
    git(other, "add", ".")
    git(other, "commit", "-m", "foreign")
    git(other, "push", "origin", "feature/x")

    const result = stop()
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe("")
    expect(existsSync(statePath())).toBe(false)
    const calls = readFileSync(ghLog, "utf8")
    expect(calls).toContain(sha)
    expect(calls).not.toContain(git(other, "rev-parse", "refs/heads/feature/x"))
  })

  test("a commit the branch no longer contains is not checked", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    const rewritten = "b".repeat(40)
    scenario(
      { [sha]: checkRuns([{ name: "build-and-test", status: "completed", conclusion: "failure" }]) },
      { branches: { "feature/x": rewritten }, compare: { [`${sha}...${rewritten}`]: "diverged" } },
    )

    const result = stop()
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe("")
    expect(existsSync(statePath())).toBe(false)
    expect(readFileSync(ghLog, "utf8")).not.toContain("check-runs")
  })

  test("a commit with newer commits on top is still checked", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    const newer = "c".repeat(40)
    scenario(
      { [sha]: checkRuns([{ name: "build-and-test", status: "completed", conclusion: "failure" }]) },
      { branches: { "feature/x": newer }, compare: { [`${sha}...${newer}`]: "ahead" } },
    )

    expect(blocked(stop()).decision).toBe("block")
  })

  test("does nothing when the guard is disabled", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({ [sha]: checkRuns([{ name: "t", status: "completed", conclusion: "failure" }]) })
    const result = stop("s1", false, { GH_GUARD_ENABLED: "0" })
    expect(String(result.stdout).trim()).toBe("")
  })
})

describe("pr-ci-gate CLI", () => {
  test("a missing state file is a pass without calling gh", () => {
    const result = run(gateBin, ["--state", join(tmp, "missing.json"), "--json"])
    expect(result.status).toBe(0)
    expect(JSON.parse(String(result.stdout))).toEqual({ status: "pass", message: "", entries: [] })
    expect(existsSync(ghLog)).toBe(false)
  })

  test("a recorded branch that passes is reported and the state is deleted", () => {
    makeRepo()
    const sha = branch("feature/x")
    pushHook()
    scenario({ [sha]: checkRuns([{ name: "test", status: "completed", conclusion: "success" }]) })
    const result = run(gateBin, ["--state", statePath()])
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe("")
    expect(existsSync(statePath())).toBe(false)
  })

  test("an ad hoc branch prints the passing label", () => {
    makeRepo()
    const sha = branch("feature/x")
    scenario({ [sha]: checkRuns([{ name: "test", status: "completed", conclusion: "success" }]) })
    const result = run(gateBin, ["--repo", repo, "feature/x"])
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe(`CI passing: feature/x@${sha.slice(0, 7)}`)
  })

  test("a branch named review is checked, not routed to the review CLI", () => {
    makeRepo()
    const sha = branch("review")
    scenario({ [sha]: checkRuns([{ name: "test", status: "completed", conclusion: "success" }]) })
    const result = run(gateBin, ["--repo", repo, "review"])
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe(`CI passing: review@${sha.slice(0, 7)}`)
  })

  test("a failure exits 1 with the failing checks as JSON", () => {
    makeRepo()
    const sha = branch("feature/x")
    scenario({
      [sha]: { ...checkRuns([{ name: "build", status: "completed", conclusion: "failure", details_url: "https://ci/9" }]), pr: 7 },
    })
    const result = run(gateBin, ["--repo", repo, "feature/x", "--json"])
    expect(result.status).toBe(1)
    const gate = JSON.parse(String(result.stdout))
    expect(gate.status).toBe("fail")
    expect(gate.message).toContain("build")
    expect(gate.message).toContain("PR #7")
  })

  test("a pending check exits 2", () => {
    makeRepo()
    const sha = branch("feature/x")
    scenario({ [sha]: checkRuns([{ name: "build", status: "in_progress", conclusion: null }]) })
    expect(run(gateBin, ["--repo", repo, "feature/x"]).status).toBe(2)
  })

  test("record is the internal recorder", () => {
    makeRepo()
    const sha = branch("feature/x")
    const result = run(gateBin, [
      "record",
      "--runtime",
      "claude",
      "--session",
      "s9",
      "--cwd",
      repo,
      "--command",
      "git push origin feature/x",
    ])
    expect(result.status).toBe(0)
    expect(JSON.parse(String(result.stdout)).recorded[0]).toMatchObject({ branch: "feature/x", sha })
    expect(existsSync(statePath("s9"))).toBe(true)
  })
})

describe("review hook", () => {
  const payload = (command = REPLY) => ({ tool_name: "Bash", tool_input: { command } })

  test("denies with the reason", () => {
    const result = hook("review.ts", payload(), { FAKE_OPENCODE_REPLY: "DENY: no commit id." })
    expect(result.status).toBe(0)
    const out = JSON.parse(String(result.stdout)).hookSpecificOutput
    expect(out.permissionDecision).toBe("deny")
    expect(out.permissionDecisionReason).toContain("no commit id.")
  })

  test("warns loudly when the judge cannot run", () => {
    const notified = join(tmp, "notified.txt")
    const recorder = join(tmp, "notify.sh")
    writeFileSync(recorder, `#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> "${notified}"\n`)
    chmodSync(recorder, 0o755)
    const result = hook("review.ts", payload(), {
      FAKE_OPENCODE_REPLY: "no idea",
      AGENTS_NOTIFY_CMD: recorder,
    })
    const out = JSON.parse(String(result.stdout))
    expect(out.systemMessage).toContain("rule review skipped")
    expect(out.hookSpecificOutput.additionalContext).toContain("tell the user")
    const [title, message] = readFileSync(notified, "utf8").trim().split("|")
    expect(title).toBe("gh-guard")
    expect(message).toContain("rule review skipped")
  })

  test("is silent for other commands and allowed writes", () => {
    for (const [command, reply] of [
      ["ls", "DENY: x"],
      [REPLY, "ALLOW"],
    ]) {
      const result = hook("review.ts", payload(command), { FAKE_OPENCODE_REPLY: reply })
      expect(result.status).toBe(0)
      expect(String(result.stdout)).toBe("")
    }
  })

  test("warns instead of denying when opencode is missing", () => {
    const empty = join(tmp, "empty")
    mkdirSync(empty)
    const result = hook("review.ts", payload(), { PATH: empty })
    expect(result.status).toBe(0)
    expect(String(result.stdout)).toContain("rule review skipped: opencode is not on PATH")
  })
})

// The process env both opencode plugin tests read directly.
const pluginEnv = (): NodeJS.ProcessEnv => ({
  PATH: env.PATH,
  HOME: env.HOME,
  FAKE_GH_DIR: ghDir,
  FAKE_GH_LOG: ghLog,
  FAKE_OPENCODE_REPLY: "ALLOW",
  GH_GUARD_HOME: homeDir,
  GH_GUARD_STATE_DIR: stateDir,
  GH_GUARD_ENABLED: "1",
  GH_GUARD_REVIEW: "1",
  GH_GUARD_CHILD: "",
  AGENTS_NOTIFY_CMD: "true",
  AGENTS_NOTIFY_STATE_DIR: join(tmp, "notify-state"),
})

describe("opencode v1 plugin", () => {
  const client = () => ({
    app: { log: async () => ({}) },
    tui: { showToast: async () => {} },
    session: { get: async () => ({ data: {} }), prompt: async () => ({}) },
  })

  test("records a push from the tool hooks with the directory as cwd", async () => {
    makeRepo()
    const sha = branch("feature/x")
    await withProcessEnv(pluginEnv(), async () => {
      const { TaskGhGuard } = await import("../src/opencode/plugin")
      const hooks = (await TaskGhGuard({ client: client(), directory: repo } as any)) as any
      await hooks["tool.execute.before"](
        { tool: "bash", callID: "c1", sessionID: "s1" },
        { args: { command: "git push origin feature/x" } },
      )
      await hooks["tool.execute.after"]({ tool: "bash", callID: "c1", sessionID: "s1" })
    })
    const data = JSON.parse(readFileSync(join(stateDir, "opencode-s1.json"), "utf8"))
    expect(data.entries[0]).toMatchObject({ branch: "feature/x", sha, owner: "acme", name: "widgets", repo })
  })

  test("a denied command throws with the rule reason", async () => {
    makeRepo()
    branch("feature/x")
    await withProcessEnv({ ...pluginEnv(), FAKE_OPENCODE_REPLY: "DENY: no commit id." }, async () => {
      const { TaskGhGuard } = await import("../src/opencode/plugin")
      const hooks = (await TaskGhGuard({ client: client(), directory: repo } as any)) as any
      await expect(
        hooks["tool.execute.before"](
          { tool: "bash", callID: "c2", sessionID: "s1" },
          { args: { command: "gh pr comment 3 -b hi" } },
        ),
      ).rejects.toThrow("gh-guard rules: no commit id.")
    })
  })

  test("nudges the session when the turn ends with CI red", async () => {
    makeRepo()
    const sha = branch("feature/x")
    const prompts: any[] = []
    const c = { ...client(), session: { get: async () => ({ data: {} }), prompt: async (a: any) => void prompts.push(a) } }
    await withProcessEnv(pluginEnv(), async () => {
      const { TaskGhGuard } = await import("../src/opencode/plugin")
      const hooks = (await TaskGhGuard({ client: c, directory: repo } as any)) as any
      await hooks["tool.execute.before"]({ tool: "bash", callID: "c9", sessionID: "s9" }, { args: { command: "git push origin feature/x" } })
      await hooks["tool.execute.after"]({ tool: "bash", callID: "c9", sessionID: "s9" })
      scenario({ [sha]: { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] } })
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s9" } } })
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0].path.id).toBe("s9")
    expect(prompts[0].body.parts[0].text).toContain("[gh-guard]")
    expect(prompts[0].body.parts[0].text).toContain("CI failed on feature/x@")
  })
})

describe("opencode v2 server", () => {
  type Hook = (event: any) => Promise<any>

  const fakeCtx = () => {
    const hooks = new Map<string, Hook>()
    const queue: any[] = []
    const prompts: any[] = []
    let waiter: (() => void) | undefined
    const ctx = {
      location: { directory: repo },
      tool: {
        hook: async (name: string, fn: Hook) => {
          hooks.set(name, fn)
        },
      },
      event: {
        subscribe: async function* (options: { signal?: AbortSignal }) {
          for (;;) {
            if (options?.signal?.aborted) return
            if (!queue.length) {
              await new Promise<void>((resolve) => (waiter = resolve))
              continue
            }
            yield queue.shift()
          }
        },
      },
      session: { get: async () => undefined, prompt: async (a: any) => void prompts.push(a) },
    }
    const push = (event: any) => {
      queue.push(event)
      waiter?.()
      waiter = undefined
    }
    return { ctx, hooks, push, prompts }
  }

  const setup = async () => {
    const { ctx, hooks, push, prompts } = fakeCtx()
    const dispose = (await (await import("../server")).default.setup(ctx)) as (() => void) | undefined
    return { hooks, dispose, push, prompts }
  }

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10))
  }

  test("denies a write with the rule reason", async () => {
    await withProcessEnv({ ...pluginEnv(), FAKE_OPENCODE_REPLY: "DENY: no commit id." }, async () => {
      const { hooks, dispose } = await setup()
      const before = hooks.get("execute.before")!
      await expect(before({ tool: "shell", sessionID: "s1", input: { command: "gh pr comment 3 -b hi" } })).rejects.toThrow(
        "gh-guard rules: no commit id.",
      )
      dispose?.()
    })
  })

  test("allows a write and returns the event", async () => {
    await withProcessEnv(pluginEnv(), async () => {
      const { hooks, dispose } = await setup()
      const before = hooks.get("execute.before")!
      const event = { tool: "shell", sessionID: "s1", input: { command: 'git commit -m "msg"' } }
      await expect(before(event)).resolves.toBe(event)
      dispose?.()
    })
  })

  test("notifies when the review was skipped", async () => {
    const notified = join(tmp, "notified-v2.txt")
    const recorder = join(tmp, "notify-v2.sh")
    writeFileSync(recorder, `#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> "${notified}"\n`)
    chmodSync(recorder, 0o755)
    await withProcessEnv({ ...pluginEnv(), FAKE_OPENCODE_REPLY: "no idea", AGENTS_NOTIFY_CMD: recorder }, async () => {
      const { hooks, dispose } = await setup()
      const before = hooks.get("execute.before")!
      await before({ tool: "shell", sessionID: "s1", input: { command: 'git commit -m "msg"' } })
      const [title, message] = readFileSync(notified, "utf8").trim().split("|")
      expect(title).toBe("gh-guard")
      expect(message).toContain("rule review skipped")
      dispose?.()
    })
  })

  test("ignores other tools and commands without text", async () => {
    await withProcessEnv({ ...pluginEnv(), FAKE_OPENCODE_REPLY: "DENY: x" }, async () => {
      const { hooks, dispose } = await setup()
      const before = hooks.get("execute.before")!
      const other = { tool: "read", sessionID: "s1", input: { command: 'git commit -m "msg"' } }
      await expect(before(other)).resolves.toBe(other)
      const empty = { tool: "shell", sessionID: "s1", input: {} }
      await expect(before(empty)).resolves.toBe(empty)
      dispose?.()
    })
  })
})

describe("session-start hook and review CLI", () => {
  test("creates the defaults, prints the home and keeps edits", () => {
    const result = hook("session-start.ts", {})
    expect(result.status).toBe(0)
    expect(String(result.stdout).trim()).toBe(homeDir)
    expect(readFileSync(join(homeDir, "model"), "utf8").trim()).toBe(
      "fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest",
    )
    expect(readFileSync(join(homeDir, "rules"), "utf8")).toContain("Do not resolve threads when replied")
    writeFileSync(join(homeDir, "rules"), "- my rule\n")
    expect(hook("session-start.ts", {}).status).toBe(0)
    expect(readFileSync(join(homeDir, "rules"), "utf8")).toBe("- my rule\n")
  })

  test("the git-rules-review wrapper inits and checks", () => {
    const init = run(reviewBin, ["init"])
    expect(init.status).toBe(0)
    expect(String(init.stdout).trim()).toBe(homeDir)
    const checked = run(reviewBin, ["check", "--command", "git status"])
    expect(checked.status).toBe(0)
    expect(JSON.parse(String(checked.stdout))).toEqual({ decision: "skip", reason: "not a git write" })
  })
})
