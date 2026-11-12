#!/usr/bin/env bun
// codeindex command line: build the index, inspect it, and check one file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { indexFile, markdownFile, reposFile } from "./core/config"
import { decide } from "./core/decide"
import { buildIndex, loadIndex, writeIndex } from "./core/index"
import { readRepoSpecs } from "./core/repos"

const argv = process.argv.slice(2)
const command = argv[0] ?? "help"

const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const has = (name: string): boolean => argv.includes(`--${name}`)

const template = `# One repo per line. A local path, owner/repo, or a git URL.
# Plain lines are indexed; "uses <path>" repos only lend their call sites.
# ~/workspace/widgets
# uses ~/workspace/account-registry-service
# acme/widgets
`

const build = () => {
  if (!existsSync(reposFile())) {
    mkdirSync(dirname(reposFile()), { recursive: true })
    writeFileSync(reposFile(), template)
    console.log(`created ${reposFile()}; add a repo line and run again`)
    process.exitCode = 1
    return
  }
  const specs = readRepoSpecs()
  if (!specs.length) {
    console.log(`no repos in ${reposFile()}; add one line per repo`)
    process.exitCode = 1
    return
  }
  const out = flag("out") ?? indexFile()
  const md = flag("md") ?? markdownFile()
  const result = buildIndex({ specs, sync: !has("no-sync") })
  writeIndex(result.index, out, md)
  const symbols = result.index.symbols.length
  const packages = result.index.packages.length
  console.log(`wrote ${out}`)
  console.log(`wrote ${md}`)
  console.log(`${result.index.repos.length} repos, ${packages} packages, ${symbols} exported symbols in ${result.ms}ms`)
  for (const repo of result.index.repos) {
    console.log(`  ${repo.name} ${repo.commit ?? "?"} ${repo.files} files ${repo.symbols} symbols${repo.error ? ` (${repo.error})` : ""}`)
  }
  for (const error of result.errors) console.error(`warning: ${error}`)
}

const read = (path: string): string => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

const check = () => {
  const file = flag("file")
  if (!file) {
    console.error("usage: codeindex check --file <path> [--content <path|->]")
    process.exitCode = 2
    return
  }
  const content = flag("content")
  const disk = read(file)
  const after = content === "-" ? readFileSync(0, "utf8") : content ? read(content) : disk
  const before = content ? disk : ""
  const decision = decide({ file, before, after, op: "check" }, "cli")
  console.log(`${decision.action}: ${decision.reason} (${decision.ms}ms)`)
  if (decision.message) console.log(decision.message)
  if (decision.action === "deny") process.exitCode = 1
}

const list = () => {
  const index = loadIndex()
  if (!index) {
    console.error(`no index at ${indexFile()}; run codeindex build`)
    process.exitCode = 1
    return
  }
  const query = (argv[1] && !argv[1].startsWith("--") ? argv[1] : "").toLowerCase()
  const repo = flag("repo")
  const kind = flag("kind")
  const limit = Number.parseInt(flag("limit") ?? "40", 10)
  const rows = index.symbols
    .filter((symbol) => (!query || symbol.name.toLowerCase().includes(query)))
    .filter((symbol) => (!repo || symbol.repo.includes(repo)))
    .filter((symbol) => (!kind || symbol.kind === kind))
    .slice(0, Number.isNaN(limit) ? 40 : limit)
  for (const symbol of rows) {
    console.log(`${symbol.repo}/${symbol.package} ${symbol.kind} ${symbol.name} ${symbol.file}:${symbol.line} uses=${symbol.uses}`)
  }
  console.log(`${rows.length} shown, ${index.symbols.length} total`)
}

const repos = () => {
  const specs = readRepoSpecs()
  if (!specs.length) console.log(`no repos in ${reposFile()}`)
  for (const spec of specs) console.log(`${spec.kind}\t${spec.role}\t${existsSync(spec.path) ? "ok" : "missing"}\t${spec.name}\t${spec.path}`)
}

const uses = () => {
  const index = loadIndex()
  const name = argv[1]
  if (!index || !name) {
    console.error("usage: codeindex uses <symbol>")
    process.exitCode = 1
    return
  }
  const rows = index.symbols.filter((symbol) => symbol.name === name)
  for (const symbol of rows) {
    console.log(`${symbol.repo}/${symbol.package} ${symbol.kind} ${symbol.file}:${symbol.line} uses=${symbol.uses} repos=${symbol.repos}${symbol.site ? ` e.g. ${symbol.site}` : ""}`)
  }
  if (!rows.length) {
    console.error(`not found: ${name}`)
    process.exitCode = 1
  }
}

const help = () => {
  console.log(`codeindex - reuse index for exported code

  codeindex build [--no-sync] [--out FILE] [--md FILE]
  codeindex check --file PATH [--content PATH|-]
  codeindex list [query] [--repo NAME] [--kind KIND] [--limit N]
  codeindex uses NAME
  codeindex repos

Config: ${reposFile()}
Index:  ${indexFile()}
Guard:  CODEINDEX_ENFORCE=1 blocks a write, default warns
`)
}

if (command === "build") build()
else if (command === "check") check()
else if (command === "list") list()
else if (command === "uses") uses()
else if (command === "repos") repos()
else help()
