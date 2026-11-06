// e2e spec: the idle timer is shortened through the spec env so the row lands inside the container
// run; the recap falls back to the session title because the container has no FIREWORKS_API_KEY
// outside opencode's own auth store, which the plugin does not read.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { defineSpec, waitFor } from "../../../scripts/e2e/spec"

export default defineSpec({
  plugin: "session-index",
  runtimes: ["opencode"],
  prompt: "Reply with the single word OK.",
  env: { OPENCODE_SESSION_INDEX_IDLE_MS: "5000" },
  checks: [
    {
      name: "the index holds the session",
      run: async (ctx) => {
        const file = join(ctx.home, ".agents", "sessions.csv")
        const cwd = join(ctx.home, "work")
        const row = await waitFor(() => {
          try {
            return readFileSync(file, "utf8")
              .split("\n")
              .find((line) => line.startsWith("ses_") && line.includes(cwd))
          } catch {
            return undefined
          }
        }, 90_000)
        if (!row) return { ok: false, detail: `no session row for ${cwd} in ${file} within 90s` }
        return { ok: true, detail: row.slice(0, 100) }
      },
    },
  ],
})
