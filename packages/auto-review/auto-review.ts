import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import {
  ABORT_COOLDOWN,
  ABORT_RACE_DELAY,
  type ModelSpec,
  type SessionInfo,
  type SessionMessage,
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
} from "./core"

const configPromise = loadConfig()

export const AutoReviewPlugin: Plugin = async ({ client, directory }: PluginInput) => {
  const config = await configPromise
  const REVIEW_MODEL = config.model || process.env.AUTO_REVIEW_MODEL || ""
  const REVIEW_REASONING = config.reasoning || process.env.AUTO_REVIEW_REASONING || ""
  const MIN_TOOL_CALLS = config.minToolCalls ?? 3
  const DEBUG_ENABLED = config.debug ?? process.env.AUTO_REVIEW_DEBUG === "1"

  if (DEBUG_ENABLED) initDebugLogger(directory, true)

  const active = new Set<string>()
  const reviewSessionIDs = new Set<string>()
  const recentlyAbortedSessions = new Map<string, number>()
  const reviewedMessageBySession = new Map<string, string>()

  async function runReview(parentSessionID: string): Promise<void> {
    if (active.has(parentSessionID)) return
    active.add(parentSessionID)

    try {
      let sessionInfo: SessionInfo | undefined
      try {
        const { data } = await client.session.get({
          path: { id: parentSessionID },
          query: { directory },
        })
        sessionInfo = data as SessionInfo
      } catch (error) {
        debug("session.get failed", parentSessionID, error)
        return
      }

      if (sessionInfo?.parentID) {
        debug("Skipping child session", parentSessionID, sessionInfo.parentID)
        return
      }

      const sessionDirectory = sessionInfo?.directory || directory
      let messages: SessionMessage[] = []
      try {
        const { data } = await client.session.messages({
          path: { id: parentSessionID },
          query: { directory: sessionDirectory },
        })
        messages = Array.isArray(data) ? (data as SessionMessage[]) : []
      } catch (error) {
        debug("session.messages failed", parentSessionID, error)
        return
      }

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

      // Fetch available models dynamically from the SDK
      let availableModels: ModelSpec[] = []
      try {
        const { data } = await client.config.providers({ query: { directory: sessionDirectory } })
        const providersData = data as { providers?: Array<{ id: string; models: Record<string, { id: string }> }> } | undefined
        if (providersData?.providers) {
          for (const provider of providersData.providers) {
            for (const modelKey of Object.keys(provider.models || {})) {
              const model = provider.models[modelKey]
              if (model?.id) {
                availableModels.push({ providerID: provider.id, modelID: model.id })
              }
            }
          }
        }
      } catch (error) {
        debug("config.providers failed, using empty list", error)
      }

      // If model is configured, use it exclusively (format: "provider/model")
      let reviewModels: ModelSpec[]
      if (REVIEW_MODEL) {
        const forced = parseModelSpec(REVIEW_MODEL)
        reviewModels = forced ? [forced] : []
      } else {
        reviewModels = inferReviewModels(workModel, availableModels)
      }
      if (reviewModels.length === 0) {
        debug("No review model candidates found", parentSessionID)
        return
      }
      const workModelText = formatModelSpec(workModel) || "unknown"
      const reviewSignature = lastUserSig || getMessageSignature(lastAssistant)

      let reviewSession: SessionInfo | undefined
      try {
        const { data } = await client.session.create({
          query: { directory: sessionDirectory },
          body: { parentID: parentSessionID, title: "AUTO-REVIEW" },
        })
        reviewSession = data as SessionInfo
      } catch (error) {
        debug("session.create failed", parentSessionID, error)
        return
      }

      if (!reviewSession?.id) return
      reviewSessionIDs.add(reviewSession.id)

      let reviewCompleted = false
      for (const reviewModel of reviewModels) {
        const reviewPrompt = buildReviewPrompt(workModelText, formatModelSpec(reviewModel), toolCalls, lastUserText, lastAssistantText)
        try {
          await client.session.promptAsync({
            path: { id: reviewSession.id },
            query: { directory: sessionDirectory },
            body: {
              model: reviewModel,
              ...(REVIEW_REASONING ? { variant: REVIEW_REASONING } : {}),
              parts: [{ type: "text", text: reviewPrompt }],
            },
          })
          reviewedMessageBySession.set(parentSessionID, reviewSignature)
          debug("Created review child session", {
            parentSessionID,
            reviewSessionID: reviewSession.id,
            workModel: workModelText,
            reviewModel: formatModelSpec(reviewModel),
            toolCalls,
          })
          reviewCompleted = true
          break
        } catch (error) {
          debug("promptAsync failed, trying fallback", {
            parentSessionID,
            reviewSessionID: reviewSession.id,
            reviewModel: formatModelSpec(reviewModel),
            error,
          })
        }
      }
      if (!reviewCompleted) {
        reviewedMessageBySession.set(parentSessionID, reviewSignature)
        debug("All review model fallbacks failed", {
          parentSessionID,
          reviewSessionID: reviewSession.id,
          workModel: workModelText,
          attemptedModels: reviewModels.map(formatModelSpec),
        })
      }
    } finally {
      active.delete(parentSessionID)
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.error") {
        const sessionID = event.properties?.sessionID
        const errorName = event.properties?.error?.name
        if (sessionID && errorName === "MessageAbortedError") {
          recentlyAbortedSessions.set(sessionID, Date.now())
          debug("Abort cooldown started", sessionID)
        }
        return
      }

      if (event.type !== "session.idle") return
      const sessionID = event.properties?.sessionID
      if (!sessionID) return

      if (reviewSessionIDs.has(sessionID)) {
        debug("Skipping review child idle", sessionID)
        return
      }

      const abortAt = recentlyAbortedSessions.get(sessionID)
      if (abortAt) {
        const elapsed = Date.now() - abortAt
        if (elapsed < ABORT_COOLDOWN) {
          debug("Skipping during abort cooldown", sessionID, elapsed)
          return
        }
        recentlyAbortedSessions.delete(sessionID)
      }

      await new Promise((resolve) => setTimeout(resolve, ABORT_RACE_DELAY))

      const raceAbortAt = recentlyAbortedSessions.get(sessionID)
      if (raceAbortAt) {
        const elapsed = Date.now() - raceAbortAt
        if (elapsed < ABORT_COOLDOWN) {
          debug("Skipping due to abort race", sessionID, elapsed)
          return
        }
        recentlyAbortedSessions.delete(sessionID)
      }

      try {
        await runReview(sessionID)
      } catch (error) {
        debug("runReview failed", sessionID, error)
      }
    },
  }
}

export default { id: "auto-review", server: AutoReviewPlugin }
