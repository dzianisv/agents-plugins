// opencode v1 entry: the same reuse check on tool.execute.before.
import type { Plugin } from "@opencode-ai/plugin"
import { decide } from "../core/decide"
import { shellTargets } from "../core/shell"
import { writeTarget } from "../core/write"
import { notify } from "../shared/notify"

const TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch", "Write", "Edit", "MultiEdit"])
const SHELL = new Set(["bash", "shell", "Bash"])

/** opencode v1 plugin: warn or block a write that duplicates an indexed declaration. */
export const CodeIndex: Plugin = async ({ client, directory }) => {
  if (process.env.CODEINDEX === "0") return {}

  return {
    "tool.execute.before": async (input, output) => {
      if (!TOOLS.has(input.tool) && !SHELL.has(input.tool)) return
      const args = (output.args ?? {}) as Record<string, unknown>
      const cwd = directory ?? process.cwd()
      const single = TOOLS.has(input.tool) ? writeTarget(args, cwd) : undefined
      const targets = single
        ? [single]
        : SHELL.has(input.tool) && typeof args.command === "string"
          ? shellTargets(args.command, cwd)
          : []

      for (const target of targets) {
        let decision
        try {
          decision = decide(target, "opencode")
        } catch {
          continue
        }
        if (decision.action === "deny") {
          throw new Error(decision.message ?? "[codeindex] reuse the existing code")
        }
        if (decision.action === "warn") {
          await notify("codeindex", decision.message ?? "reuse check", { level: "warning", client })
        }
      }
    },
  }
}
