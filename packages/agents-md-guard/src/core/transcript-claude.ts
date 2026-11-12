// Claude Code session JSONL -> the common Msg[]: real user prompts, assistant text, and one tool
// part per tool call that carries its clipped result. Imports only node:*.
import { readFileSync } from "node:fs"
import { isRecord, type Msg, type Part, type TextPart, type ToolPart } from "./prompt"

const SKIPPED_USER_PREFIXES = ["<system-reminder>", "<command-", "<local-command", "Caveat:"]

/** One parsed line of the session JSONL. */
export type ClaudeEntry = Record<string, unknown>

/** Parse the transcript JSONL, skipping lines that are not JSON objects. */
export function loadEntries(transcriptPath: string): ClaudeEntry[] {
  const entries: ClaudeEntry[] = []
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (isRecord(entry)) entries.push(entry)
    } catch {}
  }
  return entries
}

/** Join the text of a message content that is either a string or a list of blocks. */
export function blockText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const texts = content.flatMap((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []))
  return texts.join("\n")
}

/** The real prompt text of a user entry, with system-reminder, command and caveat blocks removed. */
export function userPromptText(content: unknown): string {
  const blocks =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []))
        : []
  const kept = blocks.filter((b) => b.trim() && !SKIPPED_USER_PREFIXES.some((prefix) => b.trimStart().startsWith(prefix)))
  return kept.map((b) => b.trim()).join("\n")
}

/** Turn transcript entries into messages: real user prompts, and assistant steps with their tool calls and results. */
export function buildMessages(entries: ClaudeEntry[]): Msg[] {
  const msgs: Msg[] = []
  const tools = new Map<string, ToolPart>()
  let lastApiId: string | null = null
  for (const entry of entries) {
    if (!isRecord(entry) || entry.isSidechain || (entry.type !== "user" && entry.type !== "assistant")) continue
    const message = entry.message
    if (!isRecord(message)) continue
    const content = message.content
    const uuid = typeof entry.uuid === "string" ? entry.uuid : ""
    if (entry.type === "user") {
      if (Array.isArray(content) && content.some((b) => isRecord(b) && b.type === "tool_result")) {
        for (const block of content) {
          if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string" && tools.has(block.tool_use_id)) {
            tools.get(block.tool_use_id)!.output = blockText(block.content)
          }
        }
        continue
      }
      if (entry.isMeta || entry.isCompactSummary) continue
      const text = userPromptText(content)
      if (text) {
        msgs.push({ info: { id: uuid, role: "user" }, parts: [{ type: "text", text }] })
        lastApiId = null
      }
      continue
    }
    const parts: Part[] = []
    if (typeof content === "string") {
      parts.push({ type: "text", text: content })
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue
        if (block.type === "text" && typeof block.text === "string") {
          parts.push({ type: "text", text: block.text } as TextPart)
        } else if (block.type === "tool_use") {
          const part: ToolPart = {
            type: "tool",
            tool: typeof block.name === "string" ? block.name : "",
            input: isRecord(block.input) ? block.input : {},
            output: "",
          }
          parts.push(part)
          if (typeof block.id === "string") tools.set(block.id, part)
        }
      }
    }
    const apiId = typeof message.id === "string" ? message.id : null
    if (apiId && apiId === lastApiId && msgs.length && msgs[msgs.length - 1].info.role === "assistant") {
      msgs[msgs.length - 1].parts.push(...parts)
      msgs[msgs.length - 1].info.id = uuid
    } else {
      msgs.push({ info: { id: uuid, role: "assistant" }, parts })
      lastApiId = apiId
    }
  }
  return msgs
}

/** Uuid of the newest user or assistant entry, or an empty string. */
export function lastEntryUuid(entries: ClaudeEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (isRecord(entry) && !entry.isSidechain && (entry.type === "user" || entry.type === "assistant") && typeof entry.uuid === "string" && entry.uuid) {
      return entry.uuid
    }
  }
  return ""
}
