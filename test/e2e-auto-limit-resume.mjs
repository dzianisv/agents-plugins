/**
 * End-to-end test for opencode-auto-limit-resume.
 *
 * Runs the REAL opencode binary against a local fake OpenAI-compatible
 * provider that returns a quota error, then serves a normal completion. The
 * plugin must notice the failure, switch to the configured fallback model,
 * and continue the same session with no human input.
 *
 * Run: npm run test:auto-limit
 * Keep artifacts: KEEP=1 npm run test:auto-limit
 */

import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { Socket } from "node:net"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(new URL(".", import.meta.url)))
const pluginPath = join(root, "opencode-auto-limit-nudge.ts")
const base = mkdtempSync(join(tmpdir(), "auto-limit-e2e-"))
const keep = process.env.KEEP === "1"

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`)
  if (!ok) failures.push(label)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function provider(failFirst) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      let model
      try {
        model = JSON.parse(body).model
      } catch {}
      requests.push({ at: Date.now(), model, url: req.url })
      if (requests.length <= failFirst) {
        res.writeHead(429, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: {
              message: "Free usage limit reached. Subscribe to OpenCode Go to keep going.",
              type: "insufficient_quota",
              code: "quota",
            },
          }),
        )
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.write(chunk({ role: "assistant", content: "resumed-ok" }, null))
      res.write(chunk({}, "stop"))
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }))
  })
}

function project(name) {
  const dir = join(base, name)
  mkdirSync(join(dir, "proj"), { recursive: true })
  mkdirSync(join(dir, "config", "opencode", "plugin"), { recursive: true })
  mkdirSync(join(dir, "data"), { recursive: true })
  mkdirSync(join(dir, "cache"), { recursive: true })
  copyFileSync(pluginPath, join(dir, "config", "opencode", "plugin", "opencode-auto-limit-nudge.ts"))
  return {
    dir,
    proj: join(dir, "proj"),
    config: join(dir, "config"),
    data: join(dir, "data"),
    events: join(dir, "cache", "events.jsonl"),
    state: join(dir, "cache", "state.json"),
  }
}

function writeConfig(paths, port, resume) {
  writeFileSync(
    join(paths.config, "opencode", "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fake",
            options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test" },
            models: {
              "model-a": { name: "Fake A" },
              "model-b": { name: "Fake B" },
            },
          },
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(join(paths.config, "opencode", "auto-limit-resume.json"), JSON.stringify(resume, null, 2))
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

async function startServer(paths) {
  const port = await freePort()
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: paths.proj,
    env: serverEnv(paths),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout.on("data", (chunk) => (out += chunk))
  child.stderr.on("data", (chunk) => (out += chunk))
  for (let i = 0; i < 100; i++) {
    const ready = await new Promise((resolve) => {
      const socket = new Socket()
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
      socket.connect(port, "127.0.0.1")
    })
    if (ready) return { port, child, log: () => out }
    await sleep(200)
  }
  child.kill("SIGKILL")
  throw new Error(`server did not start: ${out.slice(-500)}`)
}

function serverEnv(paths) {
  return {
    ...process.env,
    OPENCODE_PASSWORD: "auto-limit-test",
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    OPENCODE_AUTO_LIMIT_RESUME_DIR: dirname(paths.events),
    OPENCODE_AUTO_LIMIT_RESUME_CONFIG: join(paths.config, "opencode", "auto-limit-resume.json"),
  }
}

function runOpenCode(paths, port, model, message, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(
      "opencode",
      ["run", "--server", `http://127.0.0.1:${port}`, "-m", model, message],
      {
        cwd: paths.proj,
        env: serverEnv(paths),
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

function trail(paths) {
  try {
    return readFileSync(paths.events, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true
    await sleep(200)
  }
  console.log(`FAIL timeout waiting for ${label}`)
  failures.push(`timeout:${label}`)
  return false
}

async function scenarioSwitch() {
  console.log("\n== scenario: free limit -> switch model -> resume ==")
  const fake = await provider(3)
  const paths = project("switch")
  writeConfig(paths, fake.port, {
    enabled: true,
    notify: false,
    settleMs: 1500,
    baseDelayMs: 1500,
    maxDelayMs: 3000,
    maxAttempts: 5,
    fallbackModels: ["fake/model-b"],
    switchAfterAttempts: 1,
    watchdogMs: 500,
  })

  const server = await startServer(paths)
  const result = await runOpenCode(paths, server.port, "fake/model-a", "say the word ok")
  await waitFor(() => trail(paths).some((r) => r.event === "prompt"), 20_000, "plugin prompt")
  await waitFor(() => fake.requests.filter((r) => r.model === "model-b").length > 0, 20_000, "model-b request")
  await waitFor(() => trail(paths).some((r) => r.event === "clear" && r.reason === "succeeded"), 20_000, "resumed run completion")

  const rows = trail(paths)
  const switched = fake.requests.some((r) => r.model === "model-b")
  check(switched, "fake provider served the fallback model", fake.requests.map((r) => r.model).join(","))
  check(rows.some((r) => r.event === "failure" && r.reason === "free-limit"), "free-limit failure recorded")
  check(rows.some((r) => r.event === "switch" && r.to === "fake/model-b"), "model switch recorded")
  check(rows.some((r) => r.event === "prompt" && r.switched === true), "auto-resume prompt recorded")
  check(rows.some((r) => r.event === "clear" && r.reason === "succeeded"), "resumed run completed")
  check(!existsSync(paths.state) || Object.keys(JSON.parse(readFileSync(paths.state, "utf8")).sessions).length === 0, "pending state cleared after success")
  console.log(`client exit=${result.code} output=${JSON.stringify(result.out.slice(-160))}`)

  fake.server.close()
  server.child.kill("SIGKILL")
  return paths
}

async function scenarioGiveUp() {
  console.log("\n== scenario: limit never clears -> give up, no hang ==")
  const fake = await provider(9_999)
  const paths = project("giveup")
  writeConfig(paths, fake.port, {
    enabled: true,
    notify: false,
    settleMs: 800,
    baseDelayMs: 800,
    maxDelayMs: 1500,
    maxAttempts: 1,
    fallbackModels: [],
    switchAfterAttempts: 1,
    watchdogMs: 500,
  })

  const server = await startServer(paths)
  const started = Date.now()
  const result = await runOpenCode(paths, server.port, "fake/model-a", "say the word ok", 60_000)
  const elapsed = Date.now() - started
  await waitFor(() => trail(paths).some((r) => r.event === "give-up"), 20_000, "give-up record")

  const rows = trail(paths)
  check(elapsed < 60_000, "run terminated instead of hanging", `${elapsed}ms`)
  check(rows.some((r) => r.event === "give-up" && r.reason === "attempts"), "give-up after attempt cap")
  check(/Error/i.test(result.out + result.err), "failure surfaced to the user", (result.out + result.err).slice(-160))

  fake.server.close()
  server.child.kill("SIGKILL")
  return paths
}

const run = async () => {
  console.log(`workdir ${base}`)
  await scenarioSwitch()
  await scenarioGiveUp()

  console.log(`\n${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED: ${failures.join(", ")}`}`)
  if (!keep && failures.length === 0) rmSync(base, { recursive: true, force: true })
  else console.log(`artifacts kept at ${base}`)
  process.exit(failures.length === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
