/**
 * Test helpers for the opencode-auto-limit-resume plugin.
 *
 * OpenCode's plugin loader treats every named export as a plugin, so
 * opencode-auto-limit-nudge.ts keeps only a default export. This file mirrors
 * the pure-logic functions so unit tests can import them.
 *
 * Keep in sync with opencode-auto-limit-nudge.ts.
 */

export const AUTO_RESUME_PREFIX = "[auto-resume]"

const RETRYABLE = /usage limit|rate.?limit|quota|too many requests|\b429\b|overloaded|capacity|try again in|resets? in/i
const FREE_LIMIT = /free usage limit|free limit|free models? (?:work|usage)/i
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
  fallbackModels: string[]
  switchAfterAttempts: number
  watchdogMs: number
}

export const DEFAULTS: AutoLimitResumeConfig = {
  enabled: true,
  notify: true,
  maxAttempts: 40,
  baseDelayMs: 60_000,
  maxDelayMs: 30 * 60_000,
  maxWindowMs: 24 * 3600_000,
  settleMs: 10_000,
  respectProviderReset: true,
  toastDurationMs: 6000,
  fallbackModels: [],
  switchAfterAttempts: 2,
  watchdogMs: 15_000,
}

export function resolveConfig(raw: Partial<AutoLimitResumeConfig> | undefined): AutoLimitResumeConfig {
  const config = { ...DEFAULTS }
  if (!raw || typeof raw !== "object") return config
  for (const key of Object.keys(DEFAULTS) as (keyof AutoLimitResumeConfig)[]) {
    const value = (raw as any)[key]
    if (key === "fallbackModels") {
      if (Array.isArray(value)) config.fallbackModels = value.filter((entry) => typeof entry === "string" && entry.includes("/"))
      continue
    }
    if (typeof value === typeof DEFAULTS[key]) (config as any)[key] = value
  }
  return config
}

export function parseResetAt(error: any, now: number = Date.now()): number | undefined {
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

  const future = candidates.filter((value) => value > now + 1000)
  if (future.length === 0) return undefined
  return Math.min(...future)
}

export type FailureVerdict = {
  retryable: boolean
  reason: "free-limit" | "limit" | "permanent" | "auth" | "not-a-limit"
  message: string
  resetsAt?: number
}

export function classifyFailure(error: any, now: number = Date.now()): FailureVerdict {
  const message = typeof error?.message === "string" && error.message ? error.message : "request failed"
  const type = typeof error?.type === "string" ? error.type : ""
  const status = Number(error?.response?.status_code ?? error?.response?.status ?? 0)

  if (PERMANENT.test(message)) return { retryable: false, reason: "permanent", message }
  if (type === "provider.auth" || status === 401 || status === 403) return { retryable: false, reason: "auth", message }

  const retryable =
    type === "provider.quota" ||
    type === "provider.rate_limit" ||
    type === "provider.free-limit" ||
    status === 429 ||
    status === 529 ||
    RETRYABLE.test(message)
  if (!retryable) return { retryable: false, reason: "not-a-limit", message }

  const reason = type === "provider.free-limit" || FREE_LIMIT.test(message) ? "free-limit" : "limit"
  return { retryable: true, reason, message, resetsAt: parseResetAt(error, now) }
}

export function nextDelayMs({
  attempt,
  now,
  cfg,
  resetsAt,
}: {
  attempt: number
  now: number
  cfg: AutoLimitResumeConfig
  resetsAt?: number
}): number | undefined {
  if (cfg.respectProviderReset && resetsAt) {
    const untilReset = resetsAt - now
    if (untilReset > cfg.maxWindowMs) return undefined
    return Math.max(5_000, Math.min(untilReset + 5_000, cfg.maxDelayMs))
  }
  const exp = cfg.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.max(1_000, Math.min(exp, cfg.maxDelayMs))
}
