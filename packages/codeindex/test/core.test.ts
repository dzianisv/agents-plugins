import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { decide } from "../src/core/decide"
import { buildIndex, loadIndex, renderMarkdown, writeIndex } from "../src/core/index"
import { matchDecl, tokens } from "../src/core/match"
import { parseRepoLine } from "../src/core/repos"
import { declsOf, newDecls } from "../src/core/scan"
import { shellTargets } from "../src/core/shell"

let tmp: string
let lib: string
let svc: string
let indexFile: string

const file = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const goMod = (root: string, name: string) => file(join(root, "go.mod"), `module ${name}\n\ngo 1.22\n`)

const producer = `package producer

import (
	"context"
	"fmt"
)

// Producer publishes events.
type Producer struct {
	client    Client
	metrics   Metrics
	topicName string
}

// Publish sends one event and returns when the broker accepts it.
func (p *Producer) Publish(ctx context.Context, event string) error {
	payload := encodeNotification(event)
	if err := p.client.Send(ctx, p.topicName, payload); err != nil {
		p.metrics.PublishErrors.Inc()
		return fmt.Errorf("publish %s: %w", p.topicName, err)
	}
	p.metrics.PublishedTotal.Inc()
	return nil
}

func (p *Producer) send(ctx context.Context, event string) error {
	return nil
}

const (
	// DefaultTopic is where events go.
	DefaultTopic = "events"
	internal     = "hidden"
)

func helper() {}
func NewProducer() *Producer { return &Producer{} }
`

const consumer = `package main

import "example.com/lib/kafka/producer"

func ConsumerOnly() {}

func use(p *producer.Producer) {
	p.Publish(nil, "one")
	_ = producer.DefaultTopic
}
`

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeindex-"))
  lib = join(tmp, "lib")
  svc = join(tmp, "svc")
  indexFile = join(tmp, "config", "index.json")
  goMod(lib, "example.com/lib")
  goMod(svc, "example.com/svc")
  file(join(lib, "kafka", "producer", "producer.go"), producer)
  file(join(svc, "main.go"), consumer)
  process.env.CODEINDEX_DIR = join(tmp, "config")
  process.env.CODEINDEX_INDEX = indexFile
  process.env.CODEINDEX_MARKDOWN = join(tmp, "config", "index.md")
  process.env.CODEINDEX_STATE_DIR = join(tmp, "state")
  process.env.CODEINDEX_CACHE_DIR = join(tmp, "cache")
  process.env.CODEINDEX_TIMEOUT_MS = "1000"
  delete process.env.CODEINDEX_ENFORCE
  delete process.env.CODEINDEX
  process.env.AGENTS_NOTIFY = "0"
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.CODEINDEX_ENFORCE
  delete process.env.CODEINDEX
})

const specs = () => [
  { name: "lib", kind: "local" as const, source: lib, path: lib, role: "source" as const },
  { name: "svc", kind: "local" as const, source: svc, path: svc, role: "consumer" as const },
]

const build = () => {
  const result = buildIndex({ specs: specs(), sync: false })
  writeIndex(result.index, indexFile, process.env.CODEINDEX_MARKDOWN!)
  return result
}

describe("scan", () => {
  test("finds exported Go declarations and skips unexported ones", () => {
    const decls = declsOf(producer, "go")
    expect(decls.map((decl) => decl.name)).toEqual(["Producer", "Publish", "DefaultTopic", "NewProducer"])
    expect(decls.find((decl) => decl.name === "Publish")?.kind).toBe("method")
    expect(decls.find((decl) => decl.name === "Publish")?.recv).toBe("Producer")
    expect(decls.find((decl) => decl.name === "Producer")?.kind).toBe("struct")
    expect(decls.find((decl) => decl.name === "Publish")?.doc).toContain("sends one event")
  })

  test("compares before and after by kind and name", () => {
    const before = "package main\n\ntype A struct{}\n"
    const after = `${before}\nfunc NewB() {}\n`
    expect(newDecls(before, after, "go").map((decl) => decl.name)).toEqual(["NewB"])
    expect(newDecls(after, after, "go")).toEqual([])
  })

  test("finds exported TypeScript and public Python declarations", () => {
    expect(declsOf("export async function NewClient() {}\nconst hidden = 1\n", "ts").map((decl) => decl.name)).toEqual(["NewClient"])
    expect(declsOf("def public_fn():\n    pass\n\ndef _private():\n    pass\n", "py").map((decl) => decl.name)).toEqual(["public_fn"])
  })
})

