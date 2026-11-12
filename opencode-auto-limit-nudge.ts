/**
 * opencode-auto-limit-resume — OpenCode v2 server plugin.
 *
 * When a session dies because the model hit a usage/rate limit
 * (provider.quota, provider.rate_limit, provider.free-limit, HTTP 429), this
 * plugin continues the session instead of leaving it dead:
 *
 *   free limit  -> switch to the next configured fallback model and resume
 *   quota/429   -> retry the same model, switch after a couple of failures
 *
 * Pending work is persisted, so a plugin reload or a server restart does not
 * lose the resume. A watchdog re-arms it even if a timer was lost.
 *
 * v2 plugin shape: `{ id, setup(ctx) }`. `ctx.event.subscribe()` returns an
 * async iterable; `ctx.session.prompt({ sessionID, text })` admits a message
 * and resumes the agent loop; `ctx.session.switchModel({ sessionID, model })`
 * changes the model used by the next run.
 */

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const AUTO_RESUME_PREFIX = "[auto-resume]"

const RETRYABLE = /usage limit|rate.?limit|quota|too many requests|\b429\b|overloaded|capacity|try again in|resets? in/i
const FREE_LIMIT =
  /free usage limit|free limit|free models? (?:work|usage)|exceeded your (?:current )?quota|quota exceeded|out of (?:free )?credits|insufficient_quota/i
const PERMANENT = /no longer supports free models|update to the latest|invalid api key|unauthorized|authentication|not found|model not found|insufficient permissions/i

type AutoLimitResumeConfig = {
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
  injectWindowMs: number
  injectPerWindow: number
  /**
   * Minimum gap between two `[auto-resume]` prompts for the SAME model in one
   * session. A limit episode retries every few minutes; nudging on every retry
   * flooded the session (19 identical prompts on 2026-11-10). One nudge per
   * cooldown still resumes as soon as the quota is plausibly back.
   */
  rePromptMs: number
}

const DEFAULTS: AutoLimitResumeConfig = {
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
  injectWindowMs: 3600_000,
  injectPerWindow: 3,
  rePromptMs: 30 * 60_000,
}

function resolveConfig(raw: Partial<AutoLimitResumeConfig> | undefined): AutoLimitResumeConfig {
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

const cacheDir = () => process.env.OPENCODE_AUTO_LIMIT_RESUME_DIR || join(homedir(), ".cache", "opencode-auto-limit-resume")
const logFile = () => join(cacheDir(), "events.jsonl")
const stateFile = () => join(cacheDir(), "state.json")
const configFile = () =>
  process.env.OPENCODE_AUTO_LIMIT_RESUME_CONFIG ||
  join(homedir(), ".config", "opencode", "auto-limit-resume.json")
const legacyConfigFile = () => join(homedir(), ".config", "opencode", "opencode-auto-limit-nudge.json")

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

  const future = candidates.filter((value) => value > now + 1000)
  if (future.length === 0) return undefined
  return Math.min(...future)
}

type FailureVerdict = {
  retryable: boolean
  reason: "free-limit" | "limit" | "permanent" | "auth" | "not-a-limit"
  message: string
  resetsAt?: number
  /** True when the whole plan/account is limited (weekly, monthly, subscription). */
  planWide: boolean
}

/** A plan-wide limit is not per-model: switching model on the same provider cannot help. */
const PLAN_WIDE = /weekly|monthly|daily limit|plan|subscription|extra usage|go-limit|billing/i

function classifyFailure(error: any, now: number = Date.now()): FailureVerdict {
  const message = typeof error?.message === "string" && error.message ? error.message : "request failed"
  const type = typeof error?.type === "string" ? error.type : ""
  const status = Number(error?.response?.status_code ?? error?.response?.status ?? 0)
  const planWide = PLAN_WIDE.test(message) || /-limit$/.test(type)

  if (PERMANENT.test(message)) return { retryable: false, reason: "permanent", message, planWide: false }
  if (type === "provider.auth" || status === 401 || status === 403) return { retryable: false, reason: "auth", message, planWide: false }

  const retryable =
    type === "provider.quota" ||
    type === "provider.rate_limit" ||
    type === "provider.free-limit" ||
    /-limit$/.test(type) ||
    status === 429 ||
    status === 529 ||
    RETRYABLE.test(message)
  if (!retryable) return { retryable: false, reason: "not-a-limit", message, planWide: false }

  const reason = type === "provider.free-limit" || FREE_LIMIT.test(message) ? "free-limit" : "limit"
  return { retryable: true, reason, message, resetsAt: parseResetAt(error, now), planWide }
}

