import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildIndex, writeIndex } from "../src/core/index"

const packageDir = join(import.meta.dir, "..")
let tmp: string
let lib: string
let svc: string
let env: NodeJS.ProcessEnv

const file = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeindex-hooks-"))
  lib = join(tmp, "lib")
  svc = join(tmp, "svc")
  file(join(lib, "go.mod"), "module example.com/lib\n")
  file(join(lib, "kafka", "producer", "producer.go"), "package producer\n\n// Producer publishes events.\ntype Producer struct{}\n\n// Publish sends one event.\nfunc (p *Producer) Publish(event string) error { return nil }\n")
  file(join(svc, "go.mod"), "module example.com/svc\n")
  const index = buildIndex({
    specs: [
      { name: "lib", kind: "local", source: lib, path: lib, role: "source" },
      { name: "svc", kind: "local", source: svc, path: svc, role: "consumer" },
    ],
    sync: false,
  }).index
  writeIndex(index, join(tmp, "config", "index.json"), join(tmp, "config", "index.md"))
  env = {
    ...process.env,
    CODEINDEX_DIR: join(tmp, "config"),
    CODEINDEX_INDEX: join(tmp, "config", "index.json"),
    CODEINDEX_MARKDOWN: join(tmp, "config", "index.md"),
    CODEINDEX_STATE_DIR: join(tmp, "state"),
    CODEINDEX_CACHE_DIR: join(tmp, "cache"),
    CODEINDEX_TIMEOUT_MS: "1000",
    AGENTS_NOTIFY: "0",
  }
  delete env.CODEINDEX_ENFORCE
  delete env.CODEINDEX
  for (const [key, value] of Object.entries(env)) process.env[key] = value
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.CODEINDEX_ENFORCE
})

const writeEvent = () => ({
  tool: "write",
  sessionID: "s1",
  input: { filePath: join(svc, "handler.go"), content: "package main\n\nfunc NewKafkaProducer() {}\n" },
})

describe("opencode v2 server", () => {
  const setup = async () => {
    const hooks = new Map<string, (event: any) => Promise<any>>()
    const ctx = { location: { directory: svc }, tool: { hook: async (name: string, fn: any) => hooks.set(name, fn) } }
    const dispose = await (await import("../server")).default.setup(ctx)
    return { hooks, dispose }
  }

  test("denies when enforcing and allows when warning", async () => {
    const { hooks, dispose } = await setup()
    const before = hooks.get("execute.before")!
    process.env.CODEINDEX_ENFORCE = "1"
    await expect(before(writeEvent())).rejects.toThrow("kafka/producer")
    await expect(
      before({
        tool: "bash",
        sessionID: "s1",
        input: { command: "cat > handler.go <<'EOF'\npackage main\n\nfunc NewKafkaProducer() {}\nEOF" },
      }),
    ).rejects.toThrow("kafka/producer")
    delete process.env.CODEINDEX_ENFORCE
    const event = writeEvent()
    await expect(before(event)).resolves.toBe(event)
    await expect(before({ tool: "read", input: {} })).resolves.toBeDefined()
    dispose?.()
  })
})

describe("opencode v1 plugin", () => {
  test("throws on a duplicate when enforcing", async () => {
    process.env.CODEINDEX_ENFORCE = "1"
    const { CodeIndex } = await import("../src/opencode/plugin")
    const hooks = (await CodeIndex({ client: {}, directory: svc } as any)) as any
    await expect(
      hooks["tool.execute.before"]({ tool: "edit", callID: "c1", sessionID: "s1" }, {
        args: { filePath: join(svc, "handler.go"), content: "package main\n\nfunc NewKafkaProducer() {}\n" },
      }),
    ).rejects.toThrow("kafka/producer")
  })
})

describe("Claude Code hook", () => {
  const hook = (payload: unknown, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [join(packageDir, "src", "claude", "pretooluse.ts")], {
      input: JSON.stringify(payload),
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 20_000,
    })

  const payload = () => ({
    cwd: svc,
    tool_name: "Write",
    tool_input: { file_path: join(svc, "handler.go"), content: "package main\n\nfunc NewKafkaProducer() {}\n" },
  })

  const bashPayload = () => ({
    cwd: svc,
    tool_name: "Bash",
    tool_input: { command: "cat > handler.go <<'EOF'\npackage main\n\nfunc NewKafkaProducer() {}\nEOF" },
  })

  test("denies with the reuse message", () => {
    const result = hook(payload(), { CODEINDEX_ENFORCE: "1" })
    const output = JSON.parse(String(result.stdout))
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("kafka/producer")
  })

  test("denies a shell redirect that writes the same file", () => {
    const result = hook(bashPayload(), { CODEINDEX_ENFORCE: "1" })
    const output = JSON.parse(String(result.stdout))
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("kafka/producer")
  })

  test("warns through systemMessage", () => {
    const result = hook(payload())
    const output = JSON.parse(String(result.stdout))
    expect(output.systemMessage).toContain("kafka/producer")
    expect(output.hookSpecificOutput).toBeUndefined()
  })

  test("ignores a read tool", () => {
    const result = hook({ cwd: svc, tool_name: "Read", tool_input: { file_path: join(svc, "handler.go") } })
    expect(String(result.stdout).trim()).toBe("")
  })
})
