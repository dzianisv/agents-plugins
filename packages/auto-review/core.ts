// Pure, client-independent logic shared by the auto-review v1 plugin (auto-review.ts) and the
// opencode v2 server entry (server.ts): config, model selection, message scanning and prompt building.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

// Config file: ~/.config/opencode/plugin/auto-review.json
// {
//   "model": "github-copilot/gpt-5.5",
//   "reasoning": "xhigh",
//   "minToolCalls": 3,
//   "debug": true
// }
export type AutoReviewConfig = {
  model?: string
  reasoning?: string
  minToolCalls?: number
  debug?: boolean
}

export async function loadConfig(): Promise<AutoReviewConfig> {
  const configPath = join(homedir(), ".config", "opencode", "plugin", "auto-review.json")
  try {
    const raw = await readFile(configPath, "utf-8")
    return JSON.parse(raw) as AutoReviewConfig
  } catch {
    return {}
  }
}

export const ABORT_COOLDOWN = 10_000
export const ABORT_RACE_DELAY = 1_500

export const REVIEW_MARKERS = [
  "AUTO-REVIEW",
  "AUTO REVIEW",
  "REVIEW AUTO-REVIEW",
  "Review another model's work",
  "You are reviewing another session",
]
export const SELF_ASSESSMENT_MARKER = "SELF-ASSESS REFLECTION-3"
export const FEEDBACK_MARKER = "REFLECTION FEEDBACK"

export type SessionInfo = {
  id?: string
  parentID?: string
  directory?: string
}

export type SessionPart = {
  type?: string
  text?: string
  tool?: string
  state?: {
    input?: Record<string, unknown>
  }
}

export type SessionMessage = {
  id?: string
  info?: {
    role?: string
    providerID?: string
    modelID?: string
    model?: string | { providerID?: string; modelID?: string }
    time?: {
      start?: number
    }
  }
  parts?: SessionPart[]
}

export type ModelSpec = {
  providerID: string
  modelID: string
}

export let debug: (...args: unknown[]) => void = () => {}

export function initDebugLogger(directory: string, enabled: boolean): void {
  if (!enabled) return
  const logDir = join(directory, ".reflection")
  const logPath = join(logDir, "debug.log")
  let dirReady = false

  debug = (...args: unknown[]) => {
    const msg = args
      .map((arg) => {
        if (typeof arg === "string") return arg
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      })
      .join(" ")
    const line = `[${new Date().toISOString()}] [AutoReview] ${msg}\n`
    ;(async () => {
      if (!dirReady) {
        try {
          await mkdir(logDir, { recursive: true })
        } catch {}
        dirReady = true
      }
      try {
        await appendFile(logPath, line)
      } catch {}
    })()
  }
}

export function parseModelSpec(spec: string | null | undefined): ModelSpec | null {
  if (typeof spec !== "string") return null
  const trimmed = spec.trim()
  if (!trimmed) return null
  const parts = trimmed.split("/")
  if (parts.length < 2) return null
  const providerID = parts[0] || ""
  const modelID = parts.slice(1).join("/") || ""
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

export function formatModelSpec(model: ModelSpec | null): string {
  if (!model) return ""
  return `${model.providerID}/${model.modelID}`
}

export function resolveWorkModel(lastAssistant: SessionMessage | undefined): ModelSpec | null {
  if (!lastAssistant?.info) return null
  const directProvider = lastAssistant.info.providerID
  const directModel = lastAssistant.info.modelID
  if (typeof directProvider === "string" && typeof directModel === "string" && directProvider && directModel) {
    return { providerID: directProvider, modelID: directModel }
  }

  if (typeof lastAssistant.info.model === "string") {
    return parseModelSpec(lastAssistant.info.model)
  }

  if (lastAssistant.info.model && typeof lastAssistant.info.model === "object") {
    const providerID = lastAssistant.info.model.providerID
    const modelID = lastAssistant.info.model.modelID
    if (providerID && modelID) return { providerID, modelID }
  }

  return null
}

export function inferReviewModels(workModel: ModelSpec | null, availableModels: ModelSpec[]): ModelSpec[] {
  const workSpec = formatModelSpec(workModel).toLowerCase()

  // Prefer a different model family for cross-review
  const isClaude = (m: ModelSpec) => m.modelID.toLowerCase().includes("claude")
  const isGpt = (m: ModelSpec) => m.modelID.toLowerCase().includes("gpt") || m.modelID.toLowerCase().includes("codex")
  const isGemini = (m: ModelSpec) => m.modelID.toLowerCase().includes("gemini")

  // Sort candidates: prefer different family, then by capability (opus > sonnet > others)
  const candidates = availableModels
    .filter((m) => formatModelSpec(m).toLowerCase() !== workSpec)
    .filter((m) => !m.modelID.toLowerCase().includes("haiku") && !m.modelID.toLowerCase().includes("flash"))

  const differentFamily = candidates.filter((m) => {
    if (workModel && isClaude(workModel)) return !isClaude(m)
    if (workModel && isGpt(workModel)) return !isGpt(m)
    if (workModel && isGemini(workModel)) return !isGemini(m)
    return true
  })

  const sameFamily = candidates.filter((m) => !differentFamily.includes(m))

  // Prefer opus/strong models first
  const rank = (m: ModelSpec) => {
    const id = m.modelID.toLowerCase()
    if (id.includes("opus")) return 0
    if (id.includes("codex")) return 1
    if (id.includes("sonnet")) return 2
    if (id.includes("pro")) return 3
    return 4
  }

  differentFamily.sort((a, b) => rank(a) - rank(b))
  sameFamily.sort((a, b) => rank(a) - rank(b))

  return [...differentFamily, ...sameFamily]
}

export function extractText(msg: SessionMessage): string {
  const texts = (msg.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text || "")
  return texts.join("\n").trim()
}

export function hasReviewMarker(text: string): boolean {
  const normalized = text.toLowerCase()
  return REVIEW_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()))
}

