/**
 * opencode-auto-limit-resume — OpenCode v2 server plugin.
 *
 * When a session dies because the model hit a usage/rate limit
 * (AI.Error.QuotaExceeded, "usage limit has been reached", HTTP 429), this
 * plugin waits and then re-prompts the session so the interrupted task keeps
 * going instead of dying on the spot.
 *
 * OpenCode emits `session.execution.failed` with
 * `data.error = { type: "provider.quota", message, response }`. When the
 * provider reports a reset time it is inside `response.body` (`resets_at`,
 * `resets_in_seconds`) or the response headers; otherwise we back off
 * exponentially. A run that succeeds, or a message the user types, clears the
 * pending retry.
 *
 * v2 plugin shape: `{ id, setup(ctx) }`. `ctx.event.subscribe()` returns an
 * async iterable; `ctx.session.prompt({ sessionID, text })` admits a message
 * and resumes the agent loop. `ctx.tui` only exists in the TUI.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const AUTO_RESUME_PREFIX = "[auto-resume]"
const CONFIG_PATH = join(homedir(), ".config", "opencode", "auto-limit-resume.json")
const LEGACY_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode-auto-limit-nudge.json")
const LOG_DIR = join(homedir(), ".cache", "opencode-auto-limit-resume")

const RETRYABLE = /usage limit|rate.?limit|quota|too many requests|\b429\b|overloaded|capacity|try again in|resets? in/i
const PERMANENT = /no longer supports free models|update to the latest|invalid api key|unauthorized|authentication|not found|model not found|insufficient permissions/i

export type AutoLimitResumeConfig = {
  enabled: boolean
  notify: boolean
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  maxWindowMs: number
  settleMs: number
  respectProviderReset: boolean
  toastDurationMs: number
}

const DEFAULTS: AutoLimitResumeConfig = {
  enabled: true,
  notify: true,
  maxAttempts: 40,
  baseDelayMs: 60_000,
  maxDelayMs: 30 * 60_000,
  maxWindowMs: 24 * 3600_000,
  settleMs: 90_000,
  respectProviderReset: true,
  toastDurationMs: 6000,
}

function resolveConfig(raw: Partial<AutoLimitResumeConfig> | undefined): AutoLimitResumeConfig {
  const config = { ...DEFAULTS }
  if (!raw || typeof raw !== "object") return config
  for (const key of Object.keys(DEFAULTS) as (keyof AutoLimitResumeConfig)[]) {
    const value = (raw as any)[key]
    if (typeof value === typeof DEFAULTS[key]) (config as any)[key] = value
  }
  return config
}

/** Parse a reset time (ms epoch) out of a provider error. */
function parseResetAt(error: any, now: number = Date.now()): number | undefined {
  const headers = error?.response?.headers ?? {}
  const body = error?.response?.body
  let parsed: any = undefined
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body)
    } catch {}
  } else if (body && typeof body === "object") {
    parsed = body
  }

  const candidates: number[] = []
  const push = (value: any, unit: "s" | "rel") => {
    const n = typeof value === "string" ? Number(value) : value
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return
    if (unit === "rel") return candidates.push(now + n * 1000)
    // Epoch seconds are ~1e9, epoch milliseconds ~1e12.
    candidates.push(n > 1e11 ? n : n * 1000)
  }

  push(parsed?.error?.resets_at ?? parsed?.resets_at, "s")
  push(parsed?.error?.resets_in_seconds ?? parsed?.resets_in_seconds, "rel")
  push(headers["x-codex-primary-reset-at"] ?? headers["X-Codex-Primary-Reset-At"], "s")
  push(headers["x-codex-primary-reset-after-seconds"] ?? headers["X-Codex-Primary-Reset-After-Seconds"], "rel")
  push(headers["retry-after"] ?? headers["Retry-After"], "rel")

  const message = typeof error?.message === "string" ? error.message : ""
  const inline = /(?:try again|retry|resets?) in (\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)/i.exec(message)
  if (inline) {
    const n = Number(inline[1])
    const unit = inline[2].toLowerCase()[0]
    const seconds = unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n
    candidates.push(now + seconds * 1000)
  }

  // Epoch seconds vs milliseconds: anything below year 33658 is seconds.
  const future = candidates.filter((value) => value > now + 1000)
  if (future.length === 0) return undefined
  return Math.min(...future)
}

type FailureVerdict = {
  retryable: boolean
  reason: string
  message: string
  resetsAt?: number
}

