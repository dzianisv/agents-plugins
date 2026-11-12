// opencode v2 entry: before a write or edit, warn that the index already has the declaration.
import { decide } from "./src/core/decide"
import { shellTargets } from "./src/core/shell"
import { writeTarget } from "./src/core/write"
import { notify } from "./src/shared/notify"

const TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch", "Write", "Edit", "MultiEdit"])
const SHELL = new Set(["bash", "shell", "Bash"])

/** opencode v2 entry: warn or block a write that duplicates an indexed declaration. */
export default {
  id: "codeindex",
  async setup(ctx: any) {
    if (process.env.CODEINDEX === "0") return

    await ctx.tool.hook("execute.before", async (event: any) => {
      const tool = String(event?.tool ?? "")
      if (!TOOLS.has(tool) && !SHELL.has(tool)) return event
      const input = (event?.input ?? event?.args) as Record<string, unknown> | undefined
      if (!input || typeof input !== "object") return event
      const cwd = ctx.location?.directory ?? process.cwd()

      const single = TOOLS.has(tool) ? writeTarget(input, cwd) : undefined
      const targets = single
        ? [single]
        : SHELL.has(tool) && typeof input.command === "string"
          ? shellTargets(input.command, cwd)
          : []

      for (const target of targets) {
        let decision
        try {
          decision = decide(target, "opencode")
        } catch {
          continue
        }
        if (decision.action === "deny") throw new Error(decision.message ?? "[codeindex] reuse the existing code")
        if (decision.action === "warn") await notify("codeindex", decision.message ?? "reuse check", { level: "warning" })
      }
      return event
    })

    return () => {}
  },
}
