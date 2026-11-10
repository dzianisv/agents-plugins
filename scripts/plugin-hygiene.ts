// Hygiene rules for the plugin packages: every failure we hit is checked here so it cannot come back.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export type Finding = { file: string; rule: string; detail: string }

export type Rule = {
  id: string
  /** True when the rule applies to this file's text. */
  applies: (text: string) => boolean
  /** True when the file satisfies the rule. */
  ok: (text: string) => boolean
  detail: string
}

/** Rule 1: a `*_CHILD` env marker may only silence a plugin inside its own judge directory. */
const childFlagScoped: Rule = {
  id: "child-flag-scoped",
  applies: (text) => /[A-Z_]*_CHILD\s*===\s*"1"/.test(text),
  ok: (text) => /isJudgeDir|tmpdir\(\)/.test(text),
  detail: "a leaked *_CHILD flag must not disable the plugin outside the judge's temp dir",
}

/** Rule 2: a gh call must fall back to gh's own auth when an exported token is stale. */
const ghTokenFallback: Rule = {
  id: "gh-token-fallback",
  applies: (text) => /(?:execFile|execFileSync|spawn|spawnSync|run)\(\s*"gh"/.test(text),
  ok: (text) => /GH_TOKEN/.test(text),
  detail: "gh calls need the Bad credentials retry without GH_TOKEN/GITHUB_TOKEN",
}

/** Rule 3: a judge subprocess must retry a transient transport drop. */
const judgeTransientRetry: Rule = {
  id: "judge-transient-retry",
  applies: (text) => /spawn\(\s*"opencode"/.test(text),
  ok: (text) => /TRANSIENT/.test(text),
  detail: "opencode run judges need one retry on a transport or socket drop",
}

/** Rule 4: judge and review timeouts must not be starved below 120 seconds. */
const timeoutFloor: Rule = {
  id: "timeout-floor",
  applies: (text) => /DEFAULT_JUDGE_TIMEOUT(_MS)?\s*=|_TIMEOUT\s*\?\?\s*"\d+"/.test(text),
  ok: (text) => {
    const checks: boolean[] = []
    const ms = /DEFAULT_JUDGE_TIMEOUT_MS\s*=\s*(\d+)/.exec(text)
    if (ms) checks.push(Number(ms[1]) >= 120_000)
    const seconds = /DEFAULT_JUDGE_TIMEOUT\s*=\s*(\d+)/.exec(text)
    if (seconds) checks.push(Number(seconds[1]) >= 120)
    for (const match of text.matchAll(/_TIMEOUT\s*\?\?\s*"(\d+)"/g)) checks.push(Number(match[1]) >= 120)
    return checks.length > 0 && checks.every(Boolean)
  },
  detail: "a judge or review timeout below 120 seconds starves slow models",
}

/** Rule 5: anything that pushes text into a session must bound it with the shared injection ceiling. */
const injectionBounded: Rule = {
  id: "injection-bounded",
  applies: (text) => /session\.prompt\(|"decision": ?"block"|decision: "block"/.test(text),
  ok: (text) => /inject-limit|blocksInWindow|mayInject/.test(text),
  detail: "an injected prompt or stop block must use the shared ceiling (packages/shared/src/inject-limit.ts)",
}

export const RULES: Rule[] = [childFlagScoped, ghTokenFallback, judgeTransientRetry, timeoutFloor, injectionBounded]

/** Every TypeScript source file of the plugin packages, relative to the repo root. */
export function pluginSources(root: string): string[] {
  const files: string[] = []
  const packages = join(root, "packages")
  for (const pkg of readdirSync(packages)) {
    const dirs = [join(packages, pkg, "src")]
    for (const dir of dirs) {
      let entries: string[] = []
      try {
        if (!statSync(dir).isDirectory()) continue
        entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"))
      } catch {
        continue
      }
      for (const name of entries) files.push(join(dir, name))
    }
    // The v2 entries live at the package root and inject too.
    const entry = join(packages, pkg, "server.ts")
    try {
      if (statSync(entry).isFile()) files.push(entry)
    } catch {}
  }
  return files
}

/** Runs every rule over every plugin source file and returns the violations. */
export function scanPluginHygiene(root: string): Finding[] {
  const findings: Finding[] = []
  for (const file of pluginSources(root)) {
    const text = readFileSync(file, "utf8")
    for (const rule of RULES) {
      if (!rule.applies(text) || rule.ok(text)) continue
      findings.push({ file: relative(root, file), rule: rule.id, detail: rule.detail })
    }
  }
  return findings
}

if (process.argv[1]?.endsWith("plugin-hygiene.ts")) {
  const findings = scanPluginHygiene(process.cwd())
  for (const finding of findings) console.error(`${finding.file}: ${finding.rule}: ${finding.detail}`)
  console.log(findings.length ? `${findings.length} hygiene violation(s)` : "plugin hygiene: clean")
  process.exit(findings.length ? 1 : 0)
}
