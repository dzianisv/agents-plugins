// Body fingerprints for duplicate detection that does not depend on the declaration name.
import { createHash } from "node:crypto"

const STOP = new Set([
  "and", "append", "args", "async", "await", "bool", "break", "byte", "case", "catch", "chan",
  "class", "const", "continue", "ctx", "data", "default", "defer", "def", "delete", "else",
  "err", "error", "errors", "export", "fallthrough", "false", "fmt", "for", "from", "func",
  "function", "go", "goto", "if", "import", "in", "int", "int32", "int64", "interface", "is",
  "item", "items", "key", "keys", "len", "let", "list", "log", "make", "map", "msg", "name",
  "new", "nil", "not", "null", "ok", "opts", "option", "options", "or", "package", "range",
  "res", "req", "return", "select", "self", "string", "struct", "switch", "this", "throw",
  "time", "true", "try", "type", "uint", "uint64", "undefined", "value", "values", "var",
  "void", "while", "with",
])

const words = (text: string): string[] =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, " ")
    .match(/[A-Za-z_][A-Za-z0-9_]{2,}/g)?.map((word) => word.toLowerCase()) ?? []

const nameTokens = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean)

/** Distinctive body and doc tokens. The declaration name is removed, so a rename does not change them. */
export function bodyTokens(body: string | undefined, name: string): string[] {
  if (!body) return []
  const own = new Set([...nameTokens(name), name.toLowerCase()])
  return [...new Set(words(body).filter((word) => !STOP.has(word) && !own.has(word)))]
}

/** Stable hash of the normalized body, with the declaration name removed. */
export function bodyHash(body: string | undefined, name: string): string | undefined {
  if (!body) return undefined
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const normalized = body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(new RegExp(`\\b${escaped}\\b`, "g"), "")
    .replace(/\s+/g, " ")
    .trim()
  return normalized ? createHash("sha1").update(normalized).digest("hex").slice(0, 16) : undefined
}

/** Shared tokens and Jaccard score. */
export function bodySimilarity(left: string[], right: string[]): { shared: number; score: number } {
  if (!left.length || !right.length) return { shared: 0, score: 0 }
  const a = new Set(left)
  const b = new Set(right)
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return { shared, score: shared / (a.size + b.size - shared) }
}
