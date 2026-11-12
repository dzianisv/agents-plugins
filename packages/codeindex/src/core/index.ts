// Build and load the JSON index. One file in memory is enough: the hook scores a few
// thousand names in microseconds, so there is no database.
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { bodyHash, bodyTokens } from "./body"
import { indexFile, markdownFile } from "./config"
import { readRepoSpecs, syncRepo, type RepoSpec } from "./repos"
import { declsOf, isGenerated, languageOf } from "./scan"

export type IndexSymbol = {
  name: string
  kind: string
  recv?: string
  package: string
  import?: string
  repo: string
  file: string
  line: number
  sig: string
  doc?: string
  lang: string
  bodyHash?: string
  bodyTokens?: string[]
  uses: number
  repos: number
  site?: string
}

export type IndexRepo = {
  name: string
  path: string
  url?: string
  commit?: string
  commitDate?: string
  files: number
  symbols: number
  error?: string
  role?: "source" | "consumer"
}

export type IndexPackage = {
  path: string
  repo: string
  symbols: number
  uses: number
  doc?: string
}

export type Index = {
  version: 1
  builtAt: string
  generator: string
  repos: IndexRepo[]
  packages: IndexPackage[]
  symbols: IndexSymbol[]
}

export type BuildOptions = {
  specs?: RepoSpec[]
  sync?: boolean
}

export type BuildResult = {
  index: Index
  errors: string[]
  ms: number
}

const SKIP_DIR = new Set([
  ".git", ".hg", ".svn", ".worktrees", ".cache", ".venv", "venv", "__pycache__", ".tox",
  "node_modules", "vendor", "dist", "build", "out", "target", "coverage", "mocks",
  "testdata", ".next", ".nuxt", "site-packages", "Pods", ".idea", ".vscode",
])

const SKIP_FILE = /(?:^|\/)(?:[^/]*_test\.go|test_[^/]*\.py|[^/]*_test\.py|[^/]*\.(?:test|spec)\.[cm]?[jt]sx?|[^/]*\.min\.js|[^/]*\.d\.ts)$/
const USAGE_SKIP_FILE = /(?:^|\/)(?:[^/]*\.min\.js|[^/]*\.d\.ts)$/

const git = (path: string, ...args: string[]) =>
  spawnSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 15_000 }).stdout?.trim() || undefined

const walk = (root: string, visit: (abs: string, rel: string) => void) => {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) stack.push(abs)
      } else if (entry.isFile()) {
        visit(abs, relative(root, abs))
      }
    }
  }
}

const moduleCache = new Map<string, { module: string; dir: string } | undefined>()

const goModule = (repo: string, file: string): { module: string; dir: string } | undefined => {
  let dir = dirname(file)
  const chain: string[] = []
  while (dir === repo || dir.startsWith(`${repo}/`)) {
    if (moduleCache.has(dir)) {
      const hit = moduleCache.get(dir)
      for (const item of chain) moduleCache.set(item, hit)
      return hit
    }
    chain.push(dir)
    const mod = join(dir, "go.mod")
    if (existsSync(mod)) {
      try {
        const line = readFileSync(mod, "utf8").split("\n").find((row) => row.startsWith("module "))
        if (line) {
          const hit = { module: line.slice(7).trim(), dir }
          for (const item of chain) moduleCache.set(item, hit)
          return hit
        }
      } catch {}
    }
    if (dir === repo) break
    dir = dirname(dir)
  }
  for (const item of chain) moduleCache.set(item, undefined)
  return undefined
}