export function countToolCalls(messages: SessionMessage[]): number {
  let toolCalls = 0
  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue
    for (const part of msg.parts || []) {
      if (part.type === "tool") toolCalls++
    }
  }
  return toolCalls
}

export function isRelevantUserBoundary(msg: SessionMessage): boolean {
  if (msg.info?.role !== "user") return false
  const text = extractText(msg)
  if (!text) return false
  if (hasReviewMarker(text)) return false
  if (text.includes(SELF_ASSESSMENT_MARKER) || text.includes(FEEDBACK_MARKER)) return false
  return true
}

export function findLastRelevantUserBoundaryIndex(messages: SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRelevantUserBoundary(messages[i])) return i
  }
  return -1
}

export function findLastAssistantAfterIndex(messages: SessionMessage[], boundaryIndex: number): SessionMessage | undefined {
  for (let i = messages.length - 1; i > boundaryIndex; i--) {
    if (messages[i]?.info?.role === "assistant") return messages[i]
  }
  return undefined
}

export function countToolCallsAfterIndex(messages: SessionMessage[], boundaryIndex: number): number {
  return countToolCalls(messages.slice(boundaryIndex + 1))
}

export function getMessageSignature(msg: SessionMessage | undefined): string {
  if (!msg) return ""
  if (msg.id) return msg.id
  const role = msg.info?.role || "unknown"
  const time = msg.info?.time?.start || 0
  return `${role}:${time}:${extractText(msg).slice(0, 40)}`
}

/** The structured cross-model review prompt the v1 plugin sent and the v2 entry sends unchanged. */
export function buildReviewPrompt(
  workModelText: string,
  reviewModelText: string,
  toolCalls: number,
  lastUserText: string,
  lastAssistantText: string,
): string {
  return `AUTO-REVIEW

You are reviewing another model's just-completed task turn.
Validate completion quality and workflow gates, then report concrete risks only.

Rules:
- Scope review to work after the last relevant user message.
- Do not repeat the task.
- Focus on correctness, verification evidence, and missed edge cases.

Observed model: ${workModelText}
Review model: ${reviewModelText}
Tool calls in scoped turn: ${toolCalls}

Last relevant user message:
${lastUserText.slice(0, 2000) || "(none)"}

Last assistant message in scoped turn:
${lastAssistantText.slice(0, 3000) || "(none)"}

Checklist to validate:
- task completion
- tests run/pass
- PR exists if code changes were made
- CI passed if applicable
- obvious issues / bugs / missed edge cases

Return:
1) Checklist with PASS/FAIL/UNKNOWN and brief evidence
2) Issues (only real gaps)
3) Final line exactly one of:
   - Review passed — no issues found.
   - Review failed — <brief reason>.`
}

/** Convert opencode v2 context entries into the SessionMessage shape the helpers above consume. */
export function toSessionMessages(items: any[]): SessionMessage[] {
  const out: SessionMessage[] = []
  for (const m of items ?? []) {
    if (m?.type === "user" && typeof m.text === "string") {
      out.push({ id: m.id, info: { role: "user", time: { start: m.time?.created } }, parts: [{ type: "text", text: m.text }] })
    } else if (m?.type === "assistant") {
      const parts: SessionPart[] = (m.content ?? []).flatMap((p: any) => {
        if (p?.type === "text") return [{ type: "text", text: p.text }]
        if (p?.type === "tool") return [{ type: "tool", tool: p.name, state: { input: p.state?.input ?? {} } }]
        return []
      })
      out.push({
        id: m.id,
        info: { role: "assistant", providerID: m.model?.providerID, modelID: m.model?.id, time: { start: m.time?.created } },
        parts,
      })
    }
  }
  return out
}
