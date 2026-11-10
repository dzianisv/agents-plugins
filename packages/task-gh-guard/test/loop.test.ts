// Loop probe: the loop was the same commit being delivered for on every turn. These probes drive the
// real hooks the way the host runs them and assert one delivery per commit, however many stops, even
// when the state file is deleted between turns or the plugin is reloaded.
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

const scenario = (sha: string, conclusion: "failure" | "success" | null) =>
  writeFileSync(
    join(ghDir, "scenario.json"),
    JSON.stringify({
      repo: SLUG,
      commits: { [sha]: { check_runs: [{ name: "ci", status: conclusion ? "completed" : "in_progress", conclusion }] } },
    }),
  )

const failing = (sha: string) => scenario(sha, "failure")
const passing = (sha: string) => scenario(sha, "success")

const hook = (script: string, payload: unknown, extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(bun, [join(claudeDir, script)], { input: JSON.stringify(payload), env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 })

const pushHook = () => hook("record.ts", { session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command: "git push origin feature/x" } })
const stop = (extra: NodeJS.ProcessEnv = {}) => hook("stop.ts", { session_id: "s1", cwd: repo, stop_hook_active: false }, extra)
const blocked = (result: ReturnType<typeof stop>) => String(result.stdout).includes('"decision":"block"')
const stateFile = () => join(stateDir, "claude-s1.json")

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
  test("one failing commit blocks once, however many stops", () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    pushHook()
    let blocks = 0
    for (let turn = 0; turn < 10; turn++) if (blocked(stop())) blocks++
    expect(blocks).toBe(1)
  })

  test("deleting the state file between stops does not re-arm the same commit", () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    pushHook()
    let blocks = 0
    for (let turn = 0; turn < 10; turn++) {
      if (blocked(stop())) blocks++
      rmSync(stateFile(), { force: true })
    }
    expect(blocks).toBe(1)
  })

  test("a passing gate that deletes the state does not re-arm the same commit", () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    pushHook()
    let blocks = 0
    for (let turn = 0; turn < 10; turn++) {
      if (blocked(stop())) blocks++
      // The commit then goes green, so the next stop's gate() deletes the state file.
      passing(sha)
      stop()
      expect(existsSync(stateFile())).toBe(false)
    }
    expect(blocks).toBe(1)
  })

  test("a zero window does not re-arm the same commit", () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    pushHook()
    let blocks = 0
    for (let turn = 0; turn < 10; turn++) if (blocked(stop({ TASK_GH_GUARD_BLOCK_WINDOW: "0" }))) blocks++
    expect(blocks).toBe(1)
  })

  test("a genuinely new commit blocks once more", () => {
    makeRepo()
    const first = branch("feature/x")
    failing(first)
    pushHook()
    expect(blocked(stop())).toBe(true)

    const second = commit("feature/x")
    failing(second)
    pushHook()
    expect(blocked(stop())).toBe(true)
  })
})

describe("opencode loop probe", () => {
  const pluginEnv = () => ({ ...env, TASK_GH_GUARD_ENABLED: "1", TASK_GH_GUARD_REVIEW: "0" })

  const makeClient = (prompts: unknown[]) => ({
    app: { log: async () => ({}) },
    tui: { showToast: async () => {} },
    session: { get: async () => ({ data: {} }), prompt: async (a: unknown) => void prompts.push(a) },
  })

  const turn = async (hooks: Record<string, (a: never, b?: never) => Promise<void>>, index: number, command = "git push origin feature/x") => {
    await hooks["tool.execute.before"]({ tool: "bash", callID: `c${index}`, sessionID: "s1" } as never, { args: { command } } as never)
    await hooks["tool.execute.after"]({ tool: "bash", callID: `c${index}`, sessionID: "s1" } as never)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } } as never)
  }

  const hooksFor = async (prompts: unknown[]) => {
    const { TaskGhGuard } = await import("../src/opencode/plugin")
    return (await TaskGhGuard({ client: makeClient(prompts), directory: repo } as never)) as never as Record<string, (a: never, b?: never) => Promise<void>>
  }

  const withEnv = async (body: () => Promise<void>) => {
    const saved = { ...process.env }
    Object.assign(process.env, pluginEnv())
    try {
      await body()
    } finally {
      process.env = saved
    }
  }

  test("one failing commit nudges once, however many turns", async () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    const prompts: unknown[] = []
    await withEnv(async () => {
      const hooks = await hooksFor(prompts)
      for (let index = 0; index < 10; index++) await turn(hooks, index)
    })
    expect(prompts.length).toBe(1)
  })

  test("deleting the state file between turns does not re-arm the same commit", async () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    const prompts: unknown[] = []
    await withEnv(async () => {
      const hooks = await hooksFor(prompts)
      for (let index = 0; index < 10; index++) {
        await turn(hooks, index)
        rmSync(join(stateDir, "opencode-s1.json"), { force: true })
      }
    })
    expect(prompts.length).toBe(1)
  })

  test("reloading the plugin each turn does not re-arm the same commit", async () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    const prompts: unknown[] = []
    await withEnv(async () => {
      for (let index = 0; index < 10; index++) await turn(await hooksFor(prompts), index)
    })
    expect(prompts.length).toBe(1)
  })

  test("a genuinely new commit nudges once more", async () => {
    makeRepo()
    const first = branch("feature/x")
    failing(first)
    const prompts: unknown[] = []
    await withEnv(async () => {
      const hooks = await hooksFor(prompts)
      await turn(hooks, 0)
      const second = commit("feature/x")
      failing(second)
      await turn(hooks, 1)
    })
    expect(prompts.length).toBe(2)
  })

  test("records the delivery in the report file so it survives a restart", async () => {
    makeRepo()
    const sha = branch("feature/x")
    failing(sha)
    const prompts: unknown[] = []
    await withEnv(async () => {
      const hooks = await hooksFor(prompts)
      await turn(hooks, 0)
    })
    const report = JSON.parse(readFileSync(join(stateDir, "budget", "opencode-s1.json"), "utf8")) as Record<string, unknown>
    expect(Object.keys(report)).toHaveLength(1)
  })
})