const read = (file: string): string | undefined => {
  try {
    if (statSync(file).size > 512 * 1024) return undefined
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

const importPath = (repo: string, file: string, lang: string): string | undefined => {
  if (lang !== "go") return undefined
  const mod = goModule(repo, file)
  if (!mod) return undefined
  const suffix = relative(mod.dir, dirname(file)).replaceAll("\\", "/")
  return suffix ? `${mod.module}/${suffix}` : mod.module
}

type Uses = { uses: number; repos: Set<string>; site?: string }
type UseScan = { usage: Map<string, Uses>; files: Map<string, number> }

const scanUses = (repos: RepoSpec[], symbols: IndexSymbol[]): UseScan => {
  const names = new Set(symbols.map((symbol) => symbol.name))
  const declarations = new Set(symbols.map((symbol) => `${symbol.repo}|${symbol.file}|${symbol.line}`))
  const declaredIn = new Map<string, Set<string>>()
  for (const symbol of symbols) {
    const set = declaredIn.get(symbol.name) ?? new Set<string>()
    set.add(symbol.repo)
    declaredIn.set(symbol.name, set)
  }
  const uses = new Map<string, Uses>()
  const files = new Map<string, number>()
  const isTest = (site: string) => /_test\.go|\.test\.|test_/.test(site)
  const better = (current: string | undefined, next: string, name: string, test: boolean) => {
    if (test) return false
    if (!current) return true
    if (isTest(current) && !isTest(next)) return true
    if (isTest(next) && !isTest(current)) return false
    const own = declaredIn.get(name) ?? new Set<string>()
    const currentOwn = [...own].some((repoName) => current.startsWith(`${repoName}/`))
    const nextOwn = [...own].some((repoName) => next.startsWith(`${repoName}/`))
    return currentOwn && !nextOwn
  }

  for (const repo of repos) {
    walk(repo.path, (abs, rel) => {
      const lang = languageOf(abs)
      if (!lang || USAGE_SKIP_FILE.test(rel)) return
      const text = read(abs)
      if (!text || isGenerated(text)) return
      files.set(repo.name, (files.get(repo.name) ?? 0) + 1)
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (declarations.has(`${repo.name}|${rel}|${i + 1}`)) continue
        const tokens = lines[i].match(/[A-Za-z_$][\w$]*/g)
        if (!tokens) continue
        for (const token of tokens) {
          if (!names.has(token)) continue
          const entry = uses.get(token) ?? { uses: 0, repos: new Set<string>() }
          entry.uses++
          entry.repos.add(repo.name)
          const test = /_test\.go|\.test\.|test_/.test(rel)
          const site = `${repo.name}/${rel}:${i + 1}`
          if (!entry.site || better(entry.site, site, token, test)) entry.site = site
          uses.set(token, entry)
        }
      }
    })
  }
  return { usage: uses, files }
}

/** Scan the configured repos and return the index. Does not write anything. */
export function buildIndex(options: BuildOptions = {}): BuildResult {
  const started = Date.now()
  const specs = options.specs ?? readRepoSpecs()
  const errors: string[] = []
  const repos: IndexRepo[] = []
  const symbols: IndexSymbol[] = []
  const packages = new Map<string, IndexPackage>()
  const usable: RepoSpec[] = []

  moduleCache.clear()
  for (const spec of specs) {
    const error = options.sync === false ? undefined : syncRepo(spec)
    if (error && !existsSync(spec.path)) {
      errors.push(error)
      repos.push({ name: spec.name, path: spec.path, url: spec.url, files: 0, symbols: 0, error, role: spec.role })
      continue
    }
    if (error) errors.push(error)
    if (!existsSync(spec.path)) continue
    usable.push(spec)

    const commit = git(spec.path, "rev-parse", "--short", "HEAD")
    const commitDate = git(spec.path, "log", "-1", "--format=%cI")
    repos.push({
      name: spec.name,
      path: spec.path,
      url: spec.url,
      commit,
      commitDate,
      files: 0,
      symbols: 0,
      error,
      role: spec.role,
    })
  }

  for (const spec of usable.filter((item) => item.role === "source")) {
    const repo = repos.find((item) => item.name === spec.name && item.path === spec.path)
    let files = 0
    let count = 0
    walk(spec.path, (abs, rel) => {
      const lang = languageOf(abs)
      if (!lang || SKIP_FILE.test(rel)) return
      const text = read(abs)
      if (!text || isGenerated(text)) return
      files++
      const declarations = declsOf(text, lang)
      if (!declarations.length) return
      const pkgPath = dirname(rel) === "." ? "" : dirname(rel).replaceAll("\\", "/")
      for (const decl of declarations) {
        const bag = bodyTokens(decl.body, decl.name)
        symbols.push({
          name: decl.name,
          kind: decl.kind,
          recv: decl.recv,
          package: pkgPath,
          import: importPath(spec.path, abs, lang),
          repo: spec.name,
          file: rel.replaceAll("\\", "/"),
          line: decl.line,
          sig: decl.sig,
          doc: decl.doc,
          lang,
          bodyHash: bag.length >= 8 ? bodyHash(decl.body, decl.name) : undefined,
          bodyTokens: bag.length >= 8 ? bag.slice(0, 60) : undefined,
          uses: 0,
          repos: 0,
        })
        count++
      }
    })
    if (repo) {
      repo.files = files
      repo.symbols = count
    }
  }

  const { usage, files } = scanUses(usable, symbols)
  for (const repo of repos) {
    if (repo.role === "consumer") repo.files = files.get(repo.name) ?? 0
  }
  for (const symbol of symbols) {
    const entry = usage.get(symbol.name)
    symbol.uses = entry?.uses ?? 0
    symbol.repos = entry?.repos.size ?? 0
    symbol.site = entry?.site
    const key = `${symbol.repo}:${symbol.package}`
    const pkg = packages.get(key) ?? { path: symbol.package, repo: symbol.repo, symbols: 0, uses: 0 }
    pkg.symbols++
    if (symbol.uses > 0) pkg.uses++
    pkg.doc ||= symbol.doc
    packages.set(key, pkg)
  }

  symbols.sort((a, b) => a.repo.localeCompare(b.repo) || a.package.localeCompare(b.package) || a.name.localeCompare(b.name))
  const index: Index = {
    version: 1,
    builtAt: new Date().toISOString(),
    generator: "codeindex/0.1.0",
    repos,
    packages: [...packages.values()].sort((a, b) => b.uses - a.uses || b.symbols - a.symbols),
    symbols,
  }
  return { index, errors, ms: Date.now() - started }
}

export function renderMarkdown(index: Index): string {
  const lines: string[] = []
  lines.push("# codeindex")
  lines.push("")
  lines.push(`generated ${index.builtAt} · ${index.repos.length} repos · ${index.packages.length} packages · ${index.symbols.length} exported symbols`)
  lines.push("")
  lines.push("Read this before writing a helper. If a symbol already exists here, reuse it.")
  lines.push("")
  lines.push("## Repos")
  lines.push("")
  lines.push("| repo | role | commit | files | symbols |")
  lines.push("|---|---|---|---|---|")
  for (const repo of index.repos) {
    lines.push(`| \`${repo.name}\` | ${repo.role ?? "source"} | ${repo.commit ?? "?"} | ${repo.files} | ${repo.symbols} |`)
  }
  lines.push("")
  lines.push("## Most reused packages")
  lines.push("")
  lines.push("| package | repo | symbols | used symbols |")
  lines.push("|---|---|---|---|")
  for (const pkg of [...index.packages].sort((a, b) => b.uses - a.uses).slice(0, 40)) {
    lines.push(`| \`${pkg.path || "."}\` | \`${pkg.repo}\` | ${pkg.symbols} | ${pkg.uses} |`)
  }
  lines.push("")
  lines.push("## Most used symbols")
  lines.push("")
  lines.push("| symbol | kind | package | refs | doc |")
  lines.push("|---|---|---|---|---|")
  for (const symbol of [...index.symbols].sort((a, b) => b.uses - a.uses).slice(0, 120)) {
    const doc = (symbol.doc ?? "").replaceAll("|", "/").slice(0, 90)
    lines.push(`| \`${symbol.name}\` | ${symbol.kind} | \`${symbol.repo}/${symbol.package}\` | ${symbol.uses} | ${doc} |`)
  }
  lines.push("")
  return lines.join("\n")
}

const writeAtomic = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body)
  renameSync(tmp, path)
}

export function writeIndex(index: Index, out = indexFile(), markdown = markdownFile()): void {
  writeAtomic(out, JSON.stringify(index))
  writeAtomic(markdown, renderMarkdown(index))
}

type Cache = { path: string; mtimeMs: number; size: number; index: Index }
let cache: Cache | undefined

/** Load the index, cached until the file changes. Undefined when missing or unreadable. */
export function loadIndex(path = indexFile()): Index | undefined {
  try {
    const stat = statSync(path)
    if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.index
    const index = JSON.parse(readFileSync(path, "utf8")) as Index
    if (index?.version !== 1 || !Array.isArray(index.symbols)) return undefined
    cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, index }
    return index
  } catch {
    return undefined
  }
}
