// opencode v2 entry: same audit pipeline as v1, with the judge as a sessionless ctx.generate.text
// call and feedback attached through the v2 context hook. Keep this file's exports.
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { auditOnce, type AuditStore } from "./src/core/audit"
import { pruneLog, record } from "./src/core/audit-log"
import { parseModel } from "./src/core/opencode"
import { DEFAULT_MODEL, isViolationFeedback, TRANSCRIPT_HEADER, type Msg } from "./src/core/prompt"
import { composeRules, readRules } from "./src/core/rules"
import { stateDir } from "./src/core/state"
import { countInWindow, mayInject, recordInjection, type Budget } from "./src/shared/inject-limit"
import { notify } from "./src/shared/notify"

const DEFAULT_JUDGE_TIMEOUT_MS = 240000
/** At most this many immediate feedback injections per session per window. */
const MAX_INJECTIONS = 3
/** The window the injection ceiling is counted over, in seconds. */
const INJECTION_WINDOW = 3600

/** Convert session.context entries to the Msg shape core helpers consume. */
export function toMsgs(infos: any[]): Msg[] {
  const out: Msg[] = []
  for (const m of infos ?? []) {
    if (m?.type === "user" && typeof m.text === "string") {
      out.push({ info: { id: m.id, role: "user" }, parts: [{ type: "text", text: m.text }] })
    } else if (m?.type === "assistant") {
      const parts = (m.content ?? []).flatMap((p: any) => {
        if (p?.type === "text") return [{ type: "text", text: p.text }]
        if (p?.type === "tool") {
          const output = (p.state?.content ?? [])
            .filter((c: any) => c?.type === "text")
            .map((c: any) => String(c.text ?? ""))
            .join("\n")
          return [{ type: "tool", tool: p.name, input: p.state?.input ?? {}, output }]
        }
        return []
      })
      out.push({ info: { id: m.id, role: "assistant" }, parts })
    }
  }
  return out
}

