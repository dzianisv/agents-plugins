// Runs inside the e2e container: copies the read-only repo, installs one plugin the way a user
// does, runs one runtime on the spec's prompt, runs the checks and writes /out/<plugin>-<runtime>.json.
import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadSpec, type Check, type CheckContext, type CheckResult, type Runtime, type Spec } from "./spec"

const SRC = "/src"
const WORK = "/work/agents-plugins"
const OUT = "/out"
const DEFAULT_CLAUDE_MODEL = "haiku"
const DEFAULT_OPENCODE_MODEL = "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash"
// Headless `claude -p` runs never emit SessionEnd hook events (verified on 2.1.283).
const HOOKS_NOT_EMITTED = new Set(["SessionEnd"])
const EXCLUDED = new Set(["node_modules", ".git", ".promptfoo"])

/** One parsed event of a `claude --output-format stream-json` line. */
export type StreamEvent = {
  type?: string
  subtype?: string
  hook_event?: string
  outcome?: string
  plugins?: Array<{ name?: string; source?: string }>
}

/** Parses the JSON lines of a stream-json run, skipping anything that is not an object. */
export function streamEvents(stdout: string): StreamEvent[] {
  const events: StreamEvent[] = []
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue
    try {
      const event = JSON.parse(line) as unknown
      if (event && typeof event === "object") events.push(event as StreamEvent)
    } catch {}
  }
  return events
}

// The prefixes are split so this source file never contains a credential-looking literal.
const CREDENTIAL_PREFIXES = ["f" + "w_", "sk-" + "ant", "g" + "hp_"]
const CREDENTIAL = new RegExp(`(?:${CREDENTIAL_PREFIXES.join("|")})[A-Za-z0-9_-]{6,}`, "g")

/** Replaces credential-looking tokens; auth file contents are never written or printed anyway. */
export function redact(text: string): string {
  return text.replace(CREDENTIAL, "[redacted]")
}

/** The last 40 lines of some output, redacted and capped; the result file's debug tail. */
export function tail(...parts: string[]): string {
  return redact(parts.filter(Boolean).join("\n").split("\n").slice(-40).join("\n")).slice(-4000)
}

type ExecResult = { code: number | null; stdout: string; stderr: string }
type CheckRecord = { name: string; ok: boolean; detail?: string }

function exec(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += chunk))
    child.stderr?.on("data", (chunk) => (stderr += chunk))
    child.on("error", (err) => resolve({ code: null, stdout, stderr: stderr || String(err) }))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isSymbolicLink()) symlinkSync(readlinkSync(src), dest)
    else if (entry.isDirectory()) copyTree(src, dest)
    else copyFileSync(src, dest)
  }
}

function installOpencode(plugin: string, home: string): void {
  const configPath = join(home, ".config", "opencode", "opencode.json")
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { plugins?: string[] }
  config.plugins = [join(WORK, "packages", plugin)]
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

async function installClaude(plugin: string, home: string): Promise<string> {
  const marketplaceFile = join(WORK, ".claude-plugin", "marketplace.json")
  const marketplace = (JSON.parse(readFileSync(marketplaceFile, "utf8")) as { name: string }).name
  const added = await exec("claude", ["plugin", "marketplace", "add", WORK], { env: { ...process.env, HOME: home } })
  if (added.code !== 0) throw new Error(`claude plugin marketplace add failed: ${tail(added.stderr)}`)
  const installed = await exec("claude", ["plugin", "install", `${plugin}@${marketplace}`], { env: { ...process.env, HOME: home } })
  if (installed.code !== 0) throw new Error(`claude plugin install failed: ${tail(installed.stderr)}`)
  const list = await exec("claude", ["plugin", "list"], { env: { ...process.env, HOME: home } })
  return list.stdout
}

function runRuntime(runtime: Runtime, spec: Spec, cwd: string, env: NodeJS.ProcessEnv): Promise<ExecResult> {
  // opencode 2.0.29 resolves the session directory from $PWD, not from the process cwd.
  const childEnv = { ...env, PWD: cwd }
  if (runtime === "claude") {
    const args = [
      "-p",
      spec.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--model",
      DEFAULT_CLAUDE_MODEL,
      "--max-turns",
      String(spec.claude?.maxTurns ?? 2),
    ]
    if (spec.claude?.permissionMode) args.push("--permission-mode", spec.claude.permissionMode)
    // Variadic, so it must stay last.
    if (spec.claude?.allowedTools?.length) args.push("--allowedTools", ...spec.claude.allowedTools)
    return exec("claude", args, { cwd, env: childEnv })
  }
  return exec("opencode", ["run", "--print-logs", "--log-level", "debug", "-m", DEFAULT_OPENCODE_MODEL, spec.prompt], { cwd, env: childEnv })
}

function claudeLoaded(plugin: string, ctx: CheckContext, installed: string): CheckResult {
  const init = streamEvents(ctx.stdout).find((event) => event.subtype === "init")
  if (!init) return { ok: false, detail: "no system/init event in the stream" }
  const listed = (init.plugins ?? []).some((entry) => entry.name === plugin && typeof entry.source === "string" && entry.source.startsWith(`${plugin}@`))
  if (!listed) return { ok: false, detail: `init plugins: ${(init.plugins ?? []).map((entry) => entry.name).join(", ") || "none"}` }
  if (!installed.includes(`${plugin}@`) || !installed.includes("enabled")) {
    return { ok: false, detail: `claude plugin list does not show ${plugin} enabled` }
  }
  return { ok: true, detail: "listed by claude plugin list and by the init event" }
}

function hooksFired(plugin: string, ctx: CheckContext): CheckResult {
  const file = join(ctx.repo, "packages", plugin, "hooks", "hooks.json")
  if (!existsSync(file)) return { ok: true, detail: "no hooks declared" }
  const declared = Object.keys((JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, unknown> }).hooks ?? {}).filter(
    (event) => !HOOKS_NOT_EMITTED.has(event),
  )
  const responses = streamEvents(ctx.stdout).filter((event) => event.subtype === "hook_response")
  const missing = declared.filter((event) => !responses.some((response) => response.hook_event === event && response.outcome === "success"))
  if (missing.length) return { ok: false, detail: `no success hook_response for: ${missing.join(", ")}` }
  return { ok: true, detail: declared.join(", ") }
}

