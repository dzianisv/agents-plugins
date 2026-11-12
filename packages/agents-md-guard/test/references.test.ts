import { describe, expect, test } from "bun:test"
import { auditOnce, type AuditStore } from "../src/core/audit"
import type { Msg } from "../src/core/prompt"

const RULE =
  "Every reference to a code location, commit, PR or Jira ticket is a clickable link in chat, Jira, Slack, PR text, review replies and documents."
const PASS = '{"verdict":"PASS","violations":[]}'
const LINK_RULE = "Every reference to a code location, commit, PR or Jira ticket is a clickable link"

const msg = (id: string, role: string, text: string): Msg => ({ info: { id, role }, parts: [{ type: "text", text }] })

async function audit(reply: string, answer: string) {
  let pending = ""
  const store: AuditStore = {
    lastAudited: () => "",
    markAudited: () => {},
    readPending: () => pending,
    writePending: (text) => {
      pending = text
    },
    clearPending: () => {
      pending = ""
    },
  }
  const outcome = await auditOnce({
    sessionID: "s1",
    msgs: [msg("u1", "user", "what is left?"), msg("a1", "assistant", answer)],
    messageID: "a1",
    rules: () => RULE,
    judge: async () => reply,
    maxChars: 60000,
    model: "test/model",
    agent: "test",
    store,
    record: () => {},
    notify: () => {},
  })
  return { outcome, pending }
}

describe("unlinked references", () => {
  test("a bare commit and ticket fail even when the judge says PASS", async () => {
    const { outcome, pending } = await audit(PASS, "Pushed e3ede00 for PROJ-3142; both are ready.")
    expect(outcome).toBe("fail")
    expect(pending).toContain(LINK_RULE)
    expect(pending).toContain("e3ede00")
    expect(pending).toContain("PROJ-3142")
  })

  test("linked references, code spans, code blocks and URLs do not fail", async () => {
    const answer = [
      "Pushed [e3ede00](https://github.com/acme/widgets/commit/e3ede00) for [PROJ-3142](https://example.atlassian.net/browse/PROJ-3142).",
      "Run `git show e3ede00` to inspect it.",
      "```sh",
      "gh pr view 460 --repo acme/widgets",
      "```",
      "See https://github.com/acme/widgets/pull/460.",
    ].join("\n")
    const { outcome, pending } = await audit(PASS, answer)
    expect(outcome).toBe("pass")
    expect(pending).toBe("")
  })
})