type DelayInput = {
  attempt: number
  now: number
  cfg: AutoLimitResumeConfig
  resetsAt?: number
}

/**
 * Delay before the next retry of the same model. Returns `undefined` when the
 * provider says the limit resets further out than the retry window, so we do
 * not leave a pointless timer running.
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
  for (const path of [configFile(), legacyConfigFile()]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed && typeof parsed === "object") return parsed
    } catch {}
  }
  return {}
}

function record(entry: Record<string, unknown>) {
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 })
    const file = logFile()
    appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch {}
}

type Model = { providerID?: string; modelID?: string }

type Pending = {
  sessionID: string
  firstAt: number
  failures: number
  attempts: number
  nextAt: number
  lastFailureAt: number
  failedProviderID?: string
  failedModelID?: string
  switchedTo?: string
  reason: string
  message: string
  planWide?: boolean
  tried?: string[]
  /**
   * Model that already received an `[auto-resume]` prompt in this episode.
   * A continuation is delivered once per model per episode: re-prompting the
   * same model that is still limited only repeats the message (19 identical
   * prompts on 2026-11-10). Cleared when the user prompts the session.
   */
  promptedModel?: string
  /** When the last `[auto-resume]` prompt went out for `promptedModel`. */
  lastPromptAt?: number
  /** Provider-declared reset time for the current limit, if it gave one. */
  resetsAt?: number
  /** Stall toast already shown for this episode. */
  notifiedStall?: boolean
}

/** One recorded injection, keyed `sessionID|n` (see package rule: injection ceiling). */
type State = { version: 1; sessions: Record<string, Pending>; injected?: Record<string, { at: number }> }

function readState(): State {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8"))
    if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") return parsed
  } catch {}
  return { version: 1, sessions: {} }
}

/**
 * Injections for this session inside the window. Counts every key sharing the
 * session prefix, so a new attempt key cannot re-arm the ceiling.
 */
function injectionsInWindow(state: State, sessionID: string, now: number, windowMs: number): number {
  if (windowMs <= 0) return 0
  let count = 0
  for (const [key, value] of Object.entries(state.injected ?? {})) {
    if (!key.startsWith(`${sessionID}|`)) continue
    if (typeof value?.at === "number" && now - value.at < windowMs) count++
  }
  return count
}

function writeState(state: State) {
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 })
    const file = stateFile()
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  } catch {}
}

const parseModel = (value: string): { providerID: string; id: string } | undefined => {
  const at = value.indexOf("/")
  if (at <= 0 || at === value.length - 1) return undefined
  return { providerID: value.slice(0, at), id: value.slice(at + 1) }
}

const modelKey = (model?: { providerID?: string; id?: string; modelID?: string }) => {
  if (!model?.providerID) return undefined
  const id = model.id ?? model.modelID
  if (!id) return undefined
  return `${model.providerID}/${id}`
}

type Registry = {
  owner?: string
  instances: Set<string>
  state: State
}

const registry: Registry = ((globalThis as any).__autoLimitResume ??= {
  state: { version: 1, sessions: {} },
  instances: new Set<string>(),
})
if (!registry.instances) registry.instances = new Set<string>()

