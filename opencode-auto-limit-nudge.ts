/**
 * opencode-auto-limit-nudge — OpenCode v2 server plugin.
 *
 * Nudges the USER (via TUI toast) when the currently-used model hits its
 * rate/usage limit and is about to reset. Does NOT nudge the session when
 * the limit resets — the session retries automatically; only the user gets
 * a heads-up so they can plan around the downtime.
 *
 * Fires on the `session.status` "retry" event. The active model is tracked
 * from the `session.next.model.switched` event so the toast names it
 * explicitly (e.g. "deepseek/deepseek-v4.1-flash:free").
 *
 * OpenCode v2 plugin shape: `{ id, setup(ctx) }`. The `setup` function
 * receives a context with `ctx.event.subscribe()` (async iterable of
 * events) and `ctx.tui.ui.toast()` for notifications.
 */

export default {
  id: "opencode-auto-limit-nudge",
  async setup(ctx: any) {
    const lastNudged = new Map<string, number>()
    const sessionModels = new Map<string, { providerID: string; modelID: string }>()

    const showToast = (message: string, variant: "info" | "success" | "warning" | "error" = "warning") => {
      try {
        ctx.tui.ui.toast({ title: "Model Limit", message, variant, duration: 5000 })
      } catch {
        // silent — console output corrupts the OpenCode TUI
      }
    }

    const modelLabel = (providerID?: string, modelID?: string) => {
      if (providerID && modelID) return `${providerID}/${modelID}`
      if (modelID) return modelID
      if (providerID) return providerID
      return "the active model"
    }

    const handler = (event: any) => {
      const type = event?.type
      if (!type) return

      // Track the active model per session.
      if (type === "session.next.model.switched") {
        const sessionId = event?.properties?.sessionID
        const model = event?.properties?.model
        if (sessionId && model?.providerID && model?.modelID) {
          sessionModels.set(sessionId, { providerID: model.providerID, modelID: model.modelID })
        }
        return
      }

      // Only act on session.status "retry" events — these fire when a
      // provider returns a retryable error (HTTP 429, quota exceeded, etc.).
      if (type !== "session.status") return
      const status = event?.properties?.status
      if (!status || status.type !== "retry") return
      const sessionId = event?.properties?.sessionID
      if (!sessionId) return

      // Debounce: don't nudge twice for the same session within 60s.
      const now = Date.now()
      const last = lastNudged.get(sessionId)
      if (last !== undefined && now - last < 60_000) return
      lastNudged.set(sessionId, now)

      const tracked = sessionModels.get(sessionId)
      const label = tracked ? modelLabel(tracked.providerID, tracked.modelID) : "the active model"
      const providerMessage = status.message || "rate limit reached"
      const next = typeof status.next === "number" ? new Date(status.next) : null
      const nextLabel = next && !Number.isNaN(next.getTime())
        ? next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : null

      const parts: string[] = [`${label} hit a limit: ${providerMessage}`]
      if (nextLabel) parts.push(`Expected reset ~${nextLabel}`)
      parts.push("Will retry automatically.")
      showToast(parts.join(" "), "warning")
    }

    // ctx.event.subscribe() returns an async iterable of events.
    // Run it in the background so setup() returns promptly.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe()) handler(event)
      } catch {
        // subscription ended (e.g. server shutdown) — nothing to do
      }
    })()
  },
}