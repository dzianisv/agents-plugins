// The rules handed to the judge: the global ~/.agents/AGENTS.md and the project's own AGENTS.md,
// each labelled with its file so a violation can be traced back. SUPERVISOR_RULES overrides both.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Env } from "./state"

/** One rules file and its text. */
export type RulesSource = { path: string; text: string }

/** The files read, in order, for a session running in `cwd`. */
export function rulesPaths(env: Env = process.env, cwd = process.cwd()): string[] {
  if (env.SUPERVISOR_RULES) return [env.SUPERVISOR_RULES]
  return [join(env.HOME ?? homedir(), ".agents", "AGENTS.md"), join(cwd, "AGENTS.md"), join(cwd, ".agents", "AGENTS.md")]
}

/** Every rules file that exists and is non-empty, global first. */
export function readRules(env: Env = process.env, cwd = process.cwd(), exists = existsSync): RulesSource[] {
  const sources: RulesSource[] = []
  const seen = new Set<string>()
  for (const path of rulesPaths(env, cwd)) {
    if (seen.has(path) || !exists(path)) continue
    seen.add(path)
    let text: string
    try {
      text = readFileSync(path, "utf8").trim()
    } catch {
      continue
    }
    if (text) sources.push({ path, text })
  }
  return sources
}

/** The composed rules text, each file under its own header. Empty when no file has rules. */
export function composeRules(sources: RulesSource[]): string {
  return sources.map((source) => `# Rules from ${source.path}\n${source.text}`).join("\n\n")
}