export default {
  id: "opencode-auto-limit-resume",
  async setup(ctx: any) {
    let cfg = resolveConfig(readConfigFile())
    if (!cfg.enabled) return

    const instance = crypto.randomUUID()
    // opencode can instantiate the same plugin more than once (global + project
    // config). The most recently loaded instance owns the shared registry and
    // the watchdog; ownership is handed back when it unloads.
    registry.instances.add(instance)
    registry.owner = instance
    registry.state = readState()

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "warning") => {
      if (!cfg.notify) return
      const ui = ctx?.tui?.ui
      if (!ui?.toast) return
      try {
        ui.toast({ title: "Auto-resume", message, variant, duration: cfg.toastDurationMs })
      } catch {}
    }

    const label = (pending?: Pending, model?: Model) => {
      if (pending?.switchedTo) return pending.switchedTo
      if (pending?.failedProviderID && pending?.failedModelID) return `${pending.failedProviderID}/${pending.failedModelID}`
      if (model?.providerID && model?.modelID) return `${model.providerID}/${model.modelID}`
      return model?.modelID ?? "the model"
    }

    const persist = () => {
      // Keep the injection budget small: drop records older than the longest
      // window we honour.
      const cutoff = Date.now() - Math.max(cfg.injectWindowMs, 24 * 3600_000)
      const injected = registry.state.injected
      if (injected) {
        for (const [key, value] of Object.entries(injected)) {
          if (typeof value?.at !== "number" || value.at < cutoff) delete injected[key]
        }
        if (Object.keys(injected).length === 0) delete registry.state.injected
      }
      writeState(registry.state)
    }

    // Cross-process guard: one exclusive lock file per session, so two server
    // processes cannot both prompt the same session. Stale locks expire so a
    // crashed process cannot block a resume forever.
    const lockPath = (sessionID: string) =>
      join(cacheDir(), `claim-${sessionID.replace(/[^a-zA-Z0-9_-]/g, "")}.lock`)
    const acquire = (sessionID: string) => {
      try {
        mkdirSync(cacheDir(), { recursive: true, mode: 0o700 })
        writeFileSync(lockPath(sessionID), String(process.pid), { flag: "wx", mode: 0o600 })
        return true
      } catch (error: any) {
        if (error?.code !== "EEXIST") return true
        try {
          if (Date.now() - statSync(lockPath(sessionID)).mtimeMs > 60_000) {
            unlinkSync(lockPath(sessionID))
            writeFileSync(lockPath(sessionID), String(process.pid), { flag: "wx", mode: 0o600 })
            return true
          }
        } catch {}
        return false
      }
    }
    const release = (sessionID: string) => {
      try {
        unlinkSync(lockPath(sessionID))
      } catch {}
    }

    const drop = (sessionID: string, reason: string, extra: Record<string, unknown> = {}) => {
      const pending = registry.state.sessions[sessionID]
      if (!pending) return
      delete registry.state.sessions[sessionID]
      persist()
      record({ event: "clear", sessionID, reason, attempts: pending.attempts, ...extra })
    }

    const arm = (sessionID: string) => {
      const pending = registry.state.sessions[sessionID]
      if (!pending) return
      if (registry.owner !== instance) return
      const delay = Math.max(250, pending.nextAt - Date.now())
      persist()
      const timer = setTimeout(() => void attempt(sessionID, "timer"), delay)
      timer?.unref?.()
      record({ event: "armed", sessionID, at: new Date(pending.nextAt).toISOString(), inMs: delay, attempt: pending.attempts + 1 })
    }

    const hold = (sessionID: string, retryInMs: number, reason: string, extra: Record<string, unknown> = {}) => {
      const pending = registry.state.sessions[sessionID]
      if (!pending) return
      pending.nextAt = Date.now() + retryInMs
      persist()
      record({ event: "hold", sessionID, reason, retryInMs, ...extra })
      arm(sessionID)
    }

    const giveUp = (sessionID: string, reason: string, extra: Record<string, unknown> = {}) => {
      const pending = registry.state.sessions[sessionID]
      if (!pending) return
      record({ event: "give-up", sessionID, reason, attempts: pending.attempts, ...extra })
      toast(`Gave up resuming ${label(pending)}: ${reason}.`, "error")
      drop(sessionID, reason, extra)
    }

    const running = (session: any) => {
      if (!session) return false
      if (session.outcome) return false
      if (session.status && session.status !== "idle") return true
      const busy = Number(session?.time?.busy ?? 0)
      const idle = Number(session?.time?.idle ?? 0)
      if (busy > 0 && idle === 0) return true
      return busy > idle
    }

    const chooseFallback = (pending: Pending): { providerID: string; id: string } | undefined => {
      const failed = modelKey({ providerID: pending.failedProviderID, id: pending.failedModelID })
      const tried = new Set(pending.tried ?? [])
      const candidates = cfg.fallbackModels
        .map(parseModel)
        .filter((model): model is { providerID: string; id: string } => !!model)
        .filter((model) => modelKey(model) !== failed && !tried.has(modelKey(model)!))

      // A plan-wide limit (weekly/monthly/subscription) covers every model on
      // the provider, so switching within the same provider is pointless; only
      // a different provider can help. Observed in production 2026-11-10:
      // opencode-go/minimax -> opencode-go/deepseek, both on the same Go limit.
      const crossProvider = candidates.filter((model) => model.providerID !== pending.failedProviderID)
      if (crossProvider.length > 0) return crossProvider[0]
      if (pending.planWide) return undefined
      return candidates[0]
    }

    const backoff = (attempts: number) =>
      Math.max(1_000, Math.min(cfg.baseDelayMs * 2 ** Math.max(0, attempts - 1), cfg.maxDelayMs))

    const attempt = async (sessionID: string, trigger: "timer" | "watchdog" | "restore") => {
      if (!sessionID || registry.owner !== instance) return
      if (inFlight.has(sessionID)) return
      inFlight.add(sessionID)
      const claimed = acquire(sessionID)
      try {
        if (!claimed) {
          hold(sessionID, 10_000, "claimed-elsewhere")
          return
        }
        await attemptOnce(sessionID, trigger)
      } finally {
        if (claimed) release(sessionID)
        inFlight.delete(sessionID)
      }
    }

    const attemptOnce = async (sessionID: string, trigger: "timer" | "watchdog" | "restore") => {
      let pending = registry.state.sessions[sessionID]
      if (!pending) return
      const now = Date.now()
      if (pending.nextAt > now + 250) return
      if (now - pending.firstAt > cfg.maxWindowMs) return giveUp(sessionID, "window")
      if (pending.attempts >= cfg.maxAttempts) return giveUp(sessionID, "attempts")

      let session: any
      try {
        session = await ctx.session.get({ sessionID })
      } catch (error: any) {
        return hold(sessionID, 10_000, "session-get-failed", { error: String(error?.message ?? error) })
      }
      pending = registry.state.sessions[sessionID]
      if (!pending) return

      if (!session) return giveUp(sessionID, "session-missing")
      if (session.outcome === "succeeded") return drop(sessionID, "succeeded")
      if (session.outcome === "interrupted") return drop(sessionID, "interrupted")
      if (running(session)) return hold(sessionID, Math.max(250, Math.min(5_000, cfg.watchdogMs)), "busy")

      // Injection ceiling (repo rule): a session that keeps failing must not be
      // re-prompted forever. Counted per session inside a rolling window.
      if (injectionsInWindow(registry.state, sessionID, now, cfg.injectWindowMs) >= cfg.injectPerWindow) {
        record({ event: "give-up", sessionID, reason: "injection-ceiling", windowMs: cfg.injectWindowMs, limit: cfg.injectPerWindow })
        toast(`Already resumed this session ${cfg.injectPerWindow} times in the last ${Math.round(cfg.injectWindowMs / 60_000)} min; stopping automatic resumes.`, "error")
        return drop(sessionID, "injection-ceiling")
      }

      // The session tells us which model is actually configured now. That is
      // the model that failed, so exclude it from failover.
      const current = modelKey(session.model)
      if (current) {
        const [providerID, id] = current.split("/")
        pending.failedProviderID = providerID
        pending.failedModelID = id
        if (pending.switchedTo === current) pending.switchedTo = undefined
      }

      const shouldSwitch =
        !!chooseFallback(pending) &&
        (pending.reason === "free-limit" || pending.failures >= cfg.switchAfterAttempts)
      const target = shouldSwitch ? chooseFallback(pending) : undefined

      // One `[auto-resume]` per model per cooldown. A model that already got
      // the continuation and is still limited will only fail again, so
      // re-sending on every retry just floods the session (19 identical
      // prompts observed on 2026-11-10). The cooldown keeps a resume possible
      // once the quota is plausibly back; a provider reset time or a new user
      // message lifts it immediately.
      const injectModel = modelKey(target) ?? current
      const sincePrompt = pending.lastPromptAt ? now - pending.lastPromptAt : Number.POSITIVE_INFINITY
      const resetPassed = !!pending.resetsAt && now >= pending.resetsAt
      if (injectModel && pending.promptedModel === injectModel && sincePrompt < cfg.rePromptMs && !resetPassed) {
        // Wake at whichever comes first: the cooldown end or the provider's
        // declared reset. Clamping to maxDelayMs here would burn every attempt
        // in seconds and give up long before the quota is back.
        const cooldownLeft = Math.max(250, cfg.rePromptMs - sincePrompt)
        const resetLeft = pending.resetsAt ? Math.max(250, pending.resetsAt - now) : cooldownLeft
        const waitMs = Math.max(250, Math.min(cooldownLeft, resetLeft))
        pending.attempts += 1
        pending.nextAt = now + waitMs
        record({
          event: "suppress",
          sessionID,
          model: injectModel,
          attempt: pending.attempts,
          reason: "cooldown",
          retryInMs: waitMs,
        })
        if (!pending.notifiedStall) {
          pending.notifiedStall = true
          const when = pending.resetsAt
            ? `declared reset ${new Date(pending.resetsAt).toLocaleString()}`
            : `${Math.round(cfg.rePromptMs / 60_000)} min`
          toast(`${injectModel} is still limited; next automatic resume in ${when}. Send a message earlier to continue now.`, "warning")
        }
        persist()
        arm(sessionID)
        return
      }

      try {
        if (target) {
          const from = modelKey({ providerID: pending.failedProviderID, id: pending.failedModelID })
          await ctx.session.switchModel({ sessionID, model: { id: target.id, providerID: target.providerID } })
          pending = registry.state.sessions[sessionID]
          if (!pending) return
          const to = modelKey(target)
          if (!to) return
          pending.switchedTo = to
          pending.tried = [...(pending.tried ?? []), to]
          record({ event: "switch", sessionID, from, to, trigger })
          persist()
          toast(`Switched ${from ?? "model"} to ${pending.switchedTo} and resuming.`, "info")
        }

        const text = `${AUTO_RESUME_PREFIX} The previous run stopped because ${label(pending)} hit a usage limit. Continue the interrupted task from where it stopped. Check the current state first and do not repeat work that is already done.`
        await ctx.session.prompt({ sessionID, text, delivery: "queue", metadata: { autoResume: true } })
        pending = registry.state.sessions[sessionID]
        if (!pending) return
        pending.attempts += 1
        pending.promptedModel = injectModel
        pending.lastPromptAt = Date.now()
        pending.notifiedStall = false
        pending.nextAt = Date.now() + (pending.planWide ? cfg.maxDelayMs : backoff(pending.attempts))
        registry.state.injected = {
          ...(registry.state.injected ?? {}),
          [`${sessionID}|${pending.attempts}`]: { at: Date.now() },
        }
        record({
          event: "prompt",
          sessionID,
          model: label(pending),
          attempt: pending.attempts,
          trigger,
          switched: !!target,
        })
        persist()
        arm(sessionID)
      } catch (error: any) {
        pending = registry.state.sessions[sessionID]
        if (!pending) return
        pending.attempts += 1
        const delay = pending.planWide ? cfg.maxDelayMs : backoff(pending.attempts)
        pending.nextAt = Date.now() + delay
        record({
          event: "prompt-failed",
          sessionID,
          attempt: pending.attempts,
          error: String(error?.message ?? error).slice(0, 400),
        })
        persist()
        arm(sessionID)
      }
    }

    const onFailure = (sessionID: string, error: any) => {
      if (!sessionID) return
      // Re-read the config so tuning does not require a server restart.
      cfg = resolveConfig(readConfigFile())
      if (!cfg.enabled) {
        for (const id of Object.keys(registry.state.sessions)) drop(id, "disabled")
        return
      }
      const verdict = classifyFailure(error)
      if (!verdict.retryable) {
        record({ event: "skip", sessionID, reason: verdict.reason, message: verdict.message })
        drop(sessionID, verdict.reason)
        return
      }

      const now = Date.now()
      let pending = registry.state.sessions[sessionID]
      if (!pending || now - pending.firstAt > cfg.maxWindowMs) {
        pending = {
          sessionID,
          firstAt: now,
          failures: 0,
          attempts: 0,
          nextAt: now,
          lastFailureAt: now,
          reason: verdict.reason,
          message: verdict.message,
        }
        registry.state.sessions[sessionID] = pending
      }
      pending.failures += 1
      pending.lastFailureAt = now
      pending.reason = verdict.reason
      pending.message = verdict.message
      pending.planWide = verdict.planWide
      pending.resetsAt = verdict.resetsAt ?? pending.resetsAt

      // If the run that just failed was our failover target, that target is
      // now the failed model; pick a different one next time.
      if (pending.switchedTo) {
        const [providerID, id] = pending.switchedTo.split("/")
        pending.failedProviderID = providerID
        pending.failedModelID = id
        pending.switchedTo = undefined
      }

      const canSwitch = !!chooseFallback(pending) && (verdict.reason === "free-limit" || pending.failures >= cfg.switchAfterAttempts)
      const computed = nextDelayMs({ attempt: pending.failures, resetsAt: verdict.resetsAt, now, cfg })
      if (!canSwitch && computed === undefined) {
        record({ event: "give-up", sessionID, reason: "reset-too-far", resetsAt: verdict.resetsAt, message: verdict.message })
        toast(`${label(pending)} limit resets ${new Date(verdict.resetsAt!).toLocaleString()}; not scheduling an automatic resume.`, "error")
        drop(sessionID, "reset-too-far")
        return
      }
      // A plan-wide limit (weekly/monthly) does not clear in minutes. Take one
      // quick attempt so the plugin can still switch to another provider, then
      // wait out the max backoff instead of re-running a doomed request.
      const delay = canSwitch || verdict.planWide ? cfg.settleMs : computed ?? cfg.maxDelayMs

      pending.nextAt = now + Math.max(250, delay)
      persist()
      record({
        event: "failure",
        sessionID,
        failures: pending.failures,
        reason: verdict.reason,
        message: verdict.message,
        model: modelKey({ providerID: pending.failedProviderID, id: pending.failedModelID }),
        nextAt: new Date(pending.nextAt).toISOString(),
        action: canSwitch ? "switch-model" : "retry-same-model",
        fallback: modelKey(chooseFallback(pending)),
      })
      arm(sessionID)
    }

    const controller = new AbortController()
    const inFlight = new Set<string>()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (registry.owner !== instance) continue
          const type = event?.type
          const data = event?.data
          if (typeof type !== "string" || !data) continue

          if (type === "session.execution.started") {
            // Never cancel here: opencode itself emits started for its own
            // retries, and a started run can end without a terminal event
            // (revert, abort). Cancelling on it is how resumes were lost.
            const pending = registry.state.sessions[sessionIDOf(data)]
            if (!pending) continue
            record({ event: "activity", sessionID: pending.sessionID, nextAt: new Date(pending.nextAt).toISOString() })
            continue
          }

          if (type === "session.execution.succeeded") {
            const sessionID = sessionIDOf(data)
            const pending = registry.state.sessions[sessionID]
            if (!pending) continue
            toast(`Resumed ${label(pending)}: the task completed.`, "success")
            drop(sessionID, "succeeded", { attempts: pending.attempts })
            continue
          }

          if (type === "session.next.prompted" || type === "session.next.prompt.admitted") {
            const sessionID = sessionIDOf(data)
            const pending = registry.state.sessions[sessionID]
            if (!pending) continue
            const text = String(data?.prompt?.text ?? "")
            // Our own continuation must not reset the episode, or the plugin
            // would keep re-prompting the same limited model.
            if (text.startsWith(AUTO_RESUME_PREFIX)) continue
            // A real user message starts a new episode: one resume is allowed again.
            pending.promptedModel = undefined
            pending.lastPromptAt = undefined
            pending.resetsAt = undefined
            pending.notifiedStall = false
            record({ event: "episode-reset", sessionID, attempts: pending.attempts })
            persist()
            continue
          }

          if (type === "session.execution.failed") {
            onFailure(sessionIDOf(data), data.error)
            continue
          }
        }
      } catch {}
    })()

    // Restore pending resumes from disk: a plugin reload, a location restart,
    // or a lost timer must not lose the work.
    let restored = 0
    const now = Date.now()
    for (const [sessionID, pending] of Object.entries(registry.state.sessions)) {
      if (now - pending.firstAt > cfg.maxWindowMs || pending.attempts >= cfg.maxAttempts) {
        delete registry.state.sessions[sessionID]
        continue
      }
      restored += 1
      if (pending.nextAt <= now) pending.nextAt = now + 1_000
      record({ event: "restored", sessionID, attempts: pending.attempts, nextAt: new Date(pending.nextAt).toISOString() })
      arm(sessionID)
    }
    if (restored > 0) persist()
    record({ event: "setup", instance, restored, sessions: Object.keys(registry.state.sessions).length })

    const watchdog = setInterval(() => {
      if (registry.owner !== instance) return
      const at = Date.now()
      for (const pending of Object.values(registry.state.sessions)) {
        if (pending.nextAt <= at) void attempt(pending.sessionID, "watchdog")
      }
    }, Math.max(1_000, cfg.watchdogMs))
    watchdog?.unref?.()

    return () => {
      controller.abort()
      clearInterval(watchdog)
      registry.instances.delete(instance)
      const wasOwner = registry.owner === instance
      if (!wasOwner) {
        record({ event: "dispose", instance, owner: false })
        return
      }
      // Hand ownership to a surviving instance instead of going headless.
      const next = registry.instances.values().next().value
      registry.owner = next
      record({ event: "dispose", instance, owner: true, handedTo: next })
    }
  },
}

function sessionIDOf(data: any): string {
  return String(data?.sessionID ?? data?.sessionId ?? "")
}
