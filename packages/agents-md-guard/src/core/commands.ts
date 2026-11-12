// The shell commands that get a policy check before they run, and the config file that lists them.
// One plain substring per line: a command is checked when it contains any of them. A missing file is
// created with the defaults; an existing file is never overwritten.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_COMMANDS = [
  "git commit",
  "git push",
  "git rebase",
  "git merge",
  "git tag",
  "git reset",
  "git revert",
  "git cherry-pick",
  "gh pr create",
  "gh pr comment",
  "gh pr review",
  "gh pr edit",
  "gh pr merge",
  "gh pr close",
  "gh pr reopen",
  "gh pr ready",
  "gh issue create",
  "gh issue comment",
  "gh issue edit",
  "gh issue close",
  "gh issue reopen",
  "gh release create",
  "gh release edit",
  "gh release delete",
  "kubectl apply",
  "kubectl create",
  "kubectl replace",
  "kubectl patch",
  "kubectl edit",
  "kubectl delete",
  "kubectl scale",
  "kubectl rollout",
  "kubectl set",
  "kubectl exec",
  "kubectl drain",
  "kubectl cordon",
  "kubectl uncordon",
  "kubectl taint",
]

/** Environment variables the command list reads, injectable for tests. */
export type Env = Record<string, string | undefined>

/** The directory holding the command list. */
export const home = (env: Env = process.env): string =>
  (env.AGENTS_MD_GUARD_HOME || join(homedir(), ".agents", "plugins", "agents-md-guard")).replace(/^~(?=\/|$)/, homedir())

/** The command list path. */
export const commandsPath = (env: Env = process.env): string => join(home(env), "commands")

/** One pattern per line; blank lines and `#` comments are ignored. */
export function parseCommands(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
}

/** The configured patterns, created from the defaults on first use. */
export function readCommands(env: Env = process.env): string[] {
  const path = commandsPath(env)
  try {
    return parseCommands(readFileSync(path, "utf8"))
  } catch {
    try {
      mkdirSync(home(env), { recursive: true })
      writeFileSync(path, `${DEFAULT_COMMANDS.join("\n")}\n`, { flag: "wx", mode: 0o644 })
    } catch {}
    return DEFAULT_COMMANDS
  }
}

/** Whitespace collapse so a tab or a double space still matches a pattern. */
export const normalize = (command: string): string => command.replace(/\s+/g, " ").trim()

/** True when the command contains one of the patterns; patterns are data, not regexes. */
export function needsPolicy(command: unknown, patterns: string[]): boolean {
  if (typeof command !== "string" || !command.trim()) return false
  const text = normalize(command)
  return patterns.some((pattern) => pattern && text.includes(normalize(pattern)))
}
