// opencode v1 plugin: audit a session when it goes idle and attach the findings to the next user
// turn. The judge is a hidden child session; everything else lives in src/core.
import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { auditOnce, type AuditStore } from "../core/audit"
import { pruneLog, record } from "../core/audit-log"
import { attachFeedback, isHeadlessRun, isRealUserMessage, JUDGE_AGENT, judgeAgent, parseModel } from "../core/opencode"
import { DEFAULT_MODEL, isViolationFeedback } from "../core/prompt"
import { composeRules, readRules } from "../core/rules"
import { readInjectBudget, stateDir, writeInjectBudget } from "../core/state"
import { countInWindow, mayInject, recordInjection, type Budget } from "../shared/inject-limit"
import { notify } from "../shared/notify"
import { toMsg } from "./messages"

const DEFAULT_JUDGE_TIMEOUT_MS = 240000
const AUDIT_TITLE = "supervisor audit"
const STALE_AUDIT_MS = 5 * 60 * 1000
/** At most this many immediate feedback injections per session per window. */
const MAX_INJECTIONS = 3
/** The window the injection ceiling is counted over, in seconds. */
const INJECTION_WINDOW = 3600

/** opencode v1 plugin: audit a session when it goes idle and attach the findings to the next user turn. */
export const Supervisor: Plugin = async ({ client, directory }) => {
  if (process.env.SUPERVISOR_ENABLED === "0" || isHeadlessRun(process.argv, process.env)) return {}

  const spec = process.env.SUPERVISOR_MODEL ?? DEFAULT_MODEL
  const model = parseModel(spec)
  const rules = () => composeRules(readRules(process.env, directory))
  const maxChars = Number(process.env.SUPERVISOR_MAX_CHARS ?? 60000)
  const judgeTimeoutMs = Number(process.env.SUPERVISOR_JUDGE_TIMEOUT ?? DEFAULT_JUDGE_TIMEOUT_MS / 1000) * 1000

  const isChild = new Map<string, boolean>()
  const audited = new Map<string, string>()
  const running = new Set<string>()
  const rerun = new Set<string>()
  const pending = new Map<string, string>()
  const injected = new Map<string, { messageID: string; feedback: string }>()
  const auditing = new Set<string>()

  const log = (level: "info" | "error", message: string): void => {
    if (level === "error") void notify("turn-check", message, { client })
    void client.app.log({ body: { service: "supervisor", level, message } }).catch(() => {})
  }

  const childSession = async (id: string) => {
    if (!isChild.has(id)) {
      const res = await client.session.get({ path: { id } }).catch(() => undefined)
      isChild.set(id, Boolean(res?.data?.parentID))
    }
    return isChild.get(id)
  }

  const cleanupStaleAudits = async () => {
    const sessions = ((await client.session.list()).data ?? []) as any[]
    for (const s of sessions) {
      if (!s.parentID || s.title !== AUDIT_TITLE || auditing.has(s.id) || Date.now() - (s.time?.created ?? Date.now()) < STALE_AUDIT_MS) continue
      await client.session.delete({ path: { id: s.id } }).catch(() => {})
    }
  }

  const waitForAssistant = async (auditID: string, deadline: number) => {
    while (Date.now() < deadline) {
      const msgs = ((await client.session.messages({ path: { id: auditID } })).data ?? []) as any[]
      const done = msgs.findLast((m) => m.info.role === "assistant" && (m.info.time?.completed || m.info.error))
      if (done) return done as { info: any; parts: any[] }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error("judge did not answer in time")
  }

  const promptJudge = async (auditID: string, system: string, transcript: string, deadline: number) => {
    const res = await client.session.prompt({
      path: { id: auditID },
      body: { agent: JUDGE_AGENT, model, system, parts: [{ type: "text", text: `TRANSCRIPT:\n\n${transcript}` }] },
    })
    const early = (res.data as any)?.info?.role === "user"
    const answer = early ? await waitForAssistant(auditID, deadline) : { info: (res.data as any)?.info, parts: (res.data?.parts ?? []) as any[] }
    const meta = {
      role: answer.info?.role,
      agent: answer.info?.agent,
      error: JSON.stringify((res as any).error ?? answer.info?.error ?? null).slice(0, 300),
      partTypes: answer.parts.map((p) => p.type),
      waited: early,
    }
    return { text: answer.parts.flatMap((p) => (p.type === "text" ? [p.text as string] : [])).join(""), meta }
  }

  /** Deliver the findings now, so the agent fixes them in this session; a failure leaves the note for the next message. */
  const injectFeedback = async (sessionID: string, text: string) => {
    if (!isViolationFeedback(text)) return
    const now = Math.floor(Date.now() / 1000)
    // Bounded per session on disk, so a plugin reload cannot reset the ceiling and start a loop.
    const dir = stateDir()
    const budget = readInjectBudget(sessionID, dir)
    if (!mayInject(budget, `${sessionID}|`, now, INJECTION_WINDOW, MAX_INJECTIONS)) {
      log("error", `not injecting again this hour for ${sessionID}: ${MAX_INJECTIONS} findings already delivered`)
      return
    }
    writeInjectBudget(sessionID, recordInjection(budget, `${sessionID}|${countInWindow(budget, `${sessionID}|`, now, INJECTION_WINDOW)}`, now), dir)
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` }] },
      })
      pending.delete(sessionID)
    } catch (err) {
      log("error", `feedback inject failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const audit = async (sessionID: string) => {
    const res = await client.session.messages({ path: { id: sessionID } })
    const msgs = ((res.data ?? []) as any[]).map(toMsg)
    const last = msgs.at(-1)
    if (!last) return

    let judgeMeta: Record<string, unknown> = {}
    const judge = async (system: string, transcript: string): Promise<string> => {
      const created = await client.session.create({ body: { parentID: sessionID, title: AUDIT_TITLE } })
      const auditID = created.data?.id
      if (!auditID) throw new Error("could not create audit session")
      isChild.set(auditID, true)
      auditing.add(auditID)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const work = promptJudge(auditID, system, transcript, Date.now() + judgeTimeoutMs)
        work.catch(() => {})
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            client.session.abort({ path: { id: auditID } }).catch(() => {})
            reject(new Error("judge timed out"))
          }, judgeTimeoutMs)
        })
        const answer = await Promise.race([work, timeout])
        judgeMeta = answer.meta
        return answer.text
      } finally {
        clearTimeout(timer)
        auditing.delete(auditID)
        client.session.delete({ path: { id: auditID } }).catch(() => {})
      }
    }

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
      notify: (message) => log("error", message),
      notifyFeedback: async (summary) => {
        await notify("turn-check feedback", summary, { client, level: "warning", dedupe: false })
      },
      extra: () => judgeMeta,
    })
  }

  pruneLog(stateDir())
  cleanupStaleAudits().catch(() => {})

  return {
    config: async (cfg) => {
      cfg.agent = { ...cfg.agent, [JUDGE_AGENT]: judgeAgent(spec) as any }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const id = event.properties.sessionID
      if (await childSession(id)) return
      if (running.has(id)) {
        rerun.add(id)
        return
      }
      const run = (): void => {
        running.add(id)
        audit(id)
          .catch((err) => log("error", `audit failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            running.delete(id)
            if (rerun.delete(id)) run()
          })
      }
      run()
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const user = output.messages.findLast((m) => m.info.role === "user")
      if (!user) return
      const sessionID = user.info.sessionID
      const tracked = injected.get(sessionID)
      if (tracked?.messageID === user.info.id) {
        attachFeedback(user as any, tracked.feedback)
        return
      }
      if (tracked) injected.delete(sessionID)
      const feedback = pending.get(sessionID)
      if (!feedback || !isRealUserMessage(user as any)) return
      pending.delete(sessionID)
      injected.set(sessionID, { messageID: user.info.id, feedback })
      attachFeedback(user as any, feedback)
    },
  }
}
