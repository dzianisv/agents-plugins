// opencode v2 reflection engine: the same judge loop as the v1 plugin (reflection-3.ts), driven by
// `ctx.session.context` / `ctx.generate.text` / `ctx.session.prompt` instead of ephemeral sessions,
// `promptAsync` and TUI toasts. The pure helpers live in the v1 module and are imported, not copied.
//
// Not ported (see README): the TUI toasts, the separate judge/cross-review/routing sessions, and the
// task-routed feedback model. `session.idle` is replaced by the `session.execution.*` events.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { countInWindow, mayInject, recordInjection, type Budget } from "../../shared/src/inject-limit"
import { join } from "node:path"
import {
  MAX_ATTEMPTS,
  buildEscalatingFeedback,
  buildSelfAssessmentPrompt,
  buildTaskContext,
  debug,
  detectActionLoop,
  detectPlanningLoop,
  evaluateSelfAssessment,
  extractLastAssistantText,
  getAgentsFile,
  getLastRelevantUserMessageId,
  isBlockedJudgeModel,
  isJudgeSession,
  isPlanMode,
  loadPreferredModelSpec,
  loadReflectionModelList,
  loadReflectionPrompt,
  parseModelSpec,
  parseSelfAssessmentJson,
  resolveReflectionPromptPrecedence,
  saveReflectionData,
  shouldApplyPlanningLoop,
  writeVerdictSignal,
  type ReflectionAnalysis,
} from "../reflection-3"

export { debug, initDebugLogger } from "../reflection-3"

/** Notes a session may receive per window, so reflection cannot drive an endless loop. */
const INJECTION_WINDOW = 3600

/** Mutable per-instance reflection state, the v2 counterpart of the v1 closure variables. */
export type ReflectionState = {
  judgeSessionIds: Set<string>
  lastReflectedMsgId: Map<string, string>
  active: Set<string>
  attempts: Map<string, number>
  /** Injection budget: reflection feedback per session per window, so the loop cannot run forever. */
  injections: Budget
  toolReflectionPrompt: string | null
  currentSessionId: string | null
}

/** Fresh state for one plugin instance. */
export const createState = (): ReflectionState => ({
  judgeSessionIds: new Set(),
  lastReflectedMsgId: new Map(),
  active: new Set(),
  attempts: new Map(),
  injections: {},
  toolReflectionPrompt: null,
  currentSessionId: null,
})

/** Convert opencode v2 context entries into the `{ info, parts }` shape the v1 helpers consume. */
export const toMessages = (items: any[]): any[] =>
  (items ?? []).map((m: any) => {
    if (m?.type === "user") {
      return { id: m.id, info: { role: "user", time: { start: m.time?.created } }, parts: [{ type: "text", text: String(m.text ?? "") }] }
    }
    if (m?.type === "assistant") {
      const parts = (m.content ?? []).flatMap((p: any) => {
        if (p?.type === "text") return [{ type: "text", text: p.text }]
        if (p?.type === "tool") return [{ type: "tool", tool: p.name, state: { input: p.state?.input ?? {} } }]
        return []
      })
      return { id: m.id, info: { role: "assistant", time: { start: m.time?.created } }, parts }
    }
    return { id: m?.id, info: { role: m?.type }, parts: [] }
  })

/** The judge model spec list: the reflection.yaml list, else the preferred model, else the runtime default. */
async function reflectionModels(directory: string): Promise<string[]> {
  const list = await loadReflectionModelList()
  if (list.length) return list
  const preferred = await loadPreferredModelSpec(directory)
  if (preferred && !isBlockedJudgeModel(preferred)) return [preferred]
  return [""]
}

const modelRef = (spec: string): { providerID: string; id: string } | null => {
  const parsed = parseModelSpec(spec)
  return parsed ? { providerID: parsed.providerID, id: parsed.modelID } : null
}

/** Run a prompt through the first judge model that answers; returns the text and the model used. */
async function generate(ctx: any, directory: string, prompt: string): Promise<{ text: string; model: string | null } | null> {
  for (const spec of await reflectionModels(directory)) {
    try {
      const model = modelRef(spec)
      const result = await ctx.generate.text(model ? { prompt, model } : { prompt })
      const text = typeof result?.text === "string" ? result.text : ""
      if (text) return { text, model: spec || null }
    } catch (error) {
      debug("generate.text failed:", spec, error)
    }
  }
  return null
}

/** The disabled-session marker file: `.reflection/disabled` holds one session ID per line. */
const disabledFlagPath = (directory: string): string => join(directory, ".reflection", "disabled")

/** True when the user disabled reflection for this session. */
export async function isSessionDisabled(directory: string, sessionId: string): Promise<boolean> {
  try {
    const content = await readFile(disabledFlagPath(directory), "utf8")
    return content.split("\n").map((l) => l.trim()).filter(Boolean).includes(sessionId)
  } catch {
    return false
  }
}

