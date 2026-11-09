// Loop probe: run many turns of a failing CI with the real hooks interleaved the way the host runs
// them (record after each push, stop at the end of each turn) and assert the injections stay bounded.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const packageDir = join(import.meta.dir, "..")
const claudeDir = join(packageDir, "src", "claude")
const fakeGh = join(packageDir, "test", "fixtures", "fake-gh")
const fakeOpencode = join(packageDir, "test", "fixtures", "fake-opencode")
const bun = process.execPath
const SLUG = "acme/widgets"
const CEILING = 3

let tmp: string
let repo: string
let origin: string
let ghDir: string
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
  writeFileSync(join(repo, `next-${name.replaceAll("/", "_")}-${Date.now()}.txt`), name)
  git(repo, "add", ".")
  git(repo, "commit", "-m", name)
  git(repo, "push", "origin", name)
  return git(repo, "rev-parse", `refs/heads/${name}`)
}

const failing = (sha: string) =>
  writeFileSync(
    join(ghDir, "scenario.json"),
    JSON.stringify({ repo: SLUG, commits: { [sha]: { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] } } }),
  )

const hook = (script: string, payload: unknown, extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(bun, [join(claudeDir, script)], { input: JSON.stringify(payload), env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 })

const pushHook = () => hook("record.ts", { session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command: "git push origin feature/x" } })
const stop = () => hook("stop.ts", { session_id: "s1", cwd: repo, stop_hook_active: false })
const blocked = (result: ReturnType<typeof stop>) => String(result.stdout).includes('"decision":"block"')

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "tgg-loop-")))
  repo = join(tmp, "repo")
  origin = join(tmp, "origin.git")
  ghDir = join(tmp, "gh")
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
    FAKE_OPENCODE_REPLY: "ALLOW",
    GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"),
    TASK_GH_GUARD_STATE_DIR: stateDir,
    TASK_GH_GUARD_HOME: join(tmp, "home"),
    AGENTS_NOTIFY_CMD: "true",
    AGENTS_NOTIFY_STATE_DIR: join(tmp, "notify-state"),
  }
  delete env.TASK_GH_GUARD_CHILD
  delete env.TASK_GH_GUARD_ENABLED
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe("claude code loop probe", () => {
  test("ten turns, a new failing commit each, block at most the ceiling", () => {
    makeRepo()
    let blocks = 0
    for (let turn = 0; turn < 10; turn++) {
      const sha = turn === 0 ? branch("feature/x") : commit("feature/x")
      failing(sha)
      pushHook()
      if (blocked(stop())) blocks++
    }
    expect(blocks).toBeLessThanOrEqual(CEILING)
  })

  test("the same loop with the state file cleared between turns", () => {
    makeRepo()
    let blocks = 0
    for (let turn = 0; turn < 10; turn++) {
      const sha = turn === 0 ? branch("feature/x") : commit("feature/x")
      failing(sha)
      pushHook()
      if (blocked(stop())) blocks++
      rmSync(join(stateDir, "claude-s1.json"), { force: true })
    }
    expect(blocks).toBeLessThanOrEqual(CEILING)
  })

  test("ten turns on one failing commit block once", () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    pushHook()
    let blocks = 0
    for (let turn = 0; turn < 10; turn++) if (blocked(stop())) blocks++
    expect(blocks).toBe(1)
  })
})

describe("opencode loop probe", () => {
  const pluginEnv = () => ({ ...env, TASK_GH_GUARD_ENABLED: "1", TASK_GH_GUARD_REVIEW: "0" })

  test("ten turns, a new failing commit each, nudge at most the ceiling", async () => {
    makeRepo()
    const prompts: unknown[] = []
    const client = {
      app: { log: async () => ({}) },
      tui: { showToast: async () => {} },
      session: { get: async () => ({ data: {} }), prompt: async (a: unknown) => void prompts.push(a) },
    }
    await (async () => {
      const saved = { ...process.env }
      Object.assign(process.env, pluginEnv())
      try {
        const { TaskGhGuard } = await import("../src/opencode/plugin")
        const hooks = (await TaskGhGuard({ client, directory: repo } as never)) as never as Record<string, (a: never, b?: never) => Promise<void>>
        for (let turn = 0; turn < 10; turn++) {
          const sha = turn === 0 ? branch("feature/x") : commit("feature/x")
          failing(sha)
          await hooks["tool.execute.before"]({ tool: "bash", callID: `c${turn}`, sessionID: "s1" } as never, { args: { command: "git push origin feature/x" } } as never)
          await hooks["tool.execute.after"]({ tool: "bash", callID: `c${turn}`, sessionID: "s1" } as never)
          await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as never)
        }
      } finally {
        process.env = saved
      }
    })()
    expect(prompts.length).toBeLessThanOrEqual(CEILING)
  })

  test("records the nudge in the state file so the ceiling survives a restart", async () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    const client = {
      app: { log: async () => ({}) },
      tui: { showToast: async () => {} },
      session: { get: async () => ({ data: {} }), prompt: async () => {} },
    }
    const saved = { ...process.env }
    Object.assign(process.env, pluginEnv())
    try {
      const { TaskGhGuard } = await import("../src/opencode/plugin")
      const hooks = (await TaskGhGuard({ client, directory: repo } as never)) as never as Record<string, (a: never, b?: never) => Promise<void>>
      await hooks["tool.execute.before"]({ tool: "bash", callID: "c1", sessionID: "s1" } as never, { args: { command: "git push origin feature/x" } } as never)
      await hooks["tool.execute.after"]({ tool: "bash", callID: "c1", sessionID: "s1" } as never)
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as never)
    } finally {
      process.env = saved
    }
    const budget = JSON.parse(readFileSync(join(stateDir, "budget", "opencode-s1.json"), "utf8")) as Record<string, unknown>
    expect(Object.keys(budget)).toHaveLength(1)
  })
})
