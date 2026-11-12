// Score a new declaration against the index. The rules are deliberately boring:
// same name, two shared meaningful tokens, or a known house pattern.
import { bodyHash, bodySimilarity, bodyTokens } from "./body"
import type { Index, IndexSymbol } from "./index"
import type { Decl } from "./scan"

export type Match = {
  reason: "name" | "tokens" | "pattern" | "body" | "body-similar"
  score: number
  label?: string
  name: string
  kind: string
  recv?: string
  package: string
  repo: string
  file: string
  line: number
  uses: number
  repos: number
  site?: string
  doc?: string
}

const STOP = new Set([
  "a", "an", "and", "as", "at", "base", "be", "by", "client", "close", "common", "config",
  "context", "create", "ctx", "data", "default", "delete", "do", "err", "error", "errors",
  "for", "from", "get", "handle", "handler", "id", "ids", "in", "init", "into", "is", "item",
  "items", "list", "main", "make", "mock", "mocks", "new", "not", "of", "on", "open", "option",
  "options", "or", "read", "run", "server", "service", "set", "settings", "start", "stop",
  "string", "test", "tests", "the", "to", "type", "types", "update", "util", "utils", "value",
  "values", "with", "without", "write",
])

/** Split camelCase, acronyms, snake_case and kebab-case into lowercase meaningful tokens. */
export function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !STOP.has(token))
}

const PATTERNS: { label: string; test: RegExp; packages: string[] }[] = [
  { label: "publish an event to Kafka", test: /producer|publish|emit/i, packages: ["kafka/producer"] },
  { label: "run a Kafka consumer", test: /consumer|subscribe/i, packages: ["kafka/consumer"] },
  { label: "write the message outbox", test: /outbox|persistence/i, packages: ["kafka/persistence"] },
  { label: "define or consume an event type", test: /event/i, packages: ["kafka/events"] },
  { label: "service-to-service HMAC auth", test: /hmac/i, packages: ["auth/hmac"] },
  { label: "read-through cache", test: /readthrough/i, packages: ["cache/readthrough"] },
  { label: "metrics, dashboards, panels", test: /telemetry|prometheus|metric/i, packages: ["telemetry"] },
  { label: "rate limit a gRPC method", test: /ratelimit|rate.?limit/i, packages: ["service-utils/grpc_utils/ratelimit"] },
  { label: "consume an SQS queue", test: /sqs/i, packages: ["aws-clients/sqs_consumer", "aws-clients/sqs"] },
  { label: "tenant manifest or cache", test: /tenant/i, packages: ["tenants", "tenants-cache"] },
  { label: "Postgres client or health", test: /postgres|pgutils|pgx/i, packages: ["postgres-utils/pgutils"] },
  { label: "time or UUID source", test: /uuid|clock/i, packages: ["service-utils/generators"] },
  { label: "Splunk audit log", test: /splunk|audit/i, packages: ["service-utils/audit_logs/splunk"] },
  { label: "map an error to a gRPC status", test: /grpc.*(error|status)|common.?error/i, packages: ["service-utils/common_errors"] },
]

const overlap = (left: string[], right: string[]) => {
  const rightSet = new Set(right)
  return left.filter((token) => rightSet.has(token))
}

const toMatch = (symbol: IndexSymbol, reason: Match["reason"], score: number, label?: string): Match => ({
  reason,
  score,
  label,
  name: symbol.name,
  kind: symbol.kind,
  recv: symbol.recv,
  package: symbol.package,
  repo: symbol.repo,
  file: symbol.file,
  line: symbol.line,
  uses: symbol.uses,
  repos: symbol.repos,
  site: symbol.site,
  doc: symbol.doc,
})

/** Best existing declarations for one new declaration. At most three, best first. */
export function matchDecl(index: Index, decl: Decl, file: { repo?: string; package?: string }, lang?: string): Match[] {
  const wanted = tokens(decl.name)
  const bag = bodyTokens(decl.body, decl.name)
  const hash = bag.length >= 8 ? bodyHash(decl.body, decl.name) : undefined
  if (!wanted.length && !hash) return []
  const matches: Match[] = []
  const own = (symbol: IndexSymbol) =>
    file.repo !== undefined && symbol.repo === file.repo && (file.package === undefined || symbol.package === file.package)

  for (const symbol of index.symbols) {
    if (own(symbol)) continue

    if (hash && symbol.bodyHash === hash && (!lang || symbol.lang === lang)) {
      matches.push(toMatch(symbol, "body", 200))
      continue
    }
    if (bag.length >= 8 && symbol.bodyTokens?.length && (!lang || symbol.lang === lang)) {
      const { shared, score } = bodySimilarity(bag, symbol.bodyTokens)
      if (shared >= 8 && score >= 0.55) {
        matches.push(toMatch(symbol, "body-similar", 60 + Math.round(score * 50)))
      }
    }

    if (!wanted.length) continue
    if (symbol.name === decl.name) {
      matches.push(toMatch(symbol, "name", 100 + Math.min(symbol.uses, 50)))
      continue
    }
    const shared = overlap(wanted, tokens(symbol.name))
    if (shared.length >= 2 && shared.some((token) => token.length >= 4) && shared.length / Math.max(wanted.length, 1) >= 0.5) {
      matches.push(toMatch(symbol, "tokens", 10 * shared.length + Math.min(symbol.uses, 20) / 10))
    }
  }

  if (wanted.length >= 2 || decl.name.length >= 8) {
    for (const pattern of PATTERNS) {
      if (!pattern.test.test(decl.name)) continue
      const pkg = index.packages.find(
        (row) => pattern.packages.includes(row.path) || pattern.packages.some((path) => row.path.endsWith(`/${path}`)),
      )
      if (!pkg) continue
      const candidates = index.symbols.filter((row) => row.repo === pkg.repo && row.package === pkg.path)
      const relevance = (symbol: IndexSymbol) => overlap(wanted, tokens(symbol.name)).length * 10 + (symbol.uses ? 1 : 0)
      const symbol = candidates.sort((a, b) => relevance(b) - relevance(a) || b.uses - a.uses)[0]
      if (symbol) matches.push(toMatch(symbol, "pattern", 40 + Math.min(symbol.uses, 20), pattern.label))
    }
  }

  const seen = new Set<string>()
  return matches
    .sort((a, b) => b.score - a.score || b.uses - a.uses)
    .filter((match) => {
      const key = `${match.repo}:${match.package}:${match.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 3)
}

export function describeMatch(match: Match): string {
  const recv = match.recv ? `${match.recv}.` : ""
  const where = `${match.repo} ${match.package || "."}`
  const usage = match.uses
    ? `, used ${match.uses} times across ${match.repos} ${match.repos === 1 ? "repo" : "repos"}${match.site ? ` (e.g. ${match.site})` : ""}`
    : ", not referenced yet"
  const why = match.reason === "pattern" ? `house pattern: ${match.label}; ` : match.reason === "name" ? "same name; " : match.reason === "body" ? "same implementation; " : match.reason === "body-similar" ? "similar implementation; " : "similar name; "
  const doc = match.doc ? ` ${match.doc.replace(/[.!?]$/, "")}.` : ""
  return `${why}\`${recv}${match.name}\` already exists in ${where} (${match.file}:${match.line}${usage}).${doc}`
}
