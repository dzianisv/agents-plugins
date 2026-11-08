/**
 * session-autoreflect — opencode v2 server plugin.
 *
 * Every `AUTOREFLECT_INTERVAL_MS` (default 30 minutes) of *working* time in a
 * session, the agent gets a reflection prompt in its context and is told to act
 * on the answers. Idle sessions are never touched.
 *
 * v2 loads this file (`server.ts` at the plugin directory root) and calls `setup`.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  PROMPT,
  attach,
  elapsed,
  expired,
  finished,
  newState,
  resolveConfig,
  started,
  tick,
  type Config,
  type State,
} from "./opencode/core"

const STARTED = "session.execution.started"
const FINISHED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

const configPath = () => join(homedir(), ".config", "opencode", "session-autoreflect.json")
const logDir = () => process.env.AUTOREFLECT_HOME || join(homedir(), ".cache", "session-autoreflect")

function readConfigFile(): Partial<Config> {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"))
  } catch {
    return {}
  }
}

function recorder() {
  let ready = false
  return (entry: Record<string, unknown>) => {
    try {
      if (!ready) {
        mkdirSync(logDir(), { recursive: true, mode: 0o700 })
        chmodSync(logDir(), 0o700)
        ready = true
      }
      const file = join(logDir(), "events.jsonl")
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 })
      chmodSync(file, 0o600)
    } catch {}
  }
}

const isUserMessage = (m: any): boolean =>
  m?.role === "user" &&
  typeof m?.id === "string" &&
  (Array.isArray(m?.content) ? m.content : []).some((p: any) => p?.type === "text" && typeof p.text === "string")

const part = (text: string) => ({ type: "text", text, metadata: { autoreflect: true } })

// opencode can instantiate the same plugin more than once in one server (one per
// loaded config). A session belongs to one instance at a time; ownership expires
// so a reloaded plugin takes over after ~90s without a heartbeat.
type Owner = { id: string; seen: number }
const OWNER_TTL_MS = 90_000
const owners: Map<string, Owner> = ((globalThis as any).__sessionAutoreflectOwners ??= new Map())

export default {
  id: "session-autoreflect",
  async setup(ctx: any) {
    const cfg = resolveConfig(readConfigFile())
    if (!cfg.enabled) return

    const instance = crypto.randomUUID()
    const own = (sessionID: string, now: number, take: boolean): boolean => {
      const owner = owners.get(sessionID)
      if (!owner || owner.id === instance) {
        owners.set(sessionID, { id: instance, seen: now })
        return true
      }
      if (now - owner.seen <= OWNER_TTL_MS) return false
      if (!take) return false
      owners.set(sessionID, { id: instance, seen: now })
      return true
    }

    const states = new Map<string, State>()
    const children = new Map<string, boolean>()
    const record = recorder()

    const childSession = async (id: string): Promise<boolean> => {
      if (children.has(id)) return children.get(id)!
      const info = await Promise.resolve(ctx.session.get({ sessionID: id })).catch(() => undefined)
      const child = Boolean(info?.parentID)
      children.set(id, child)
      return child
    }

    const stateOf = (id: string, now: number): State => {
      let state = states.get(id)
      if (!state) {
        state = newState(now)
        states.set(id, state)
      }
      return state
    }

    await ctx.session.hook("context", (event: any) => {
      const sessionID = typeof event?.sessionID === "string" ? event.sessionID : ""
      if (!sessionID || !own(sessionID, Date.now(), false)) return
      const state = states.get(sessionID)
      if (!state) return
      const messages = Array.isArray(event.messages) ? event.messages : []
      const last = [...messages].reverse().find(isUserMessage)
      if (!last) return
      const now = Date.now()
      const busy = elapsed(state, now)
      if (!attach(state, last.id, now)) return
      if (!last.content.some((p: any) => p?.metadata?.autoreflect)) last.content.push(part(PROMPT))
      record({ event: "inject", sessionID, messageID: last.id, busyMs: busy })
    })

    const timer = setInterval(() => {
      const now = Date.now()
      for (const [id, state] of states) {
        if (tick(state, now, cfg)) record({ event: "armed", sessionID: id, intervalMs: cfg.intervalMs })
        else if (expired(state, now, cfg)) states.delete(id)
      }
    }, cfg.tickMs)
    ;(timer as any).unref?.()

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as any)?.type
          if (type !== STARTED && !FINISHED.has(type)) continue
          const sessionID = (event as any)?.data?.sessionID
          if (typeof sessionID !== "string" || !own(sessionID, Date.now(), true)) continue
          if (!cfg.includeChild && (await childSession(sessionID))) continue
          const state = stateOf(sessionID, Date.now())
          if (type === STARTED) started(state, Date.now(), cfg)
          else finished(state, Date.now())
        }
      } catch {}
    })()

    return () => {
      clearInterval(timer)
      controller.abort()
    }
  },
}