/** True when a context-hook user message carries real user text (not only attachments or our own note). */
export function isRealUserMessageV2(msg: any): boolean {
  return (
    msg?.role === "user" &&
    (msg.content ?? []).some((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim() && !p.metadata?.supervisor)
  )
}

/** Push the feedback note onto a context-hook user message unless it already carries one. */
export function attachFeedbackV2(msg: any, feedback: string): boolean {
  const content = (msg.content ??= [])
  if (content.some((p: any) => p?.metadata?.supervisor)) return false
  content.push({
    type: "text",
    text: `<system-reminder>\n${feedback}\n</system-reminder>`,
    metadata: { supervisor: true },
  })
  return true
}

const canonical = (p: string | undefined): string => {
  if (!p) return ""
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** opencode v2 plugin entry: audits on execution events and attaches feedback via the context hook. */
export default {
  id: "turn-check",
  async setup(ctx: any) {
    if (process.env.SUPERVISOR_ENABLED === "0") return

    const spec = process.env.SUPERVISOR_MODEL ?? DEFAULT_MODEL
    const model = parseModel(spec)
    const rules = () => composeRules(readRules(process.env, ctx.location?.directory))
    const maxChars = Number(process.env.SUPERVISOR_MAX_CHARS ?? 60000)
    const judgeTimeoutMs = Number(process.env.SUPERVISOR_JUDGE_TIMEOUT ?? DEFAULT_JUDGE_TIMEOUT_MS / 1000) * 1000

    const skipped = new Map<string, boolean>() // child or foreign-location session
    const audited = new Map<string, string>()
    const running = new Set<string>()
    const rerun = new Set<string>()
    const pending = new Map<string, string>()
    const injected = new Map<string, { messageID: string; feedback: string }>()
    const injections: Budget = {}

    const log = (message: string) => console.error(`[supervisor] ${message}`)
    const fail = (message: string) => void notify("turn-check", message)

    // Audit only sessions in this instance's location; never child sessions.
    const myDir = canonical(ctx.location?.directory)
    const eligible = async (id: string) => {
      if (!skipped.has(id)) {
        const info = await ctx.session.get({ sessionID: id }).catch(() => undefined)
        const foreign = Boolean(info?.location?.directory && myDir && canonical(info.location.directory) !== myDir)
        skipped.set(id, Boolean(info && (info.parentID || foreign)))
      }
      return !skipped.get(id)
    }

    const judge = async (system: string, transcript: string): Promise<string> => {
      const prompt = `${system}${TRANSCRIPT_HEADER}${transcript}`
      const ac = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort()
          reject(new Error("judge timed out"))
        }, judgeTimeoutMs)
      })
      const work = ctx.generate
        .text({ prompt, model: { providerID: model.providerID, id: model.modelID } }, { signal: ac.signal })
        .then((r: any) => String(r?.text ?? ""))
      work.catch(() => {})
      try {
        return await Promise.race([work, timeout])
      } finally {
        clearTimeout(timer)
      }
    }

    /** Deliver the findings now, so the agent fixes them in this session; a failure leaves the note for the next message. */
    const injectFeedback = async (sessionID: string, text: string) => {
      if (!isViolationFeedback(text)) return
      const now = Math.floor(Date.now() / 1000)
      // Bounded per session: a judge that keeps finding violations cannot drive an endless loop.
      if (!mayInject(injections, `${sessionID}|`, now, INJECTION_WINDOW, MAX_INJECTIONS)) {
        log(`not injecting again this hour for ${sessionID}: ${MAX_INJECTIONS} findings already delivered`)
        return
      }
      Object.assign(injections, recordInjection(injections, `${sessionID}|${countInWindow(injections, `${sessionID}|`, now, INJECTION_WINDOW)}`, now))
      try {
        await ctx.session.prompt({ sessionID, text: `<system-reminder>\n${text}\n</system-reminder>` })
        pending.delete(sessionID)
      } catch (err) {
        log(`feedback inject failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const audit = async (sessionID: string) => {
      const msgs = toMsgs(await ctx.session.context({ sessionID }))
      const last = msgs.at(-1)
      if (!last) return
      const store: AuditStore = {
        lastAudited: () => audited.get(sessionID) ?? "",
        markAudited: (messageID) => void audited.set(sessionID, messageID),
        readPending: () => pending.get(sessionID) ?? "",
        writePending: (text) => {
          pending.set(sessionID, text)
          void injectFeedback(sessionID, text)
        },
        clearPending: () => {
          pending.delete(sessionID)
          injected.delete(sessionID)
        },
      }
      await auditOnce({
        sessionID,
        msgs,
        messageID: last.info.id,
        rules,
        judge,
        maxChars,
        model: spec,
        agent: "opencode",
        store,
        record: (entry) => record(stateDir(), entry),
        notify: (message) => fail(message),
        notifyFeedback: async (summary) => {
          await notify("turn-check feedback", summary, { level: "warning", dedupe: false })
        },
      })
    }

    const run = (id: string): void => {
      running.add(id)
      audit(id)
        .catch((err) => {
          log(`audit failed: ${err instanceof Error ? err.message : String(err)}`)
          fail(`audit failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        .finally(() => {
          running.delete(id)
          if (rerun.delete(id)) run(id)
        })
    }

    const TRIGGER_EVENTS = new Set([
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ])

    pruneLog(stateDir())

    await ctx.session.hook("context", (event: any) => {
      const messages = event?.messages
      if (!Array.isArray(messages)) return
      const user = [...messages].reverse().find((m: any) => m?.role === "user" && typeof m?.id === "string")
      if (!user) return
      const sessionID = String(event.sessionID)
      const tracked = injected.get(sessionID)
      if (tracked && tracked.messageID === user.id) {
        attachFeedbackV2(user, tracked.feedback)
        return
      }
      if (tracked) injected.delete(sessionID)
      const feedback = pending.get(sessionID)
      if (!feedback || !isRealUserMessageV2(user)) return
      pending.delete(sessionID)
      injected.set(sessionID, { messageID: user.id, feedback })
      attachFeedbackV2(user, feedback)
    })

    const ac = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: ac.signal })) {
          if (!TRIGGER_EVENTS.has((event as any)?.type)) continue
          const sessionID = (event as any).data?.sessionID
          if (typeof sessionID !== "string") continue
          if (!(await eligible(sessionID))) continue
          if (running.has(sessionID)) {
            rerun.add(sessionID)
            continue
          }
          run(sessionID)
        }
      } catch (err) {
        if (!ac.signal.aborted) log(`event subscription failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()

    return () => ac.abort()
  },
}
