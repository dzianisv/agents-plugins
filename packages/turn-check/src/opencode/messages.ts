// Translate opencode v1 session messages into the common Msg shape the core consumes.
import type { Msg, Part } from "../core/prompt"

/** Convert one opencode v1 session message into the common Msg shape used by the core. */
export function toMsg(message: { info: { id: string; role: string }; parts: any[] }): Msg {
  const parts: Part[] = []
  for (const part of message.parts ?? []) {
    if (part?.type === "tool") {
      parts.push({
        type: "tool",
        tool: String(part.tool ?? ""),
        input: part.state?.input ?? {},
        output: typeof part.state?.output === "string" ? part.state.output : "",
      })
    } else if (part?.type === "text") {
      parts.push({ type: "text", text: typeof part.text === "string" ? part.text : "", synthetic: part.synthetic, ignored: part.ignored })
    }
  }
  return { info: { id: message.info.id, role: message.info.role }, parts }
}
