// Detects the push-like commands that arm the CI gate.
import { basename } from "node:path"

export type Git = (repo: string, ...args: string[]) => Promise<string | null>

export type PushHit =
  | { kind: "sign"; dry: boolean }
  | { kind: "push"; repo: string | null; args: string[] }
  | { kind: "stack" }
  | { kind: "post" }

const GH_PR_WRITES = new Set(["create", "comment", "review", "edit", "merge", "close", "reopen", "ready"])
const GH_ISSUE_WRITES = new Set(["create", "comment", "edit", "close", "reopen", "pin", "unpin"])
const GH_RELEASE_WRITES = new Set(["create", "edit", "upload", "delete"])

/** True when `gh api` args write: a GraphQL mutation, a non-GET method, fields or an input file. */
function isApiWrite(args: string[]): boolean {
  const text = args.join(" ")
  if (args[0] === "graphql") return /\bmutation\b/.test(text)
  if (/\b-X\s*(?:POST|PATCH|PUT|DELETE)\b/.test(text)) return true
  if (/--method(?:\s+|=)(?:POST|PATCH|PUT|DELETE)\b/i.test(text)) return true
  return /(?:^|\s)-[fF](?:\s|$)|--(?:raw-)?field(?:\s|=)|--input(?:\s|$)/.test(text)
}

/** Splits a command line on `&&`, `||`, `;` and newlines into trimmed segments. */
export function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n)+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

// A small posix shlex.split; null mirrors Python's ValueError on unbalanced quotes.
function shlexSplit(text: string): string[] | null {
  const tokens: string[] = []
  let current = ""
  let started = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      if (char === "\\" && quote === '"') {
        const next = text[i + 1]
        if (next !== undefined && '"\\$`'.includes(next)) {
          current += next
          i++
          continue
        }
        current += char
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === "\\") {
      if (i + 1 >= text.length) return null
      current += text[++i]
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

/** Classifies one shell segment as a push, a stack push, a signing batch, a GitHub post or nothing. */
export function classify(tokens: string[]): PushHit | null {
  for (const token of tokens) {
    if (basename(token) === "git-sign-batch") {
      return { kind: "sign", dry: tokens.some((token) => token === "--dry-run" || token === "--no-push") }
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const name = basename(tokens[i])
    if (name === "git") {
      let j = i + 1
      let repo: string | null = null
      while (j < tokens.length) {
        if (tokens[j] === "-C" && j + 1 < tokens.length) {
          repo = tokens[j + 1]
          j += 2
          continue
        }
        if (tokens[j].startsWith("-")) {
          j++
          continue
        }
        break
      }
      if (j < tokens.length && tokens[j] === "push") {
        return { kind: "push", repo, args: tokens.slice(j + 1) }
      }
    }
    if (name === "gh" && i + 1 < tokens.length) {
      const sub = tokens[i + 1]
      const verb = tokens[i + 2]
      if (sub === "pr" && verb && GH_PR_WRITES.has(verb)) return { kind: "post" }
      if (sub === "issue" && verb && GH_ISSUE_WRITES.has(verb)) return { kind: "post" }
      if (sub === "release" && verb && GH_RELEASE_WRITES.has(verb)) return { kind: "post" }
      if (sub === "api" && isApiWrite(tokens.slice(i + 2))) return { kind: "post" }
      if (
        sub === "stack" &&
        i + 2 < tokens.length &&
        ["push", "submit", "link"].includes(tokens[i + 2])
      ) {
        return { kind: "stack" }
      }
    }
  }
  return null
}

/** The push-like commands in a command line, each with the segment that carried it. */
export function pushHits(command: string): Array<{ segment: string; hit: PushHit }> {
  const hits: Array<{ segment: string; hit: PushHit }> = []
  for (const segment of splitSegments(command)) {
    const hit = classify(shlexSplit(segment) ?? segment.split(/\s+/))
    if (hit) hits.push({ segment, hit })
  }
  return hits
}

// A fast pre-filter for the adapters: it matches the command at a segment start, unlike `pushHits`, so
// `echo git push` is not treated as a push and the recorder never runs on a read.
const PUSH =
  /(?:^|[;&|\n]\s*)(?:[^\s;&|]*\/)?(?:git\s+(?:-C\s+\S+\s+)?push|gh\s+stack\s+(?:push|submit|link)|git-sign-batch|gh\s+pr\s+(?:create|comment|review|edit|merge|close|reopen|ready)|gh\s+issue\s+(?:create|comment|edit|close|reopen|pin|unpin)|gh\s+release\s+(?:create|edit|upload|delete))\b/
const GH_API = new RegExp("(?:^|[;&|\\n]\\s*)(?:[^\\s;&|]*/)?gh\\s+api\\b")
const API_WRITE =
  /(?:\s-X\s*(?:POST|PATCH|PUT|DELETE)\b|\s--method[ =](?:POST|PATCH|PUT|DELETE)\b|\s-[fF]\s|\s--(?:raw-)?field[ =]|\s--input\b)/i

/** True when a command commits, pushes or writes to GitHub. */
export function isPushCommand(command: unknown): boolean {
  if (typeof command !== "string") return false
  if (PUSH.test(command)) return true
  if (!GH_API.test(command)) return false
  if (/gh\s+api\s+graphql\b/.test(command)) return /\bmutation\b/.test(command)
  return API_WRITE.test(command)
}

/** Branches named by a `git push` command line. */
export async function pushBranches(
  repo: string,
  args: string[],
  git: Git,
  currentBranch: (repo: string) => Promise<string | null>,
): Promise<string[]> {
  const remotes = new Set((await git(repo, "remote"))?.split(/\s+/).filter(Boolean) ?? [])
  const branches: string[] = []
  let seenRemote = false
  for (const token of args) {
    if (token.startsWith("-")) continue
    if (!seenRemote && remotes.has(token)) {
      seenRemote = true
      continue
    }
    const separator = token.indexOf(":")
    const source = separator === -1 ? token : token.slice(0, separator)
    let branch = separator === -1 ? source : token.slice(separator + 1) || source
    if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length)
    if (branch === "HEAD") branch = (await currentBranch(repo)) ?? ""
    if (branch && !branches.includes(branch)) branches.push(branch)
  }
  return branches
}