/** Add or remove this session's ID in `.reflection/disabled`. */
export async function setSessionDisabled(directory: string, sessionId: string, disabled: boolean): Promise<void> {
  let lines: string[] = []
  try {
    lines = (await readFile(disabledFlagPath(directory), "utf8")).split("\n").map((l) => l.trim()).filter(Boolean)
  } catch {}
  if (disabled) {
    if (!lines.includes(sessionId)) lines.push(sessionId)
  } else {
    lines = lines.filter((l) => l !== sessionId)
  }
  await mkdir(join(directory, ".reflection"), { recursive: true })
  await writeFile(disabledFlagPath(directory), lines.join("\n") + (lines.length ? "\n" : ""))
}

/** The v2 reflection flow for one finished turn: self-assess, judge, then push feedback when incomplete. */
export async function runReflection(ctx: any, sessionID: string, state: ReflectionState, directory: string): Promise<void> {
  if (state.active.has(sessionID)) return
  state.active.add(sessionID)
  state.currentSessionId = sessionID

  try {
    let items: any[]
    try {
      items = await ctx.session.context({ sessionID })
    } catch {
      debug("Session not found (likely deleted), skipping reflection:", sessionID.slice(0, 8))
      return
    }
    const messages = toMessages(items)
    if (!messages || messages.length < 2) return

    if (isJudgeSession(sessionID, messages, state.judgeSessionIds)) return
    if (isPlanMode(messages)) return

    const lastUserMsgId = getLastRelevantUserMessageId(messages)
    if (!lastUserMsgId) return
    if (state.lastReflectedMsgId.get(sessionID) === lastUserMsgId) return

    const context = await buildTaskContext(messages, directory)
    if (!context) return

    const lastAssistantText = extractLastAssistantText(messages)
    const customPrompt = await loadReflectionPrompt(directory)
    const agents = await getAgentsFile(directory)
    const attemptKey = `${sessionID}:${lastUserMsgId}`
    const currentAttemptCount = state.attempts.get(attemptKey) || 0
    const defaultPrompt = buildSelfAssessmentPrompt(context, agents, lastAssistantText, currentAttemptCount)
    const resolved = resolveReflectionPromptPrecedence(customPrompt, state.toolReflectionPrompt, defaultPrompt)

    debug("Requesting reflection self-assessment (source:", resolved.source, ")")
    const assessment = await generate(ctx, directory, resolved.prompt)
    if (!assessment) {
      state.attempts.delete(attemptKey)
      state.lastReflectedMsgId.set(sessionID, lastUserMsgId)
      return
    }

    let analysis: ReflectionAnalysis | null = null
    const parsed = parseSelfAssessmentJson(assessment.text)
    if (parsed) analysis = evaluateSelfAssessment(parsed, context)
    if (!analysis) {
      debug("Reflection analysis failed")
      state.attempts.delete(attemptKey)
      state.lastReflectedMsgId.set(sessionID, lastUserMsgId)
      return
    }

    await saveReflectionData(directory, sessionID, {
      task: context.taskSummary,
      assessment: assessment.text.slice(0, 4000),
      analysis,
      crossReview: null,
      routing: null,
      timestamp: new Date().toISOString(),
    })
    await writeVerdictSignal(directory, sessionID, analysis.complete, analysis.severity)

    if (analysis.complete) {
      state.attempts.delete(attemptKey)
      state.lastReflectedMsgId.set(sessionID, lastUserMsgId)
      debug("Reflection complete")
      return
    }

    if (analysis.requiresHumanAction && !analysis.shouldContinue) {
      state.attempts.delete(attemptKey)
      state.lastReflectedMsgId.set(sessionID, lastUserMsgId)
      debug("Reflection requires human action")
      return
    }

    const nextAttemptCount = (state.attempts.get(attemptKey) || 0) + 1
    state.attempts.set(attemptKey, nextAttemptCount)
    if (nextAttemptCount >= MAX_ATTEMPTS) {
      state.lastReflectedMsgId.set(sessionID, lastUserMsgId)
      debug("Max attempts reached for", sessionID.slice(0, 8))
      return
    }

    const loopCheck = detectPlanningLoop(messages)
    const usePlanningLoopMessage = shouldApplyPlanningLoop(context.taskType, loopCheck.detected)
    const actionLoopCheck = detectActionLoop(messages)
    const feedbackText = buildEscalatingFeedback(
      nextAttemptCount,
      analysis.severity || "MEDIUM",
      { feedback: analysis.reason || "Task incomplete", missing: analysis.missing, next_actions: analysis.nextActions },
      usePlanningLoopMessage,
      actionLoopCheck.detected,
    )

    const now = Math.floor(Date.now() / 1000)
    if (!mayInject(state.injections, `${sessionID}|`, now, INJECTION_WINDOW, MAX_ATTEMPTS)) {
      state.lastReflectedMsgId.set(sessionID, lastUserMsgId)
      debug("Reflection injection ceiling reached for", sessionID.slice(0, 8))
      return
    }
    state.injections = recordInjection(state.injections, `${sessionID}|${countInWindow(state.injections, `${sessionID}|`, now, INJECTION_WINDOW)}`, now)

    try {
      await ctx.session.prompt({ sessionID, text: feedbackText })
    } catch (error) {
      debug("session.prompt failed (feedback):", error)
      state.lastReflectedMsgId.set(sessionID, lastUserMsgId)
      return
    }

    state.lastReflectedMsgId.set(sessionID, lastUserMsgId)
    debug("Reflection pushed continuation")
  } finally {
    state.active.delete(sessionID)
  }
}
