// Paths and switches for codeindex. Every path is read lazily so tests can set the env vars.
import { homedir } from "node:os"
import { join } from "node:path"

const home = () => process.env.HOME || homedir()

/** Config directory holding `repos`, `index.json` and `index.md`. */
export function configDir(): string {
  return process.env.CODEINDEX_DIR || join(home(), ".agents", "plugins", "codeindex")
}

/** One repo per line: a local path, `owner/repo`, or a git URL. */
export function reposFile(): string {
  return process.env.CODEINDEX_REPOS || join(configDir(), "repos")
}

export function indexFile(): string {
  return process.env.CODEINDEX_INDEX || join(configDir(), "index.json")
}

export function markdownFile(): string {
  return process.env.CODEINDEX_MARKDOWN || join(configDir(), "index.md")
}

/** Clones of the GitHub repos named in `repos`. */
export function cacheDir(): string {
  return process.env.CODEINDEX_CACHE_DIR || join(home(), ".cache", "agents-plugins", "codeindex")
}

/** Decision log. */
export function stateDir(): string {
  return process.env.CODEINDEX_STATE_DIR || join(home(), ".agents", "state", "codeindex")
}

export function enforce(): boolean {
  return process.env.CODEINDEX_ENFORCE === "1"
}

export function disabled(): boolean {
  return process.env.CODEINDEX === "0"
}

/** Index age in days after which every warning says the index is stale. */
export function staleDays(): number {
  const value = Number.parseInt(process.env.CODEINDEX_STALE_DAYS ?? "7", 10)
  return Number.isNaN(value) ? 7 : Math.max(0, value)
}

/** Budget for one hook decision. Past it the hook allows the write. */
export function timeoutMs(): number {
  const value = Number.parseInt(process.env.CODEINDEX_TIMEOUT_MS ?? "150", 10)
  return Number.isNaN(value) ? 150 : Math.max(10, value)
}
