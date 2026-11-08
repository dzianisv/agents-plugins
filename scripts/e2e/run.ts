// Host runner for the plugin e2e containers: builds the image, exports auth to a temp dir, runs one
// container per plugin and runtime, prints a results table and cleans up on exit or Ctrl-C.
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { exportAuth, removeAuth } from "./auth"
import { loadSpec, type Runtime, type Spec } from "./spec"

const IMAGE = "agents-plugins-e2e:local"

/** What one run should do. */
export type Options = {
  plugins: string[]
  runtimes: Runtime[]
  keep: boolean
  noBuild: boolean
  timeout: number
}

/** One check as it appears in a result file. */
export type CheckRecord = { name: string; ok: boolean; detail?: string }

/** One container run as it appears in a result file. */
export type CaseResult = { plugin: string; runtime: Runtime; status: "pass" | "fail"; checks: CheckRecord[]; logTail?: string }

/** Parses the CLI flags; throws with a short message on anything unknown. */
export function parseArgs(argv: string[], available: string[]): Options {
  const options: Options = { plugins: [], runtimes: ["claude", "opencode"], keep: false, noBuild: false, timeout: 300 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--plugin") {
      const value = argv[++i]
      if (!value) throw new Error("--plugin needs a name")
      if (!available.includes(value)) throw new Error(`unknown plugin "${value}" (available: ${available.join(", ") || "none"})`)
      options.plugins.push(value)
    } else if (arg === "--runtime") {
      const value = argv[++i]
      if (value === "all") options.runtimes = ["claude", "opencode"]
      else if (value === "claude" || value === "opencode") options.runtimes = [value]
      else throw new Error(`unknown runtime "${value ?? ""}" (claude, opencode, all)`)
    } else if (arg === "--timeout") {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout needs a positive number of seconds")
      options.timeout = value
    } else if (arg === "--keep") options.keep = true
    else if (arg === "--no-build") options.noBuild = true
    else throw new Error(`unknown flag "${arg}"`)
  }
  if (!options.plugins.length) options.plugins = [...available]
  if (!options.plugins.length) throw new Error("no plugin has an e2e spec")
  return options
}

/** Every package with an e2e spec, sorted. */
export function discoverPlugins(repo: string): string[] {
  try {
    return readdirSync(join(repo, "packages"))
      .filter((name) => existsSync(join(repo, "packages", name, "e2e", "spec.ts")))
      .sort()
  } catch {
    return []
  }
}

/** The requested runtimes a spec actually supports; a one-runtime spec runs one container. */
export function runtimesFor(spec: Spec, requested: Runtime[]): Runtime[] {
  return requested.filter((runtime) => spec.runtimes.includes(runtime))
}

/** Parses one result file; null when it is not a well-formed result. */
export function parseResult(text: string): CaseResult | null {
  try {
    const value = JSON.parse(text) as Partial<CaseResult>
    if (typeof value.plugin !== "string" || !value.plugin) return null
    if (value.runtime !== "claude" && value.runtime !== "opencode") return null
    if (value.status !== "pass" && value.status !== "fail") return null
    if (!Array.isArray(value.checks)) return null
    for (const check of value.checks) {
      if (!check || typeof check.name !== "string" || typeof check.ok !== "boolean") return null
    }
    return value as CaseResult
  } catch {
    return null
  }
}

/** Renders every check of every case as a padded table; long details are truncated. */
export function formatTable(results: CaseResult[]): string {
  const rows = results.flatMap((result) =>
    result.checks.map((check) => [result.plugin, result.runtime, check.name, check.ok ? "PASS" : "FAIL", check.detail ?? ""]),
  )
  if (!rows.length) return "(no results)"
  const truncated = rows.map((row) => row.map((cell, index) => (index === 4 && cell.length > 80 ? `${cell.slice(0, 77)}...` : cell)))
  const headers = ["plugin", "runtime", "check", "result", "detail"]
  const widths = headers.map((header, index) => Math.max(header.length, ...truncated.map((row) => row[index].length)))
  const line = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...truncated.map(line)].join("\n")
}

type ContainerRun = { code: number | null; output: string; timedOut: boolean }

