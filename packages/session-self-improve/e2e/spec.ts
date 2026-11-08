// e2e spec: the prompt carries a standing-rule cue ("from now on"), so the capture path must queue a
// rule record. The Claude Code hooks write under ~/.claude/session-self-improve and the opencode v2
// context hook under ~/.cache/session-self-improve. The once-per-session reminder marker needs real
// work in the session, so only the capture artifact is asserted.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { defineSpec } from "../../../scripts/e2e/spec"

type Cue = { kinds?: string[] }

function queuedRule(dir: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue
    try {
      for (const line of readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)) {
        const cue = JSON.parse(line) as Cue
        if (cue.kinds?.includes("rule")) return `${name}: ${line.slice(0, 80)}`
      }
    } catch {}
  }
  return undefined
}

export default defineSpec({
  plugin: "session-self-improve",
  runtimes: ["claude", "opencode"],
  prompt: "From now on, always reply with the single word OK.",
  checks: [
    {
      name: "the capture hook queued the rule",
      run: (ctx) => {
        const dir =
          ctx.runtime === "claude"
            ? join(ctx.home, ".claude", "session-self-improve", "queue")
            : join(ctx.home, ".cache", "session-self-improve", "queue")
        const found = queuedRule(dir)
        if (!found) return { ok: false, detail: `no rule record in ${dir}` }
        return { ok: true, detail: found }
      },
    },
  ],
})
