// Live isolated opencode test. Starts a private server with a temp HOME, an opencode.json that loads
// only codeindex, a temp library index, and a real model. Asserts the duplicate write is denied.
//
//   bun run test:live
//   CODEINDEX_LIVE_MODEL=provider/model bun run test:live
//   CODEINDEX_LIVE_KEEP=1 bun run test:live   keep the temp dir and server log
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { availableModel } from "../../../scripts/e2e/model"
import { buildIndex, writeIndex } from "../src/core/index"

const packageDir = dirname(import.meta.dir)
const chosen = availableModel(process.env.CODEINDEX_LIVE_MODEL)
const keep = process.env.CODEINDEX_LIVE_KEEP === "1"
const timeoutMs = Number.parseInt(process.env.CODEINDEX_LIVE_TIMEOUT ?? "120000", 10)

const fail = (message: string): never => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))))
    })
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const root = mkdtempSync(join(tmpdir(), "codeindex-live-"))
const home = join(root, "home")
const lib = join(root, "lib")
const svc = join(root, "svc")
const config = join(home, ".agents", "plugins", "codeindex")
const configFile = join(home, ".config", "opencode", "opencode.json")
const logFile = join(root, "opencode.log")
const decisions = join(home, ".agents", "state", "codeindex", "decisions.jsonl")
const handler = join(svc, "handler.go")
const bashHandler = join(svc, "handler2.go")

mkdirSync(join(lib, "kafka", "producer"), { recursive: true })
mkdirSync(svc, { recursive: true })
mkdirSync(join(home, ".config", "opencode"), { recursive: true })
mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true })
mkdirSync(config, { recursive: true })

writeFileSync(join(lib, "go.mod"), "module example.com/lib\n")
writeFileSync(
  join(lib, "kafka", "producer", "producer.go"),
  `package producer

import (
	"context"
	"fmt"
)

type Producer struct {
	client    Client
	metrics   Metrics
	topicName string
}

func (p *Producer) Publish(ctx context.Context, event string) error {
	payload := encodeNotification(event)
	if err := p.client.Send(ctx, p.topicName, payload); err != nil {
		p.metrics.PublishErrors.Inc()
		return fmt.Errorf("publish %s: %w", p.topicName, err)
	}
	p.metrics.PublishedTotal.Inc()
	return nil
}
`,
)
writeFileSync(join(config, "repos"), `${lib}\n`)

const built = buildIndex({
  specs: [{ name: "lib", kind: "local", source: lib, path: lib, role: "source" }],
  sync: false,
})
writeIndex(built.index, join(config, "index.json"), join(config, "index.md"))

// Keep the real provider credentials, but nothing else from the user's config.
let provider: unknown
try {
  const real = JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "opencode.json"), "utf8")) as {
    provider?: unknown
  }
  provider = real.provider
} catch {}
if (!provider) fail("no provider block in ~/.config/opencode/opencode.json; cannot run a real model")

const auth = join(homedir(), ".local", "share", "opencode", "auth.json")
if (existsSync(auth)) copyFileSync(auth, join(home, ".local", "share", "opencode", "auth.json"))

writeFileSync(
  configFile,
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: chosen.model,
      permission: { "*": "allow" },
      provider,
      plugins: [packageDir],
    },
    null,
    2,
  ),
)

const port = await freePort()
let server: ChildProcess | undefined
const output: string[] = []
const cleanup = () => {
  server?.kill("SIGTERM")
  if (!keep) rmSync(root, { recursive: true, force: true })
}
process.on("exit", cleanup)

