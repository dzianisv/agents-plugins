// Decide whether a write adds an exported declaration that the index already provides.
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { disabled, enforce as enforceEnv, staleDays, stateDir, timeoutMs } from "./config"
import { loadIndex, type Index } from "./index"
import { describeMatch, matchDecl, type Match } from "./match"
import { isGenerated, languageOf, newDecls, type Decl } from "./scan"
import type { WriteTarget } from "./write"

export type Decision = {
  action: "allow" | "warn" | "deny"
  reason: string
  message?: string
  decls?: string[]
  matches?: Match[]
  ms: number
}

const TEST_FILE = /(?:^|\/)(?:[^/]*_test\.go|[^/]*_test\.py|test_[^/]*\.py|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?)$/
const SKIP_PATH = /(?:^|\/)(?:vendor|node_modules|\.git|testdata|\.worktrees)\//
const OVERRIDE = /codeindex:ok\b/

const locate = (file: string, index: Index): { repo: string; package: string } | undefined => {
  const absolute = resolve(file)
  for (const repo of index.repos) {
    if (!repo.path) continue
    const root = isAbsolute(repo.path) ? repo.path : resolve(repo.path)
    const rel = relative(root, absolute)
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      const dir = dirname(rel)
      return { repo: repo.name, package: dir === "." ? "" : dir.replaceAll("\\", "/") }
    }
  }
  return undefined
}

const daysOld = (builtAt: string): number => Math.max(0, Math.floor((Date.now() - Date.parse(builtAt)) / 86_400_000))

const append = (row: Record<string, unknown>) => {
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(`${stateDir()}/decisions.jsonl`, `${JSON.stringify(row)}\n`)
  } catch {}
}

const label = (decl: Decl) => `${decl.kind} \`${decl.name}\``

/** Reuse verdict for one file write. Never throws: a broken index fails open. */
export function decide(target: WriteTarget, runtime: string): Decision {
  const started = Date.now()
  const done = (action: Decision["action"], reason: string, extra: Partial<Decision> = {}): Decision => {
    const decision = { action, reason, ms: Date.now() - started, ...extra }
    if (decision.decls?.length || action !== "allow" || reason === "timeout") {
      append({
        ts: new Date().toISOString(),
        runtime,
        action,
        file: target.file,
        decls: decision.decls,
        reason,
        match: decision.matches?.[0] && {
          name: decision.matches[0].name,
          repo: decision.matches[0].repo,
          package: decision.matches[0].package,
          why: decision.matches[0].reason,
        },
        ms: decision.ms,
      })
    }
    return decision
  }

  if (disabled()) return done("allow", "disabled")
  const lang = languageOf(target.file)
  if (!lang) return done("allow", "unsupported language")
  if (TEST_FILE.test(target.file)) return done("allow", "test file")
  if (SKIP_PATH.test(target.file)) return done("allow", "vendored or generated path")
  if (isGenerated(target.after)) return done("allow", "generated file")
  if (OVERRIDE.test(target.after)) return done("allow", "codeindex:ok")

  const index = loadIndex()
  if (!index) return done("allow", "no index")
  if (Date.now() - started > timeoutMs()) return done("allow", "timeout")

  if (target.op === "shell-unknown" && !target.before && !target.after) {
    const action = enforceEnv() ? "deny" : "warn"
    const message = `[codeindex] \`${target.file}\` would be created by a shell command, which bypasses the reuse check. Use the write tool, or add "// codeindex:ok <reason>" to the content.`
    return done(action, "shell-write", { message })
  }

  const decls = newDecls(target.before, target.after, lang)
  if (!decls.length) return done("allow", "no new exported declaration")
  if (Date.now() - started > timeoutMs()) return done("allow", "timeout", { decls: decls.map(label) })

  const where = locate(target.file, index)
  const matches = decls.flatMap((decl) => matchDecl(index, decl, where ?? {}, lang)).slice(0, 3)
  const names = decls.map(label)
  if (!matches.length) return done("allow", "no match", { decls: names })

  const age = daysOld(index.builtAt)
  const stale = age > staleDays() ? ` The index is ${age} days old; run \`codeindex build\`.` : ""
  const lines = [`[codeindex] reuse check: ${names.join(", ")}.`]
  for (const match of matches) lines.push(`- ${describeMatch(match)}`)
  lines.push('Reuse the existing code, or add "// codeindex:ok <reason>" if this is genuinely different.')

  const action = enforceEnv() ? "deny" : "warn"
  return done(action, matches[0].reason, { message: lines.join("\n") + stale, decls: names, matches })
}