describe("repos", () => {
  test("parses local paths, comments and GitHub slugs", () => {
    expect(parseRepoLine("# note")).toBeUndefined()
    expect(parseRepoLine("")).toBeUndefined()
    expect(parseRepoLine(lib)?.kind).toBe("local")
    const remote = parseRepoLine("acme/widgets")
    expect(remote?.kind).toBe("remote")
    expect(remote?.url).toBe("https://github.com/acme/widgets.git")
    expect(remote?.path.endsWith("acme__widgets")).toBe(true)
    expect(parseRepoLine(`uses ${lib}`)?.role).toBe("consumer")
  })
})

describe("shell writes", () => {
  test("reads a heredoc, a redirect and tee", () => {
    const heredoc = shellTargets(`cat > handler.go <<'EOF'\npackage main\n\nfunc NewKafkaProducer() {}\nEOF`, svc)
    expect(heredoc).toHaveLength(1)
    expect(heredoc[0].file).toBe(join(svc, "handler.go"))
    expect(heredoc[0].after).toContain("NewKafkaProducer")
    expect(shellTargets("printf hi > a.go", svc)[0].op).toBe("shell-unknown")
    expect(shellTargets("tee -a b.go", svc)[0].file).toBe(join(svc, "b.go"))
    expect(shellTargets("go build ./... > /dev/null", svc)).toEqual([])
  })
})

describe("index", () => {
  test("builds symbols, packages and real call sites", () => {
    const { index } = build()
    expect(index.version).toBe(1)
    expect(index.symbols.some((symbol) => symbol.name === "Publish")).toBe(true)
    expect(index.symbols.some((symbol) => symbol.name === "helper")).toBe(false)
    expect(index.symbols.find((symbol) => symbol.name === "Publish")?.package).toBe("kafka/producer")
    expect(index.symbols.find((symbol) => symbol.name === "Publish")?.import).toBe("example.com/lib/kafka/producer")
    const publish = index.symbols.find((symbol) => symbol.name === "Publish")!
    expect(publish.uses).toBeGreaterThanOrEqual(1)
    expect(publish.site).toContain("svc/main.go")
    expect(index.symbols.some((symbol) => symbol.name === "ConsumerOnly")).toBe(false)
    expect(loadIndex(indexFile)?.symbols.length).toBe(index.symbols.length)
  })

  test("writes markdown and an atomic JSON file", () => {
    build()
    expect(existsSync(indexFile)).toBe(true)
    expect(readFileSync(process.env.CODEINDEX_MARKDOWN!, "utf8")).toContain("Most reused packages")
    expect(renderMarkdown(loadIndex(indexFile)!)).toContain("codeindex")
  })
})

