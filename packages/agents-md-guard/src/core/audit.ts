// The one audit pipeline both runtimes share: skip unchanged turns, build the prompt, call the
// runtime's judge, record the verdict, mark the message audited only on a valid verdict, and leave
// either the feedback note or a loud error note for the next prompt.
import { buildPrompt, currentTurn, ERROR_PREFIX, formatError, formatFeedback, hasAgentWork, parseVerdict, requiresLinkedReferences, unlinkedReferenceViolation, type Msg, type Verdict } from "./prompt"

/** What one audit attempt did. */
export type AuditOutcome = "skipped" | "pass" | "fail" | "error"
/** The judge transport a runtime supplies: system text plus transcript in, model reply out. */
export type Judge = (system: string, transcript: string) => Promise<string>
/** Where a runtime keeps the audited marker and the pending feedback note. */
export type AuditStore = {
  lastAudited: () => string
  markAudited: (messageID: string) => void
  readPending: () => string
  writePending: (text: string) => void
  clearPending: () => void
  /** Violation rules already delivered to this session, so none is ever sent twice. */
  deliveredRules?: () => string[]
  markDeliveredRules?: (rules: string[]) => void
}
/** Everything one audit attempt needs; paths, clock and transports are injected so tests need no mocks. */
export type AuditOptions = {
  sessionID: string
  msgs: Msg[]
  messageID: string
  rules: () => string
  judge: Judge
  maxChars: number
  model: string
  agent: string
  store: AuditStore
  record: (entry: Record<string, unknown>) => void
  notify: (message: string) => void | Promise<void>
  onVerdict?: (verdict: Verdict) => void
  notifyFeedback?: (summary: string) => void | Promise<void>
  extra?: () => Record<string, unknown>
  now?: () => number
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Audit the newest state of a conversation once. A valid verdict marks the message audited; a
 * failure is recorded, notified and left as a `agents-md-guard ERROR:` note, and is retried next time.
 */
export async function auditOnce(options: AuditOptions): Promise<AuditOutcome> {
  const now = options.now ?? Date.now
  if (!options.messageID || !hasAgentWork(options.msgs) || options.store.lastAudited() === options.messageID) return "skipped"

  const base = { model: options.model, agent: options.agent, sessionID: options.sessionID, messageID: options.messageID }
  const started = now()
  const fail = async (error: string, detail = error, extra: Record<string, unknown> = {}): Promise<AuditOutcome> => {
    options.record({ ...base, ...options.extra?.(), ms: now() - started, error, ...extra })
    await options.notify(`audit failed: ${detail}`)
    const kept = options.store.readPending().split("\n").filter((line) => line && !line.startsWith(ERROR_PREFIX))
    options.store.writePending([...kept, formatError(detail)].join("\n"))
    return "error"
  }

  let rules: string
  try {
    rules = options.rules()
  } catch (err) {
    return fail(`rules unreadable: ${errorText(err)}`)
  }

  const built = buildPrompt(rules, currentTurn(options.msgs), options.maxChars)
  let reply: string
  try {
    reply = await options.judge(built.system, built.transcript)
  } catch (err) {
    return fail(errorText(err))
  }

  const verdict = parseVerdict(reply)
  if (!verdict) {
    return fail("unparseable verdict", `unparseable verdict: ${JSON.stringify(reply.slice(0, 160))}`, { reply: reply.slice(0, 300) })
  }

  // The judge can miss a bare commit or ticket key, so enforce the link rule from the latest reply.
  const detected = requiresLinkedReferences(rules) ? unlinkedReferenceViolation(options.msgs) : null
  const violations = [...(detected ? [detected] : []), ...verdict.violations].filter(
    (violation, index, all) => all.findIndex((other) => other.rule === violation.rule) === index,
  )
  const result: Verdict = violations.length ? { verdict: "FAIL", violations } : { verdict: "PASS", violations: [] }
  options.store.markAudited(options.messageID)
  options.record({ ...base, ...options.extra?.(), ms: now() - started, ...result })
  options.onVerdict?.(result)
  if (result.verdict === "PASS") {
    options.store.clearPending()
    return "pass"
  }
  // Never re-send a violation already delivered: a rule the agent has been told about once is done.
  const already = new Set(options.store.deliveredRules?.() ?? [])
  const fresh = result.violations.filter((violation) => !already.has(violation.rule))
  if (!fresh.length) {
    options.store.clearPending()
    return "pass"
  }
  options.store.markDeliveredRules?.(fresh.map((violation) => violation.rule))
  options.store.writePending(formatFeedback(fresh))
  await options.notifyFeedback?.(`${fresh.length} rule violation(s): ${fresh.map((v) => v.rule).join("; ")}`)
  return "fail"
}
