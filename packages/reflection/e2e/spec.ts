// e2e spec: the reflection flow needs a real task and the session.idle event, so a cheap prompt can
// only assert the load and the clean exit. The check fails when opencode refuses to load the plugin,
// which is the point: a "works" claim means it loads in the runtime under test.
import { defineSpec, opencodeLoadedCheck } from "../../../scripts/e2e/spec"

export default defineSpec({
  plugin: "reflection",
  runtimes: ["opencode"],
  prompt: "Reply with the single word OK.",
  checks: [opencodeLoadedCheck("reflection")],
})
