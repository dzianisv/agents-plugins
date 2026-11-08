// e2e spec: the v2 entry judges each finished turn on the session.execution.* events, but a cheap
// prompt has no real task to assess and the judge needs a model, so the check only asserts the load
// and the clean exit. It fails when opencode refuses to load the plugin, which is the point: a
// "works" claim means it loads in the runtime under test.
import { defineSpec, opencodeLoadedCheck } from "../../../scripts/e2e/spec"

export default defineSpec({
  plugin: "reflection",
  runtimes: ["opencode"],
  prompt: "Reply with the single word OK.",
  checks: [opencodeLoadedCheck("reflection")],
})
