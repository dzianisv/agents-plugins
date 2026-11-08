// The spec type every plugin e2e test uses, plus loading and validation for the container driver.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** The two runtimes a spec can target. */
export type Runtime = "claude" | "opencode"

/** The outcome of one check; `detail` is shown in the results table. */
export type CheckResult = { ok: boolean; detail?: string }

/** Everything a check may read after the runtime run. */
export type CheckContext = {
  runtime: Runtime
  plugin: string
  repo: string
  home: string
  out: string
  exitCode: number | null
  stdout: string
  stderr: string
}

/** One named plugin-specific assertion. */
export type Check = { name: string; run: (ctx: CheckContext) => CheckResult | Promise<CheckResult> }

/** Claude Code run options a spec may set. */
export type ClaudeOptions = { maxTurns?: number; allowedTools?: string[]; permissionMode?: string }

/** What a spec may prepare inside the container before the runtime starts. */
export type SetupContext = { runtime: Runtime; repo: string; home: string; out: string }

/** One plugin's end-to-end spec. */
export type Spec = {
  plugin: string
  runtimes: Runtime[]
  prompt: string
  claude?: ClaudeOptions
  /** Extra environment variables for the runtime process; the notify recorder wins on conflicts. */
  env?: Record<string, string>
  /** Prepares container state and returns the directory the runtime runs in. */
  setup?: (ctx: SetupContext) => string | void | Promise<string | void>
  checks: Check[]
}

/** Declares a plugin e2e spec. */
export function defineSpec(spec: Spec): Spec {
  return spec
}

/** Polls `probe` until it returns a value or `timeoutMs` passes; undefined when it never does. */
export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 120_000, stepMs = 2000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/** The opencode log line that shows the plugin dir failed to load, or undefined when it loaded. */
export function opencodeLoadFailure(log: string, pluginDir: string): string | undefined {
  return log.split("\n").find((line) => line.includes(pluginDir) && (line.includes("level=ERROR") || line.includes("failed to load plugin")))
}

/** A spec check that the opencode log shows the plugin loaded without a failed-to-load line. */
export function opencodeLoadedCheck(plugin: string): Check {
  return {
    name: "loaded in opencode",
    run: (ctx) => {
      const dir = join(ctx.repo, "packages", plugin)
      const dataDir = process.env.XDG_DATA_HOME ?? join(ctx.home, ".local", "share")
      const logPath = join(dataDir, "opencode", "log", "opencode.log")
      let log: string
      try {
        log = readFileSync(logPath, "utf8")
      } catch {
        return { ok: false, detail: `no opencode log at ${logPath}` }
      }
      if (!log.includes("loading plugin") || !log.includes(`id=${dir}`)) return { ok: false, detail: `no "loading plugin" line for ${dir}` }
      const failure = opencodeLoadFailure(log, dir)
      if (failure) return { ok: false, detail: failure.slice(0, 200) }
      return { ok: true, detail: `loaded from ${dir}` }
    },
  }
}

const RUNTIMES = new Set<string>(["claude", "opencode"])

/** Throws when a value is not a valid spec; returns it typed. */
export function validateSpec(value: unknown, plugin?: string): Spec {
  if (!value || typeof value !== "object") throw new Error("spec must be an object")
  const spec = value as Partial<Spec>
  if (typeof spec.plugin !== "string" || !spec.plugin) throw new Error("spec.plugin must be a non-empty string")
  if (plugin && spec.plugin !== plugin) throw new Error(`spec.plugin is "${spec.plugin}", expected "${plugin}"`)
  if (!Array.isArray(spec.runtimes) || spec.runtimes.length === 0) throw new Error("spec.runtimes must be a non-empty array")
  for (const runtime of spec.runtimes) if (!RUNTIMES.has(runtime)) throw new Error(`unknown runtime "${String(runtime)}"`)
  if (new Set(spec.runtimes).size !== spec.runtimes.length) throw new Error("spec.runtimes has duplicates")
  if (typeof spec.prompt !== "string" || !spec.prompt.trim()) throw new Error("spec.prompt must be a non-empty string")
  if (spec.env !== undefined) {
    if (!spec.env || typeof spec.env !== "object" || Array.isArray(spec.env)) throw new Error("spec.env must be an object of strings")
    for (const [key, value] of Object.entries(spec.env)) if (typeof value !== "string") throw new Error(`spec.env.${key} must be a string`)
  }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) throw new Error("spec.checks must be a non-empty array")
  for (const check of spec.checks) {
    if (!check || typeof check.name !== "string" || !check.name) throw new Error("every check needs a name")
    if (typeof check.run !== "function") throw new Error(`check "${check.name}" has no run function`)
  }
  if (spec.setup !== undefined && typeof spec.setup !== "function") throw new Error("spec.setup must be a function")
  return spec as Spec
}

/** Imports `packages/<plugin>/e2e/spec.ts` from a repo copy and validates it. */
export async function loadSpec(repo: string, plugin: string): Promise<Spec> {
  const file = join(repo, "packages", plugin, "e2e", "spec.ts")
  let mod: { default?: unknown }
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown }
  } catch (err) {
    throw new Error(`cannot load spec ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return validateSpec(mod.default, plugin)
  } catch (err) {
    throw new Error(`invalid spec ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
