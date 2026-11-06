// The spec type every plugin e2e test uses, plus loading and validation for the container driver.
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
