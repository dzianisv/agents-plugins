// e2e spec: the v2 entry reviews a finished turn on the session.execution.* events, but the review
// needs a non-trivial turn (>= 3 tool calls) and a second available model, and the cheap prompt has
// neither, so nothing stronger than the load is asserted. The check fails when opencode refuses to
// load the plugin: "works" for this plugin means it loads in the runtime under test.
import { defineSpec, opencodeLoadedCheck } from "../../../scripts/e2e/spec"

export default defineSpec({
  plugin: "auto-review",
  runtimes: ["opencode"],
  prompt: "Reply with the single word OK.",
  checks: [opencodeLoadedCheck("auto-review")],
})