function opencodeLoaded(plugin: string, ctx: CheckContext): CheckResult {
  const dataDir = process.env.XDG_DATA_HOME ?? join(ctx.home, ".local", "share")
  const logPath = join(dataDir, "opencode", "log", "opencode.log")
  let log: string
  try {
    log = readFileSync(logPath, "utf8")
  } catch {
    return { ok: false, detail: `no opencode log at ${logPath}` }
  }
  const dir = join(ctx.repo, "packages", plugin)
  const loaded = log.split("\n").some((line) => line.includes("loading plugin") && line.includes(`id=${dir}`) && line.includes("entrypoint=file://"))
  if (!loaded) return { ok: false, detail: `no "loading plugin" line for ${dir}` }
  const error = log.split("\n").find((line) => line.includes("level=ERROR") && line.includes(dir))
  if (error) return { ok: false, detail: `plugin error in log: ${redact(error).slice(0, 200)}` }
  return { ok: true, detail: `loaded from ${dir}` }
}

function notifyCheck(logPath: string): CheckResult {
  let text = ""
  try {
    text = readFileSync(logPath, "utf8").trim()
  } catch {
    return { ok: true }
  }
  if (!text) return { ok: true }
  return { ok: false, detail: `notify was called: ${redact(text.split("\n")[0]).slice(0, 200)}` }
}

async function genericChecks(runtime: Runtime, plugin: string, ctx: CheckContext, extras: { notifyLog: string; installed: string }): Promise<CheckRecord[]> {
  const checks: CheckRecord[] = [
    { name: "exit code 0", ok: ctx.exitCode === 0, ...(ctx.exitCode === 0 ? {} : { detail: `exit ${ctx.exitCode}: ${tail(ctx.stderr).slice(-160)}` }) },
    { name: "plugin loaded", ...(runtime === "claude" ? claudeLoaded(plugin, ctx, extras.installed) : opencodeLoaded(plugin, ctx)) },
  ]
  if (runtime === "claude") checks.push({ name: "hooks fired", ...hooksFired(plugin, ctx) })
  checks.push({ name: "no notify failure", ...notifyCheck(extras.notifyLog) })
  return checks
}

async function runChecks(checks: Check[], ctx: CheckContext): Promise<CheckRecord[]> {
  const records: CheckRecord[] = []
  for (const check of checks) {
    try {
      records.push({ name: check.name, ...(await check.run(ctx)) })
    } catch (err) {
      records.push({ name: check.name, ok: false, detail: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) })
    }
  }
  return records
}

function writeResult(plugin: string, runtime: Runtime, status: "pass" | "fail", checks: CheckRecord[], logTail = ""): void {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `${plugin}-${runtime}.json`), `${JSON.stringify({ plugin, runtime, status, checks, logTail }, null, 2)}\n`)
}

async function main(runtime: Runtime, plugin: string): Promise<number> {
  const home = process.env.HOME ?? "/home/node"
  const notifyLog = join(OUT, `notify-${plugin}-${runtime}.log`)
  try {
    copyTree(SRC, WORK)
    const spec = await loadSpec(WORK, plugin)
    if (!spec.runtimes.includes(runtime)) throw new Error(`spec for ${plugin} does not support ${runtime}`)
    console.log(`[driver] ${plugin}/${runtime}: installing`)
    let installed = ""
    if (runtime === "claude") installed = await installClaude(plugin, home)
    else installOpencode(plugin, home)
    const cwd = (await spec.setup?.({ runtime, repo: WORK, home, out: OUT })) || join(home, "work")
    mkdirSync(cwd, { recursive: true })
    console.log(`[driver] ${plugin}/${runtime}: running the runtime in ${cwd}`)
    const run = await runRuntime(runtime, spec, cwd, {
      ...process.env,
      AGENTS_NOTIFY_CMD: `bun ${join(WORK, "scripts", "e2e", "notify-recorder.ts")}`,
      E2E_NOTIFY_LOG: notifyLog,
    })
    const ctx: CheckContext = { runtime, plugin, repo: WORK, home, out: OUT, exitCode: run.code, stdout: run.stdout, stderr: run.stderr }
    const checks = [...(await genericChecks(runtime, plugin, ctx, { notifyLog, installed })), ...(await runChecks(spec.checks, ctx))]
    const status = checks.every((check) => check.ok) ? "pass" : "fail"
    writeResult(plugin, runtime, status, checks, tail(run.stdout, run.stderr))
    console.log(`[driver] ${plugin}/${runtime}: ${status}`)
    return status === "pass" ? 0 : 1
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err)).slice(0, 500)
    writeResult(plugin, runtime, "fail", [{ name: "driver", ok: false, detail: message }])
    console.log(`[driver] ${plugin}/${runtime}: failed: ${message}`)
    return 1
  }
}

if (import.meta.main) {
  const [runtime, plugin] = process.argv.slice(2)
  if ((runtime !== "claude" && runtime !== "opencode") || !plugin) {
    console.error("usage: bun driver.ts <claude|opencode> <plugin>")
    process.exit(2)
  }
  process.exit(await main(runtime, plugin))
}