server = spawn("opencode", ["serve", "--port", String(port), "--print-logs"], {
  cwd: svc,
  env: {
    ...process.env,
    HOME: home,
    CODEINDEX_ENFORCE: "1",
    CODEINDEX_TIMEOUT_MS: "1000",
    AGENTS_NOTIFY: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
server.stdout?.on("data", (chunk) => output.push(String(chunk)))
server.stderr?.on("data", (chunk) => output.push(String(chunk)))
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") fail("opencode is not on PATH")
  fail(`cannot start opencode: ${error.message}`)
})

const log = () => output.join("")
const deadline = Date.now() + timeoutMs
const waitFor = async (probe: () => boolean, what: string) => {
  while (Date.now() < deadline) {
    if (probe()) return
    await sleep(250)
  }
  writeFileSync(logFile, log())
  fail(`timed out waiting for ${what}; log: ${logFile}`)
}

await waitFor(() => /server password \S+/.test(log()), "the server password")
const password = /server password (\S+)/.exec(log())![1]
const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const api = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: authHeader, "content-type": "application/json", ...(init.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`)
  return response.json() as Promise<any>
}
const session = await api("/api/session", {
  method: "POST",
  body: JSON.stringify({ model: { providerID: chosen.providerID, id: chosen.id } }),
})
const sessionID = session?.data?.id
if (typeof sessionID !== "string") fail("session create returned no id")

const renamed = `package main

type Notifier struct {
	client    Client
	metrics   Metrics
	topicName string
}

func (p *Notifier) SendNotification(ctx context.Context, event string) error {
	payload := encodeNotification(event)
	if err := p.client.Send(ctx, p.topicName, payload); err != nil {
		p.metrics.PublishErrors.Inc()
		return fmt.Errorf("publish %s: %w", p.topicName, err)
	}
	p.metrics.PublishedTotal.Inc()
	return nil
}
`

const text = [
  "Use the write tool to create handler.go in the current directory with exactly this content:",
  "",
  renamed,
  "",
  "Do not change it. Then reply DONE.",
].join("\n")
await api(`/api/session/${sessionID}/prompt`, { method: "POST", body: JSON.stringify({ text }) })

await waitFor(() => existsSync(decisions) && readFileSync(decisions, "utf8").includes('"action":"deny"'), "a deny decision")
const rows = readFileSync(decisions, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { action?: string; file?: string; ms?: number })
const denied = rows.find((row) => row.action === "deny" && row.file?.endsWith("handler.go"))
if (!denied) fail(`no deny for handler.go in ${decisions}`)
// Give the model time to try another write path after the deny.
await sleep(10_000)
if (existsSync(handler)) fail(`handler.go was written despite the deny: ${readFileSync(handler, "utf8")}`)

// The bypass we found: a shell redirect instead of the write tool.
const bashSession = await api("/api/session", {
  method: "POST",
  body: JSON.stringify({ model: { providerID: chosen.providerID, id: chosen.id } }),
})
const bashSessionID = bashSession?.data?.id
if (typeof bashSessionID !== "string") fail("bash session create returned no id")
const bashText = [
  "Run exactly this bash command in the current directory:",
  "",
  "cat > handler2.go <<'EOF'",
  renamed,
  "EOF",
  "",
  "Do not change it. Then reply DONE.",
].join("\n")
await api(`/api/session/${bashSessionID}/prompt`, { method: "POST", body: JSON.stringify({ text: bashText }) })
await waitFor(
  () => existsSync(decisions) && readFileSync(decisions, "utf8").includes("handler2.go") && readFileSync(decisions, "utf8").includes('"action":"deny"'),
  "a deny for the shell redirect",
)
await sleep(10_000)
if (existsSync(bashHandler)) fail(`handler2.go was written despite the shell deny: ${readFileSync(bashHandler, "utf8")}`)

const loaded = [...log().matchAll(/msg="loading plugin" id=([^ \n]+)/g)].map((match) => match[1])
const foreign = [...new Set(loaded)].filter((id) => !id.includes(packageDir))
if (foreign.length) fail(`isolated server loaded other plugins: ${foreign.join(", ")}`)
if (!loaded.length) fail("server never logged a plugin load")

console.log(`PASS: isolated opencode loaded only codeindex, denied the write in ${denied?.ms ?? "?"}ms and the shell redirect`)
if (keep) console.log(`kept ${root}`)
server.kill("SIGTERM")
process.exit(0)
