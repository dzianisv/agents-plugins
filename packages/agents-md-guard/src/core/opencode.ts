// Plain helpers for the opencode side of the audit: model spec parsing, the judge agent config,
// headless detection and the feedback note attached to a user message. No SDK imports.
import type { Msg } from "./prompt"

/** Name of the hidden judge agent the v1 plugin registers. */
export const JUDGE_AGENT = "supervisor-judge"
/** Prefix of the synthetic feedback part id, so a message never gets the note twice. */
export const FEEDBACK_PART_PREFIX = "prt_supervisor"

const HEADLESS_VALUE_OPTIONS = new Set(["--log-level"])
const INTERACTIVE_RUN_FLAGS = new Set(["--mini", "--interactive", "-i"])

/** Split "provider/model/id" at the first slash; the model id may itself contain slashes. */
export function parseModel(spec: string): { providerID: string; modelID: string } {
  const i = spec.indexOf("/")
  return i < 0 ? { providerID: spec, modelID: spec } : { providerID: spec.slice(0, i), modelID: spec.slice(i + 1) }
}

/** Agent config for the judge: a wildcard deny hides every tool, MCP tools included. */
export function judgeAgent(model: string) {
  return { mode: "subagent", hidden: true, description: "Rule auditor used by the supervisor plugin. Has no tools.", model, permission: { "*": "deny" } }
}

/** True when the host is a headless `opencode run` (it exits at idle, so an audit could never be delivered); SUPERVISOR_AUDIT_RUN=1 forces auditing. */
export function isHeadlessRun(argv: string[], env: Record<string, string | undefined> = {}): boolean {
  if (env.SUPERVISOR_AUDIT_RUN === "1") return false
  const args = argv.slice(2)
  let i = 0
  while (i < args.length && args[i].startsWith("-")) i += HEADLESS_VALUE_OPTIONS.has(args[i]) ? 2 : 1
  if (args[i] !== "run") return false
  return !args.slice(i + 1).some((a) => INTERACTIVE_RUN_FLAGS.has(a))
}

/** True when the message has a text part the user typed, so it is a real turn and not a compaction request or a synthetic note. */
export function isRealUserMessage(msg: Msg): boolean {
  return msg.info.role === "user" && msg.parts.some((p) => p.type === "text" && !p.synthetic)
}

/** Add the feedback note to a user message unless it already carries one. Returns true when it was added. */
export function attachFeedback(msg: Msg, feedback: string): boolean {
  if (msg.parts.some((p) => p.type === "text" && typeof p.id === "string" && p.id.startsWith(FEEDBACK_PART_PREFIX))) return false
  msg.parts.push({
    id: `${FEEDBACK_PART_PREFIX}_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
    messageID: msg.info.id,
    sessionID: msg.info.sessionID,
    type: "text",
    text: `<system-reminder>\n${feedback}\n</system-reminder>`,
    synthetic: true,
  })
  return true
}
