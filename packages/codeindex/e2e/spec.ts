// e2e spec: a new exported Go function that duplicates a small indexed library must be denied.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defineSpec } from "../../../scripts/e2e/spec"

const DUPLICATE = "package main\n\nfunc NewKafkaProducer() {}\n"

export default defineSpec({
  plugin: "codeindex",
  runtimes: ["claude", "opencode"],
  prompt: `Create the file handler.go in the current directory with exactly this content:\n\n${DUPLICATE}\nThen reply DONE.`,
  claude: { allowedTools: ["Write", "Edit"], maxTurns: 3 },
  env: { CODEINDEX_ENFORCE: "1", AGENTS_NOTIFY: "0" },
  setup: (ctx) => {
    const lib = join(ctx.home, "lib")
    mkdirSync(join(lib, "kafka", "producer"), { recursive: true })
    writeFileSync(join(lib, "go.mod"), "module example.com/lib\n")
    writeFileSync(
      join(lib, "kafka", "producer", "producer.go"),
      "package producer\n\n// Producer publishes events.\ntype Producer struct{}\n\n// Publish sends one event.\nfunc (p *Producer) Publish(event string) error { return nil }\n",
    )
    const config = join(ctx.home, ".agents", "plugins", "codeindex")
    mkdirSync(config, { recursive: true })
    writeFileSync(join(config, "repos"), `${lib}\n`)
    const build = spawnSync("bun", [join(ctx.repo, "packages", "codeindex", "bin", "codeindex"), "build"], {
      env: {
        ...process.env,
        HOME: ctx.home,
        CODEINDEX_DIR: config,
        CODEINDEX_INDEX: join(config, "index.json"),
        CODEINDEX_MARKDOWN: join(config, "index.md"),
      },
      encoding: "utf8",
    })
    if (build.status !== 0) throw new Error(`codeindex build failed: ${build.stderr}`)
    const svc = join(ctx.home, "svc")
    mkdirSync(svc, { recursive: true })
    return svc
  },
  checks: [
    {
      name: "denied the duplicate declaration",
      run: (ctx) => {
        const file = join(ctx.home, ".agents", "state", "codeindex", "decisions.jsonl")
        let entries: { action?: string; file?: string; ms?: number }[]
        try {
          entries = readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        } catch {
          return { ok: false, detail: `no decision log at ${file}` }
        }
        const denied = entries.find((entry) => entry.action === "deny" && entry.file?.endsWith("handler.go"))
        if (!denied) return { ok: false, detail: `no deny for handler.go (${entries.length} entries)` }
        return { ok: true, detail: `denied in ${denied.ms ?? "?"}ms` }
      },
    },
  ],
})
