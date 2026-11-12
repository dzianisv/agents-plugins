#!/usr/bin/env bun
// PreToolUse hook: deny a configured shell command that breaks a rule in AGENTS.md.
import { readFileSync } from "node:fs"
import { needsPolicy, readCommands } from "../core/commands"
import { cliJudge } from "../core/judge-cli"
import { DEFAULT_MODEL, parsePolicyVerdict, policyPrompt } from "../core/prompt"
import { composeRules, readRules } from "../core/rules"
import { parseHookInput } from "../core/state"
import { notify } from "../shared/notify"

/** Prefix of the deny reason, so a blocked call is recognisably ours. */
export const DENY_PREFIX = "agents-md-guard:"

/** The judge used for a command check; injectable for tests. */
export type Judge = (system: string, transcript: string) => Promise<string>

/** The hook JSON that blocks one call. */
export const denyOutput = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `${DENY_PREFIX} ${reason}`,
  },
})

/** The verdict for one command, or null when no configured pattern matches or the rules are missing. */
export async function checkCommand(
  command: string,
  judge: Judge,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Promise<ReturnType<typeof parsePolicyVerdict>> {
  if (env.AGENTS_MD_GUARD_COMMANDS === "0") return null
  if (!needsPolicy(command, readCommands(env))) return null
  const rules = composeRules(readRules(env, cwd))
  if (!rules) return null
  return parsePolicyVerdict(await judge("", policyPrompt(rules, command)))
}

/** Run the hook: read stdin, check a Bash command, print a deny when it breaks a rule. Never fails the session. */
export async function main(
  input: string,
  judge: Judge = cliJudge({ model: process.env.SUPERVISOR_MODEL || DEFAULT_MODEL, env: process.env }),
): Promise<number> {
  const data = parseHookInput(input)
  const command = (data.tool_input as { command?: unknown } | undefined)?.command
  if (data.tool_name !== "Bash" || typeof command !== "string") return 0
  let verdict: ReturnType<typeof parsePolicyVerdict> = null
  try {
    verdict = await checkCommand(command, judge)
  } catch (err) {
    await notify("agents-md-guard", `command review skipped: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
  if (verdict?.decision === "deny") console.log(JSON.stringify(denyOutput(verdict.reason || "the command breaks a rule in AGENTS.md")))
  return 0
}

if (import.meta.main) {
  await main(readFileSync(0, "utf8"))
  process.exit(0)
}
