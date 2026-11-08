// opencode v2 entry: the same cross-model review as the v1 plugin (auto-review.ts), triggered by the
// `session.execution.*` events 2.0.29 emits in place of `session.idle`. The review session is created
// through `ctx.session.create` with the review model, then prompted with the same review prompt.
//
// Not ported (see README): the abort cooldown/race delay keyed off `session.error`, because v2 reports
// turn outcomes as execution events and the v1 cooldown only guarded the idle/abort race.
import {
  type ModelSpec,
  buildReviewPrompt,
  countToolCallsAfterIndex,
  debug,
  extractText,
  findLastAssistantAfterIndex,
  findLastRelevantUserBoundaryIndex,
  formatModelSpec,
  getMessageSignature,
  hasReviewMarker,
  inferReviewModels,
  initDebugLogger,
  loadConfig,
  parseModelSpec,
  resolveWorkModel,
  toSessionMessages,
} from "./core"

const TRIGGERS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

/** opencode v2 entry: review a finished turn with a different model. */
export default {
  id: "auto-review",
  async setup(ctx: any) {
    const config = await loadConfig()
    const REVIEW_MODEL = config.model || process.env.AUTO_REVIEW_MODEL || ""
    const REVIEW_REASONING = config.reasoning || process.env.AUTO_REVIEW_REASONING || ""
    const MIN_TOOL_CALLS = config.minToolCalls ?? 3
    const DEBUG_ENABLED = config.debug ?? process.env.AUTO_REVIEW_DEBUG === "1"
    const directory = ctx.location?.directory ?? process.cwd()

    if (DEBUG_ENABLED) initDebugLogger(directory, true)

    const active = new Set<string>()
    const reviewSessionIDs = new Set<string>()
    const reviewedMessageBySession = new Map<string, string>()

    const availableModels = async (): Promise<ModelSpec[]> => {
      const out: ModelSpec[] = []
      try {
        const listed = await ctx.model.list({ location: { directory } })
        for (const model of listed?.data ?? []) {
          if (model?.providerID && model?.modelID) out.push({ providerID: model.providerID, modelID: model.modelID })
        }
      } catch (error) {
        debug("model.list failed, using empty list", error)
      }
      return out
    }

    const runReview = async (parentSessionID: string): Promise<void> => {
      if (active.has(parentSessionID)) return
      active.add(parentSessionID)

      try {
        let sessionInfo: any
        try {
          sessionInfo = await ctx.session.get({ sessionID: parentSessionID })
        } catch (error) {
          debug("session.get failed", parentSessionID, error)
          return
        }
        if (sessionInfo?.parentID) {
          debug("Skipping child session", parentSessionID, sessionInfo.parentID)
          return
        }

        let items: any[] = []
        try {
          items = await ctx.session.context({ sessionID: parentSessionID })
        } catch (error) {
          debug("session.context failed", parentSessionID, error)
          return
        }
        const messages = toSessionMessages(items)
        if (messages.length < 2) return

        const boundaryIndex = findLastRelevantUserBoundaryIndex(messages)
        if (boundaryIndex < 0) {
          debug("Skipping: no relevant user boundary", parentSessionID)
          return
        }
        const lastUser = messages[boundaryIndex]
        const lastAssistant = findLastAssistantAfterIndex(messages, boundaryIndex)
        const lastUserText = lastUser ? extractText(lastUser) : ""
        const lastAssistantText = lastAssistant ? extractText(lastAssistant) : ""

        if (hasReviewMarker(lastUserText) || hasReviewMarker(lastAssistantText)) {
          debug("Skipping likely review loop via marker", parentSessionID)
          return
        }

        const lastUserSig = getMessageSignature(lastUser)
        if (lastUserSig && reviewedMessageBySession.get(parentSessionID) === lastUserSig) {
          debug("Already reviewed message", parentSessionID, lastUserSig)
          return
        }

        const toolCalls = countToolCallsAfterIndex(messages, boundaryIndex)
        if (toolCalls < MIN_TOOL_CALLS) {
          debug("Skipping low-tool turn", parentSessionID, toolCalls)
          return
        }

        const workModel = resolveWorkModel(lastAssistant)
        const reviewModels = REVIEW_MODEL
          ? ([parseModelSpec(REVIEW_MODEL)].filter(Boolean) as ModelSpec[])
          : inferReviewModels(workModel, await availableModels())
        if (reviewModels.length === 0) {
          debug("No review model candidates found", parentSessionID)
          return
        }

        const workModelText = formatModelSpec(workModel) || "unknown"
        const reviewSignature = lastUserSig || getMessageSignature(lastAssistant)
        let reviewCompleted = false

        for (const reviewModel of reviewModels) {
          let reviewSession: any
          try {
            reviewSession = await ctx.session.create({
              parentID: parentSessionID,
              title: "AUTO-REVIEW",
              location: { directory },
              model: { providerID: reviewModel.providerID, id: reviewModel.modelID, ...(REVIEW_REASONING ? { variant: REVIEW_REASONING } : {}) },
            })
          } catch (error) {
            debug("session.create failed, trying fallback", parentSessionID, error)
            continue
          }
          if (!reviewSession?.id) continue
          reviewSessionIDs.add(reviewSession.id)

          try {
            await ctx.session.prompt({
              sessionID: reviewSession.id,
              text: buildReviewPrompt(workModelText, formatModelSpec(reviewModel), toolCalls, lastUserText, lastAssistantText),
            })
            reviewedMessageBySession.set(parentSessionID, reviewSignature)
            debug("Created review session", { parentSessionID, reviewSessionID: reviewSession.id, reviewModel: formatModelSpec(reviewModel), toolCalls })
            reviewCompleted = true
            break
          } catch (error) {
            debug("session.prompt failed, trying fallback", { parentSessionID, reviewModel: formatModelSpec(reviewModel), error })
          }
        }

        if (!reviewCompleted) {
          reviewedMessageBySession.set(parentSessionID, reviewSignature)
          debug("All review model fallbacks failed", { parentSessionID, workModel: workModelText })
        }
      } finally {
        active.delete(parentSessionID)
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!TRIGGERS.has((event as any)?.type)) continue
          const sessionID = (event as any)?.data?.sessionID
          if (typeof sessionID !== "string") continue
          if (reviewSessionIDs.has(sessionID)) {
            debug("Skipping review child execution", sessionID)
            continue
          }
          try {
            await runReview(sessionID)
          } catch (error) {
            debug("runReview failed", sessionID, error)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) debug("event subscription failed", error)
      }
    })()

    return () => controller.abort()
  },
}
