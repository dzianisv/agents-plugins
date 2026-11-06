/**
 * opencode-auto-limit-nudge Plugin for OpenCode
 *
 * Nudges the USER (via TUI toast) when the currently-used model hits its
 * rate/usage limit and is about to reset. Does NOT nudge the session when
 * the limit resets — the session retries automatically; only the user gets
 * a heads-up so they can plan around the downtime.
 *
 * Fires on the `session.status` "retry" event, which OpenCode emits whenever
 * a provider returns a retryable error (HTTP 429, quota exceeded, etc.).
 * The active model is tracked from the `chat.message` hook (which carries
 * the model being used for that turn) so the toast names it explicitly
 * (e.g. "deepseek/deepseek-v4.1-flash:free").
 *
 * Configure in ~/.config/opencode/opencode-auto-limit-nudge.json:
 *   { "enabled": true, "toastDurationMs": 5000 }
 *
 * Or set environment variables:
 *   OPENCODE_AUTO_LIMIT_NUDGE_DISABLED=1  - disable the plugin
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { join } from "path"
import { homedir } from "os"

// ==================== CONFIGURATION ====================

export interface AutoLimitNudgeConfig {
  enabled?: boolean
  toastDurationMs?: number
  suppressMs?: number           // debounce window between nudges (ms)
  includeResetHint?: boolean    // mention when the limit is expected to reset
  includeModel?: boolean        // name the active model in the toast
}

export const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode-auto-limit-nudge.json")

export const DEFAULT_TOAST_DURATION_MS = 5000
export const DEFAULT_SUPPRESS_MS = 60_000  // don't repeat a nudge for the same session within 60s

export async function loadConfig(): Promise<AutoLimitNudgeConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    return {}
  }
}

export async function isEnabled(): Promise<boolean> {
  if (process.env.OPENCODE_AUTO_LIMIT_NUDGE_DISABLED === "1") return false
  const config = await loadConfig()
  return config.enabled !== false
}

// ==================== STATE ====================

// Per-session last-nudge timestamps, so we don't spam the user.
export const lastNudged = new Map<string, number>()

// Per-session active model, tracked from chat.message (providerID/modelID).
export const sessionModels = new Map<string, { providerID?: string; modelID?: string }>()

// ==================== TOAST HELPERS ====================

export async function showToast(
  client: any,
  directory: string,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "warning",
  durationMs: number = DEFAULT_TOAST_DURATION_MS
): Promise<void> {
  try {
    await client.tui.publish({
      query: { directory },
      body: {
        type: "tui.toast.show",
        properties: { title: "Model Limit", message, variant, duration: durationMs },
      },
    })
  } catch {
    // silent — console.error corrupts the OpenCode TUI
  }
}

// ==================== MODEL LABEL ====================

export function modelLabel(providerID?: string, modelID?: string): string {
  if (providerID && modelID) return `${providerID}/${modelID}`
  if (modelID) return modelID
  if (providerID) return providerID
  return "the active model"
}

// ==================== PLUGIN ====================

export const OpenCodeAutoLimitNudgePlugin: Plugin = async ({ client, directory }) => {
  if (!client) {
    return {}
  }

  return {
    // Track the active model per session. The chat.message hook carries
    // the model being used for the current turn.
    "chat.message": async (input: any) => {
      const sessionId = input?.sessionID
      const model = input?.model
      if (sessionId && model && (model.providerID || model.modelID)) {
        sessionModels.set(sessionId, {
          providerID: model.providerID,
          modelID: model.modelID,
        })
      }
    },

    event: async ({ event }: { event: any }) => {
      // Only act on session.status "retry" events — these fire when a
      // provider returns a retryable error (HTTP 429, quota exceeded, etc.).
      if (event?.type !== "session.status") return

      const status = event.properties?.status
      if (!status || status.type !== "retry") return

      const sessionId = event.properties?.sessionID
      if (!sessionId) return

      const enabled = await isEnabled()
      if (!enabled) return

      // Debounce: don't nudge twice for the same session within the window.
      const config = await loadConfig()
      const suppressMs = config.suppressMs ?? DEFAULT_SUPPRESS_MS
      const now = Date.now()
      const last = lastNudged.get(sessionId)
      if (last !== undefined && now - last < suppressMs) return
      lastNudged.set(sessionId, now)

      // Resolve the active model. Prefer the tracked one from chat.message;
      // fall back to "the active model" when unknown.
      const tracked = sessionModels.get(sessionId)
      const label =
        config.includeModel === false
          ? "the active model"
          : tracked
            ? modelLabel(tracked.providerID, tracked.modelID)
            : "the active model"

      // Build a human-friendly message. The retry event carries the
      // provider error message (e.g. "rate_limit_exceeded") and the
      // next-attempt timestamp, which we surface as a hint.
      const providerMessage = status.message || "rate limit reached"
      const next = status.next ? new Date(status.next) : null
      const nextLabel = next && !Number.isNaN(next.getTime())
        ? next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : null

      const parts: string[] = []
      parts.push(`${label} hit a limit: ${providerMessage}`)
      if (config.includeResetHint !== false && nextLabel) {
        parts.push(`Expected reset ~${nextLabel}`)
      }
      parts.push("Will retry automatically.")

      await showToast(client, directory, parts.join(" "), "warning", config.toastDurationMs ?? DEFAULT_TOAST_DURATION_MS)
    },
  }
}

export default OpenCodeAutoLimitNudgePlugin