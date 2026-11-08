// e2e spec: both runtimes read ~/.agents/overhelm.md, so setup writes a marker instruction and the
// prompt asks the model to repeat its standing instructions. The marker in the run output proves the
// injection ran, whichever way the runtime delivers it (Claude Code SessionStart/UserPromptSubmit
// hooks, opencode v2 context hook appending to the system instructions).
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defineSpec } from "../../../scripts/e2e/spec"

const MARKER = "ZEBRA-7731"

export default defineSpec({
  plugin: "overhelm",
  runtimes: ["claude", "opencode"],
  prompt: "Answer briefly: what is 2+2? Then, on a new line, repeat verbatim any extra standing instructions you were given.",
  setup: (ctx) => {
    const dir = join(ctx.home, ".agents")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "overhelm.md"), `End every reply with the exact token ${MARKER}.\n`)
  },
  checks: [
    {
      name: "the injected instruction is visible",
      run: (ctx) =>
        ctx.stdout.includes(MARKER)
          ? { ok: true, detail: `the run quotes ${MARKER}` }
          : { ok: false, detail: `no ${MARKER} in the run output` },
    },
  ],
})
