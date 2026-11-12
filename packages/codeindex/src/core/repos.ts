// Read the repos file and turn each line into a local checkout.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { cacheDir, reposFile } from "./config"

export type RepoSpec = {
  name: string
  source: string
  kind: "local" | "remote"
  path: string
  url?: string
  /** `source` is indexed; `consumer` is scanned for call sites only. */
  role: "source" | "consumer"
}

const CONSUMER = /^(?:uses|consumer)(?::\s*|\s+)/

const expand = (path: string): string => {
  if (path === "~") return process.env.HOME || path
  if (path.startsWith("~/")) return join(process.env.HOME || "", path.slice(2))
  return path
}

const githubSlug = (line: string): string | undefined => {
  const plain = /^([\w.-]+)\/([\w.-]+)$/.exec(line)
  if (plain) return `${plain[1]}/${plain[2].replace(/\.git$/, "")}`
  const url = /^(?:https?:\/\/|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(line)
  if (url) return `${url[1]}/${url[2]}`
  return undefined
}

/** One repos-file line to a spec, or undefined for a blank or comment line. */
export function parseRepoLine(raw: string): RepoSpec | undefined {
  let line = raw.replace(/\s+#.*$/, "").trim()
  if (!line || line.startsWith("#")) return undefined
  const role = CONSUMER.test(line) ? "consumer" satisfies RepoSpec["role"] : "source"
  if (role === "consumer") line = line.replace(CONSUMER, "").trim()

  const local = expand(line).replace(/\/+$/, "")
  if (!/^(?:https?:\/\/|git@)/.test(line) && existsSync(local)) {
    return { name: basename(local), source: line, kind: "local", path: local, role }
  }

  const slug = githubSlug(line)
  if (slug) {
    const url = /^(?:https?:\/\/|git@)/.test(line) ? line : `https://github.com/${slug}.git`
    return { name: slug, source: line, kind: "remote", path: join(cacheDir(), slug.replace("/", "__")), url, role }
  }

  return { name: basename(local), source: line, kind: "local", path: local, role }
}

export function readRepoSpecs(file = reposFile()): RepoSpec[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line: string) => parseRepoLine(line))
    .filter((spec: RepoSpec | undefined): spec is RepoSpec => Boolean(spec))
}

const run = (args: string[], timeout = 120_000) =>
  spawnSync("git", args, { encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 })

/** Clone or fast-forward a remote repo. Returns a warning when the local copy stays stale. */
export function syncRepo(spec: RepoSpec): string | undefined {
  if (spec.kind === "local") {
    return existsSync(spec.path) ? undefined : `missing repo: ${spec.source}`
  }
  if (existsSync(join(spec.path, ".git"))) {
    const pulled = run(["-C", spec.path, "pull", "--ff-only", "--depth", "1", "--quiet"])
    return pulled.status === 0 ? undefined : `pull failed for ${spec.name}, using the local copy`
  }
  const cloned = run(["clone", "--depth", "1", "--quiet", spec.url ?? spec.source, spec.path])
  return cloned.status === 0 ? undefined : `clone failed for ${spec.name}: ${String(cloned.stderr).trim()}`
}