function runContainer(args: string[], name: string, timeoutSeconds: number): Promise<ContainerRun> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" })
      child.kill("SIGKILL")
    }, timeoutSeconds * 1000)
    child.stdout?.on("data", (chunk) => (output += chunk))
    child.stderr?.on("data", (chunk) => (output += chunk))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}${String(err)}`, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

function buildImage(e2e: string, noBuild: boolean): void {
  const hash = createHash("sha256")
    .update(readFileSync(join(e2e, "Dockerfile")))
    .update(readFileSync(join(e2e, "entrypoint.sh")))
    .digest("hex")
    .slice(0, 16)
  const inspect = spawnSync("docker", ["image", "inspect", "--format", '{{ index .Config.Labels "e2e-hash" }}', IMAGE], { encoding: "utf8" })
  const current = inspect.status === 0 ? inspect.stdout.trim() : ""
  if (noBuild) {
    if (!current) throw new Error(`${IMAGE} does not exist and --no-build was given`)
    return
  }
  if (current === hash) return
  console.log(`[e2e] building ${IMAGE} (Dockerfile hash ${hash})`)
  const build = spawnSync("docker", ["build", "-t", IMAGE, "--label", `e2e-hash=${hash}`, "-f", join(e2e, "Dockerfile"), e2e], { stdio: "inherit" })
  if (build.status !== 0) throw new Error("docker build failed")
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: bun scripts/e2e/run.ts [--plugin <name>]... [--runtime claude|opencode|all] [--keep] [--no-build] [--timeout <seconds>]")
    return 0
  }
  const e2e = dirname(fileURLToPath(import.meta.url))
  const repo = dirname(dirname(e2e))
  const available = discoverPlugins(repo)
  const options = parseArgs(argv, available)
  buildImage(e2e, options.noBuild)

  const authDir = mkdtempSync(join(tmpdir(), "agents-plugins-e2e-auth-"))
  const runRoot = mkdtempSync(join(tmpdir(), "agents-plugins-e2e-"))
  const outDir = join(runRoot, "out")
  mkdirSync(outDir, { recursive: true })

  let active: string | null = null
  const cleanup = () => {
    if (active) spawnSync("docker", ["rm", "-f", active], { stdio: "ignore" })
    removeAuth(authDir)
    if (!options.keep) rmSync(runRoot, { recursive: true, force: true })
  }
  const onInt = () => {
    cleanup()
    process.exit(130)
  }
  const onTerm = () => {
    cleanup()
    process.exit(143)
  }
  process.on("SIGINT", onInt)
  process.on("SIGTERM", onTerm)

  const results: CaseResult[] = []
  const outputs = new Map<string, string>()
  try {
    exportAuth(authDir)
    for (const plugin of options.plugins) {
      let runtimes = options.runtimes
      try {
        runtimes = runtimesFor(await loadSpec(repo, plugin), options.runtimes)
      } catch (err) {
        console.log(`[e2e] ${plugin}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!runtimes.length) {
        console.log(`[e2e] ${plugin}: no requested runtime in the spec, skipping`)
        continue
      }
      for (const runtime of runtimes) {
        const key = `${plugin}-${runtime}`
        const workDir = join(runRoot, `work-${key}`)
        mkdirSync(workDir, { recursive: true })
        active = `agents-plugins-e2e-${key}-${process.pid}`
        console.log(`[e2e] ${key}: running the container`)
        const run = await runContainer(
          [
            "run",
            "--rm",
            "--name",
            active,
            "--cpus",
            "2",
            "--memory",
            "2g",
            "--pids-limit",
            "512",
            "-v",
            `${repo}:/src:ro`,
            "-v",
            `${workDir}:/work`,
            "-v",
            `${outDir}:/out`,
            "-v",
            `${authDir}:/auth:ro`,
            IMAGE,
            "/src/scripts/e2e/driver.ts",
            runtime,
            plugin,
          ],
          active,
          options.timeout,
        )
        active = null
        outputs.set(key, run.output)
        const resultFile = join(outDir, `${key}.json`)
        const parsed = existsSync(resultFile) ? parseResult(readFileSync(resultFile, "utf8")) : null
        results.push(
          parsed ?? {
            plugin,
            runtime,
            status: "fail",
            checks: [{ name: "container", ok: false, detail: run.timedOut ? `timed out after ${options.timeout}s` : `no result file (docker exit ${run.code})` }],
          },
        )
      }
    }
  } finally {
    cleanup()
    process.off("SIGINT", onInt)
    process.off("SIGTERM", onTerm)
  }

  console.log(`\n${formatTable(results)}\n`)
  const failed = results.filter((result) => result.status !== "pass")
  console.log(`${results.length - failed.length}/${results.length} cases passed`)
  for (const result of failed) {
    const output = outputs.get(`${result.plugin}-${result.runtime}`) ?? ""
    const lines = output.trim().split("\n").slice(-20).join("\n")
    if (lines) console.log(`\n--- ${result.plugin}/${result.runtime} container output ---\n${lines}`)
  }
  if (options.keep) console.log(`\nresults kept in ${runRoot}`)
  return failed.length ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (err) {
    console.error(`[e2e] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
}