describe("match", () => {
  test("tokenizes camel case and drops generic words", () => {
    expect(tokens("NewKafkaProducer")).toEqual(["kafka", "producer"])
    expect(tokens("Config")).toEqual([])
    expect(tokens("HTTPServerOptions")).toEqual(["http"])
  })

  test("matches an exact name and a house pattern", () => {
    const { index } = build()
    const exact = matchDecl(index, { name: "Publish", kind: "func", sig: "", line: 1 }, { repo: "svc" })
    expect(exact[0]?.reason).toBe("name")
    const pattern = matchDecl(index, { name: "NewKafkaProducer", kind: "func", sig: "", line: 1 }, { repo: "svc" })
    expect(pattern.some((match) => match.reason === "pattern" && match.package === "kafka/producer")).toBe(true)
  })

  test("matches a renamed copy by body", () => {
    const { index } = build()
    const copy = `package main

func (p *Producer) SendNotification(ctx context.Context, event string) error {
	payload := encodeNotification(event)
	if err := p.client.Send(ctx, p.topicName, payload); err != nil {
		p.metrics.PublishErrors.Inc()
		return fmt.Errorf("publish %s: %w", p.topicName, err)
	}
	p.metrics.PublishedTotal.Inc()
	return nil
}
`
    const decl = declsOf(copy, "go").find((item) => item.name === "SendNotification")!
    const matches = matchDecl(index, decl, { repo: "svc" }, "go")
    expect(matches[0]?.reason).toBe("body")
    expect(matches[0]?.package).toBe("kafka/producer")
  })

  test("matches a near copy by body tokens", () => {
    const { index } = build()
    const copy = `package main

func (p *Producer) SendNotification(ctx context.Context, event string) error {
	payload := encodeNotificationV2(event)
	if err := p.client.Send(ctx, p.topicName, payload); err != nil {
		p.metrics.PublishErrors.Inc()
		return fmt.Errorf("publish %s: %w", p.topicName, err)
	}
	p.metrics.PublishedTotal.Inc()
	return nil
}
`
    const decl = declsOf(copy, "go").find((item) => item.name === "SendNotification")!
    const matches = matchDecl(index, decl, { repo: "svc" }, "go")
    expect(matches[0]?.reason).toBe("body-similar")
  })

  test("ignores the same repo and a generic name", () => {
    const { index } = build()
    expect(matchDecl(index, { name: "Publish", kind: "func", sig: "", line: 1 }, { repo: "lib" })).toEqual([])
    expect(matchDecl(index, { name: "Config", kind: "type", sig: "", line: 1 }, { repo: "svc" })).toEqual([])
  })
})

describe("decide", () => {
  const target = (name: string, text: string) => ({ file: join(svc, name), before: "", after: text, op: "write" })

  test("warns by default, denies when enforcing, and logs both", () => {
    build()
    const write = target("handler.go", "package main\n\nfunc NewKafkaProducer() {}\n")
    const warn = decide(write, "test")
    expect(warn.action).toBe("warn")
    expect(warn.message).toContain("kafka/producer")
    process.env.CODEINDEX_ENFORCE = "1"
    expect(decide(write, "test").action).toBe("deny")
    expect(readFileSync(join(tmp, "state", "decisions.jsonl"), "utf8")).toContain('"action":"warn"')
  })

  test("allows tests, generated files, overrides and no new declarations", () => {
    build()
    expect(decide(target("handler_test.go", "package main\n\nfunc NewKafkaProducer() {}\n"), "test").action).toBe("allow")
    expect(decide(target("gen.go", "// Code generated by x. DO NOT EDIT.\n\nfunc NewKafkaProducer() {}\n"), "test").reason).toBe("generated file")
    expect(decide({ file: join(lib, "kafka", "producer", "more.go"), before: "", after: "package producer\n\nfunc Publish() {}\n", op: "write" }, "test").reason).toBe("no match")
    expect(decide(target("ok.go", "package main\n\n// codeindex:ok a different wire protocol\nfunc NewKafkaProducer() {}\n"), "test").reason).toBe("codeindex:ok")
    expect(decide(target("plain.go", "package main\n\nfunc local() {}\n"), "test").reason).toBe("no new exported declaration")
    process.env.CODEINDEX_ENFORCE = "1"
    expect(decide({ file: join(svc, "made.go"), before: "", after: "", op: "shell-unknown" }, "test").action).toBe("deny")
    delete process.env.CODEINDEX_ENFORCE
    expect(decide({ file: join(svc, "made.go"), before: "", after: "", op: "shell-unknown" }, "test").action).toBe("warn")
    process.env.CODEINDEX = "0"
    expect(decide(target("handler.go", "package main\n\nfunc NewKafkaProducer() {}\n"), "test").reason).toBe("disabled")
  })

  test("fails open without an index", () => {
    const decision = decide(target("handler.go", "package main\n\nfunc NewKafkaProducer() {}\n"), "test")
    expect(decision.action).toBe("allow")
    expect(decision.reason).toBe("no index")
  })
})
