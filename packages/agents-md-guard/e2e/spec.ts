// e2e spec: a cheap prompt must end with an audit in audits.jsonl that ran the real judge; an audit
// that logged an error is reported as a failure.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defineSpec, waitFor } from "../../../scripts/e2e/spec"

type Entry = { verdict?: string; error?: string; agent?: string }

export default defineSpec({
  plugin: "agents-md-guard",
  runtimes: ["claude", "opencode"],
  prompt: "Reply with the single word OK.",
  setup: (ctx) => {
    const dir = join(ctx.home, ".agents")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "AGENTS.md"), "# Rules\n- Plain english. Tldr, do not write a lot.\n")
  },
  checks: [
    {
      name: "audit logged a verdict",
      run: async (ctx) => {
        const file = join(ctx.home, ".cache", "supervisor", "audits.jsonl")
        const entry = await waitFor(() => {
          try {
            return readFileSync(file, "utf8")
              .split("\n")
              .filter(Boolean)
              .flatMap((line) => {
                try {
                  return [JSON.parse(line) as Entry]
                } catch {
                  return []
                }
              })
              .find((candidate) => candidate.verdict || candidate.error)
          } catch {
            return undefined
          }
        }, 120_000)
        if (!entry) return { ok: false, detail: `no audit entry in ${file} within 120s` }
        if (entry.error) return { ok: false, detail: `audit failed: ${entry.error}` }
        return { ok: true, detail: `verdict ${entry.verdict}` }
      },
    },
  ],
})
