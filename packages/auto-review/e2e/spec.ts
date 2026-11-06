// e2e spec: the review only runs after a non-trivial turn (>= 3 tool calls) and only on the v1
// session.idle event, which opencode 2.0.29 does not emit (see the plugin README), so nothing
// stronger than the load is asserted. The check fails when opencode refuses to load the plugin:
// "works" for this plugin means it loads in the runtime under test.
import { defineSpec, opencodeLoadedCheck } from "../../../scripts/e2e/spec"

export default defineSpec({
  plugin: "auto-review",
  runtimes: ["opencode"],
  prompt: "Reply with the single word OK.",
  checks: [opencodeLoadedCheck("auto-review")],
})