function classifyFailure(error: any, now: number = Date.now()): FailureVerdict {
  const message = typeof error?.message === "string" && error.message ? error.message : "request failed"
  const type = typeof error?.type === "string" ? error.type : ""
  const status = Number(error?.response?.status_code ?? error?.response?.status ?? 0)

  if (PERMANENT.test(message)) return { retryable: false, reason: "permanent", message }
  if (type === "provider.auth" || status === 401 || status === 403) return { retryable: false, reason: "auth", message }

  const retryable =
    type === "provider.quota" ||
    type === "provider.rate_limit" ||
    status === 429 ||
    status === 529 ||
    RETRYABLE.test(message)
  if (!retryable) return { retryable: false, reason: "not-a-limit", message }

  return { retryable: true, reason: "limit", message, resetsAt: parseResetAt(error, now) }
}

type DelayInput = {
  attempt: number
  now: number
  cfg: AutoLimitResumeConfig
  resetsAt?: number
}

/**
 * Delay before the next resume attempt. Returns `undefined` when the provider
 * says the limit resets further out than the retry window, so we do not leave
 * a pointless timer running.
 */
function nextDelayMs({ attempt, now, cfg, resetsAt }: DelayInput): number | undefined {
  if (cfg.respectProviderReset && resetsAt) {
    const untilReset = resetsAt - now
    if (untilReset > cfg.maxWindowMs) return undefined
    return Math.max(5_000, Math.min(untilReset + 5_000, cfg.maxDelayMs))
  }
  const exp = cfg.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.max(1_000, Math.min(exp, cfg.maxDelayMs))
}

function readConfigFile(): Partial<AutoLimitResumeConfig> {
  if (process.env.OPENCODE_AUTO_LIMIT_RESUME_DISABLED === "1") return { enabled: false }
  for (const path of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed && typeof parsed === "object") return parsed
    } catch {}
  }
  return {}
}

function record(entry: Record<string, unknown>) {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
    const file = join(LOG_DIR, "events.jsonl")
    appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch {}
}

type Model = { providerID?: string; modelID?: string }

type SessionState = {
  attempts: number
  firstAt: number
  lastDelayMs?: number
  model?: Model
  settleTimer?: any
  resumeTimer?: any
  lastOutcome?: "running" | "failed" | "ok"
  lastError?: any
  verdict?: FailureVerdict
}

type Registry = {
  owner?: string
  sessions: Map<string, SessionState>
}

const registry: Registry = ((globalThis as any).__autoLimitResume ??= { sessions: new Map<string, SessionState>() })

