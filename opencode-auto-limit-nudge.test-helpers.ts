/**
 * Test helpers for the opencode-auto-limit-nudge plugin.
 *
 * OpenCode's plugin loader treats every named export as a plugin, so
 * opencode-auto-limit-nudge.ts can only have a default export. This file
 * duplicates the pure-logic functions so they can be imported directly by
 * unit tests.
 */

// ==================== TYPES ====================

export interface AutoLimitNudgeConfig {
  enabled?: boolean
  toastDurationMs?: number
  suppressMs?: number
  includeResetHint?: boolean
  includeModel?: boolean
}

// ==================== HELPERS ====================

export function modelLabel(providerID?: string, modelID?: string): string {
  if (providerID && modelID) return `${providerID}/${modelID}`
  if (modelID) return modelID
  if (providerID) return providerID
  return "the active model"
}

export function formatNudgeMessage(
  label: string,
  providerMessage: string,
  next?: number,
  includeResetHint: boolean = true
): string {
  const parts: string[] = []
  parts.push(`${label} hit a limit: ${providerMessage}`)
  if (includeResetHint && next) {
    const d = new Date(next)
    if (!Number.isNaN(d.getTime())) {
      parts.push(`Expected reset ~${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)
    }
  }
  parts.push("Will retry automatically.")
  return parts.join(" ")
}

/**
 * v2 events carry `type` at the top level and `properties` below.
 * A retry status is `session.status` with `properties.status.type === "retry"`.
 */
export function isRetryStatus(event: any): boolean {
  return event?.type === "session.status" && event?.properties?.status?.type === "retry"
}

export function isModelSwitched(event: any): boolean {
  return event?.type === "session.next.model.switched"
}

export function isSuppressed(now: number, last?: number, suppressMs: number = 60_000): boolean {
  return last !== undefined && now - last < suppressMs
}