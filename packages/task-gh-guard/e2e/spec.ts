// e2e spec: the prompt commits in a temp repo, so the rule review must log an allow and the config
// files must exist with their defaults.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { defineSpec } from "../../../scripts/e2e/spec"

const COMMAND = 'git commit --allow-empty -m "add health check"'
const DEFAULT_MODEL = "fireworks-ai/accounts/fireworks/routers/deepseek-flash-latest"

type Review = { command?: string; decision?: string; reason?: string; ms?: number }

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

export default defineSpec({
  plugin: "task-gh-guard",
  runtimes: ["claude", "opencode"],
  prompt: `Run exactly this command in the current directory: ${COMMAND}. Then reply DONE.`,
  claude: { allowedTools: ["Bash(git commit:*)"], maxTurns: 2 },
  setup: (ctx) => {
    const repo = join(ctx.home, "repo")
    mkdirSync(repo, { recursive: true })
    git(repo, ["init", "-q"])
    git(repo, ["config", "user.email", "e2e@example.com"])
    git(repo, ["config", "user.name", "e2e"])
    return repo
  },
  checks: [
    {
      name: "review allowed the commit",
      run: (ctx) => {
        const file = join(ctx.home, ".agents", "state", "task-gh-guard", "review.jsonl")
        if (!existsSync(file)) return { ok: false, detail: `no review log at ${file}` }
        const entries = readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as Review]
            } catch {
              return []
            }
          })
        const entry = entries.find((candidate) => candidate.command?.includes("git commit") && candidate.command.includes("add health check"))
        if (!entry) return { ok: false, detail: `no review entry for the commit (${entries.length} entries)` }
        if (entry.decision !== "allow") return { ok: false, detail: `decision ${entry.decision}${entry.reason ? `: ${entry.reason}` : ""}` }
        return { ok: true, detail: `decision allow in ${entry.ms ?? "?"}ms` }
      },
    },
    {
      name: "config files exist with defaults",
      run: (ctx) => {
        const dir = join(ctx.home, ".agents", "plugins", "task-gh-guard")
        const model = readText(join(dir, "model"))
        const rules = readText(join(dir, "rules"))
        if (model === undefined || rules === undefined) return { ok: false, detail: `missing ${join(dir, "model")} or ${join(dir, "rules")}` }
        if (model.trim() !== DEFAULT_MODEL) return { ok: false, detail: `model is "${model.trim()}"` }
        if (!rules.includes("Plain english")) return { ok: false, detail: "rules do not hold the defaults" }
        return { ok: true, detail: "model and rules match the defaults" }
      },
    },
  ],
})