export default {
  id: "opencode-auto-limit-resume",
  async setup(ctx: any) {
    let cfg = resolveConfig(readConfigFile())
    if (!cfg.enabled) return

    const instance = crypto.randomUUID()
    // opencode can instantiate the same plugin more than once (global + project
    // config). The most recently loaded instance owns the shared registry, so a
    // hot reload takes over without a gap.
    registry.owner = instance

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "warning") => {
      if (!cfg.notify) return
      const ui = ctx?.tui?.ui
      if (!ui?.toast) return
      try {
        ui.toast({ title: "Auto-resume", message, variant, duration: cfg.toastDurationMs })
      } catch {}
    }

    const label = (model?: Model) => {
      if (model?.providerID && model?.modelID) return `${model.providerID}/${model.modelID}`
      return model?.modelID ?? "the model"
    }

    const when = (ms: number) =>
      ms - Date.now() > 20 * 3600_000
        ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

    const clear = (sessionID: string) => {
      const state = registry.sessions.get(sessionID)
      if (!state) return
      if (state.settleTimer) clearTimeout(state.settleTimer)
      if (state.resumeTimer) clearTimeout(state.resumeTimer)
      registry.sessions.delete(sessionID)
    }

    const cancelTimers = (state: SessionState) => {
      if (state.settleTimer) clearTimeout(state.settleTimer)
      if (state.resumeTimer) clearTimeout(state.resumeTimer)
      state.settleTimer = undefined
      state.resumeTimer = undefined
    }

    const resume = async (sessionID: string) => {
      const state = registry.sessions.get(sessionID)
      if (!state) return
      state.resumeTimer = undefined
      if (state.lastOutcome !== "failed") return
      try {
        // Let any in-flight run settle before admitting new input.
        await Promise.race([
          Promise.resolve(ctx.session.wait({ sessionID })).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 60_000)),
        ])
        if (registry.sessions.get(sessionID) !== state) return
        if (state.lastOutcome !== "failed") return
        const text = `${AUTO_RESUME_PREFIX} The previous run stopped because ${label(state.model)} hit a usage limit. Continue the interrupted task from where it stopped. Check the current state first and do not repeat work that is already done.`
        await ctx.session.prompt({ sessionID, text, delivery: "queue", metadata: { autoResume: true } })
        record({ event: "resume", sessionID, attempt: state.attempts, delayMs: state.lastDelayMs })
        toast(`Resumed ${label(state.model)} (attempt ${state.attempts}/${cfg.maxAttempts}).`, "info")
      } catch (error: any) {
        record({ event: "resume-failed", sessionID, attempt: state.attempts, error: String(error?.message ?? error) })
        if (registry.sessions.get(sessionID) !== state) return
        state.resumeTimer = setTimeout(() => void resume(sessionID), cfg.baseDelayMs)
        state.resumeTimer?.unref?.()
      }
    }

    // opencode retries a failed provider call on its own for ~30s. Arming a
    // resume during that window fights its retries, so wait for the session to
    // go quiet first. Any new run pushes the settle check back.
    const settle = (sessionID: string) => {
      const state = registry.sessions.get(sessionID)
      if (!state) return
      state.settleTimer = undefined
      if (state.lastOutcome !== "failed") return
      if (state.resumeTimer) return

      const now = Date.now()
      if (now - state.firstAt > cfg.maxWindowMs) {
        record({ event: "give-up", sessionID, reason: "window", attempts: state.attempts })
        clear(sessionID)
        return
      }

      const verdict = state.verdict ?? classifyFailure(state.lastError)
      state.attempts += 1

      if (state.attempts > cfg.maxAttempts) {
        record({ event: "give-up", sessionID, attempts: state.attempts - 1, message: verdict.message })
        toast(`Gave up resuming ${label(state.model)} after ${state.attempts - 1} attempts: ${verdict.message}`, "error")
        clear(sessionID)
        return
      }

      const delay = nextDelayMs({ attempt: state.attempts, resetsAt: verdict.resetsAt, now, cfg })
      if (delay === undefined) {
        record({ event: "give-up", sessionID, reason: "reset-too-far", resetsAt: verdict.resetsAt, message: verdict.message })
        toast(`${label(state.model)} limit resets ${new Date(verdict.resetsAt!).toLocaleString()}; not scheduling an automatic resume.`, "error")
        clear(sessionID)
        return
      }

      state.lastDelayMs = delay
      state.resumeTimer = setTimeout(() => void resume(sessionID), delay)
      state.resumeTimer?.unref?.()
      record({ event: "armed", sessionID, attempt: state.attempts, delayMs: delay, resetsAt: verdict.resetsAt, message: verdict.message })
      toast(
        `${label(state.model)} hit a limit: ${verdict.message}. Resuming at ${when(now + delay)} (attempt ${state.attempts}/${cfg.maxAttempts}).`,
        "warning",
      )
    }

    const onFailure = (sessionID: string, error: any) => {
      // Re-read the config so tuning does not require a server restart.
      cfg = resolveConfig(readConfigFile())
      if (!cfg.enabled) {
        for (const id of [...registry.sessions.keys()]) clear(id)
        return
      }
      const verdict = classifyFailure(error)
      const existing = registry.sessions.get(sessionID)
      if (!verdict.retryable) {
        record({ event: "skip", sessionID, reason: verdict.reason, message: verdict.message })
        if (existing) clear(sessionID)
        return
      }

      const now = Date.now()
      let state = existing
      if (!state || now - state.firstAt > cfg.maxWindowMs) {
        state = { attempts: 0, firstAt: now }
        registry.sessions.set(sessionID, state)
      }
      if (state.resumeTimer) clearTimeout(state.resumeTimer)
      if (state.settleTimer) clearTimeout(state.settleTimer)
      state.resumeTimer = undefined
      state.lastOutcome = "failed"
      state.lastError = error
      state.verdict = verdict
      state.settleTimer = setTimeout(() => settle(sessionID), cfg.settleMs)
      state.settleTimer?.unref?.()
      record({ event: "failure", sessionID, message: verdict.message, settleMs: cfg.settleMs })
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // Only the newest loaded instance drives the shared registry.
          if (registry.owner !== instance) continue
          const type = event?.type
          const data = event?.data
          if (typeof type !== "string" || !data) continue

          if (type === "session.step.started" && data.model) {
            const state = registry.sessions.get(data.sessionID)
            if (state) state.model = { providerID: data.model.providerID, modelID: data.model.id ?? data.model.modelID }
            continue
          }

          // A run started again (opencode's own retry, our prompt, or the
          // user's): cancel pending timers and wait for the outcome.
          if (type === "session.execution.started") {
            const state = registry.sessions.get(data.sessionID)
            if (state) {
              cancelTimers(state)
              state.lastOutcome = "running"
            }
            continue
          }

          if (type === "session.execution.succeeded") {
            clear(data.sessionID)
            continue
          }

          if (type === "session.execution.failed") {
            onFailure(data.sessionID, data.error)
            continue
          }
        }
      } catch {}
    })()

    return () => {
      controller.abort()
      if (registry.owner !== instance) return
      registry.owner = undefined
      for (const sessionID of [...registry.sessions.keys()]) clear(sessionID)
    }
  },
}
