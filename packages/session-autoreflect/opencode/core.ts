/**
 * Pure state machine for session-autoreflect.
 *
 * A session accumulates "busy" time only while an execution is running. When a
 * session has worked for `intervalMs` without an injection, the next LLM step of
 * that turn gets the reflection prompt attached. Idle sessions never fire, and a
 * long idle gap resets the accumulator so a new task starts from zero.
 */

export const PROMPT = `<system-reminder>
AUTOREFLECT: you have been working on this task for a while. Stop and reflect before the next step.

1. What are you doing right now?
2. What is the goal?
3. What is the acceptance criteria?
4. Did you complete the task? If not, what is wrong?
5. Is the implementation plan correct, or does it have to be revisited?
6. Are you moving in the right direction, or is there a better/faster way to resolve the issues and blockers?
7. Can you unblock yourself?

Then act on the answers: take the next concrete step now (fix, unblock, finish, or change the plan). Do not answer with reflection only and do not stop.
</system-reminder>`

export type Config = {
  enabled: boolean
  intervalMs: number
  idleResetMs: number
  tickMs: number
  includeChild: boolean
}

export type State = {
  busySince?: number
  busyMs: number
  lastActiveAt: number
  pending: boolean
  injectedFor?: string
}

export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
export const DEFAULT_IDLE_RESET_MS = 10 * 60 * 1000
export const DEFAULT_TICK_MS = 30 * 1000

const int = (value: unknown, fallback: number): number => {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const flag = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value === "boolean") return value
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase())
}

export function resolveConfig(file: Partial<Config> = {}, env: Record<string, string | undefined> = process.env): Config {
  return {
    enabled: flag(env.AUTOREFLECT_ENABLED ?? file.enabled, true),
    intervalMs: int(env.AUTOREFLECT_INTERVAL_MS ?? file.intervalMs, DEFAULT_INTERVAL_MS),
    idleResetMs: int(env.AUTOREFLECT_IDLE_RESET_MS ?? file.idleResetMs, DEFAULT_IDLE_RESET_MS),
    tickMs: int(env.AUTOREFLECT_TICK_MS ?? file.tickMs, DEFAULT_TICK_MS),
    includeChild: flag(env.AUTOREFLECT_INCLUDE_CHILD ?? file.includeChild, false),
  }
}

export const newState = (now: number): State => ({ busyMs: 0, lastActiveAt: now, pending: false })

/** An execution started: the session is working again, so the clock runs. */
export function started(state: State, now: number, cfg: Config): void {
  if (state.busySince === undefined) {
    if (now - state.lastActiveAt >= cfg.idleResetMs) state.busyMs = 0
    state.busySince = now
  }
  state.lastActiveAt = now
}

/** An execution finished: stop the clock and drop an injection that never landed. */
export function finished(state: State, now: number): void {
  if (state.busySince !== undefined) {
    state.busyMs += Math.max(0, now - state.busySince)
    state.busySince = undefined
  }
  state.lastActiveAt = now
  state.pending = false
}

/** Busy milliseconds this task has accumulated, including the current execution. */
export const elapsed = (state: State, now: number): number =>
  state.busyMs + (state.busySince === undefined ? 0 : Math.max(0, now - state.busySince))

/**
 * Timer step. Returns true when the reflection prompt should be armed for the
 * next step of this turn. Idle sessions reset their accumulator after the gap.
 */
export function tick(state: State, now: number, cfg: Config): boolean {
  if (state.busySince === undefined) {
    if (now - state.lastActiveAt >= cfg.idleResetMs) state.busyMs = 0
    return false
  }
  if (state.pending) return false
  if (elapsed(state, now) < cfg.intervalMs) return false
  state.pending = true
  return true
}

/**
 * Decide whether the prompt belongs on the message the model is about to see.
 * Re-attaches on every step of the turn it first landed in, and stops as soon
 * as a different user message shows up. The next interval starts when the
 * prompt actually reaches the model, not when it was armed.
 */
export function attach(state: State, messageID: string, now: number): boolean {
  if (state.injectedFor === messageID) return true
  if (state.injectedFor !== undefined) state.injectedFor = undefined
  if (!state.pending) return false
  state.pending = false
  state.injectedFor = messageID
  state.busyMs = 0
  if (state.busySince !== undefined) state.busySince = now
  state.lastActiveAt = now
  return true
}

/** Drop the state of sessions that have been idle long enough to forget about. */
export const expired = (state: State, now: number, cfg: Config): boolean =>
  state.busySince === undefined && now - state.lastActiveAt >= cfg.idleResetMs * 4
