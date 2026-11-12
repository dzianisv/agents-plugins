#!/usr/bin/env node
/**
 * auto-limit-resume doctor.
 *
 * Answers "will the resume plugin actually work right now?" with facts:
 *   1. is the installed plugin identical to this repo's version?
 *   2. is the config valid, and is the state file sane?
 *   3. does every configured fallback model answer a trivial request?
 *
 * Run: npm run doctor:auto-limit
 * Exit code 1 when the plugin is stale, the config is invalid, or no fallback
 * model answers (in that case the plugin can only wait for the limit to reset).
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repoPlugin = join(root, "opencode-auto-limit-nudge.ts")
const installedPlugin = join(homedir(), ".config", "opencode", "plugin", "opencode-auto-limit-nudge.ts")
const configPath = join(homedir(), ".config", "opencode", "auto-limit-resume.json")
const cacheDir = join(homedir(), ".cache", "opencode-auto-limit-resume")
const statePath = join(cacheDir, "state.json")
const eventsPath = join(cacheDir, "events.jsonl")

const problems = []
const note = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`)
  if (!ok) problems.push(label)
}

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")

// 1. installed plugin matches the repo
if (!existsSync(installedPlugin)) {
  note(false, "plugin installed", `${installedPlugin} missing`)
} else {
  const same = sha(repoPlugin) === sha(installedPlugin)
  note(same, "installed plugin matches repo", same ? installedPlugin : "reinstall: cp opencode-auto-limit-nudge.ts ~/.config/opencode/plugin/")
}

// 2. config
let config = {}
try {
  config = JSON.parse(readFileSync(configPath, "utf8"))
  note(true, "config parses", configPath)
} catch (error) {
  note(false, "config parses", `${configPath}: ${error.message}`)
}

if (config.enabled === false) note(false, "plugin enabled", "enabled is false")
if (process.env.OPENCODE_AUTO_LIMIT_RESUME_DISABLED === "1") note(false, "kill switch", "OPENCODE_AUTO_LIMIT_RESUME_DISABLED=1")
const fallbacks = Array.isArray(config.fallbackModels) ? config.fallbackModels : []
const providers = new Set(fallbacks.map((entry) => String(entry).split("/")[0]))
note(fallbacks.length > 0, "fallbacks configured", fallbacks.join(", ") || "none: the plugin can only retry the same model")
note(providers.size > 1, "fallbacks span more than one provider", [...providers].join(", ") || "none")
note(Number(config.injectPerWindow ?? 3) > 0, "injection ceiling set", String(config.injectPerWindow ?? "default 3"))
note(Number(config.rePromptMs ?? 1_800_000) > 0, "re-prompt cooldown set", `${Math.round(Number(config.rePromptMs ?? 1_800_000) / 60_000)} min per model`)

// 3. state and trail
try {
  const state = JSON.parse(readFileSync(statePath, "utf8"))
  const pending = Object.keys(state.sessions ?? {})
  note(true, "state file parses", `${pending.length} pending resume(s)`)
  for (const id of pending) {
    const entry = state.sessions[id]
    const next = entry.nextAt ? new Date(entry.nextAt).toLocaleString() : "?"
    console.log(`     ${id} attempts=${entry.attempts} reason=${entry.reason} next=${next} model=${entry.switchedTo ?? entry.failedModelID ?? "?"}`)
  }
} catch {
  note(true, "state file", "none (no pending resumes)")
}

try {
  const rows = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).slice(-8)
    .map((line) => JSON.parse(line))
  console.log("  last events:")
  for (const row of rows) console.log(`     ${row.time} ${row.event} ${row.sessionID ?? ""} ${row.reason ?? ""}`)
} catch {
  console.log("  last events: none yet")
}

// 4. do the fallbacks actually answer?
const probe = (model) =>
  new Promise((resolve) => {
    // execFile gives the child a pipe stdin, which makes `opencode run` exit 130.
    // stdin must be ignored for a headless probe.
    const child = spawn("opencode", ["run", "-m", model, "reply with exactly: ok"], {
      cwd: process.env.TMPDIR || "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      const text = `${out}\n${err}`
      const limited = /usage limit|quota|rate.?limit|429|not licensed|unauthorized|revoked|no longer supports|overloaded/i.test(text)
      const detail = text
        .split("\n")
        .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
        .filter((line) => /error|limit|quota|licensed|unauthorized|revoked|overloaded/i.test(line))
        .at(-1)
      if (code !== 0) return resolve({ model, ok: false, detail: (detail ?? `exit ${code}`).slice(0, 140) })
      resolve({ model, ok: !limited, detail: limited ? (detail ?? "limited").slice(0, 140) : "answered" })
    })
  })

const results = []
for (const model of fallbacks) results.push(await probe(model))
const reachable = results.filter((row) => row.ok)
for (const row of results) {
  if (row.ok) console.log(`PASS fallback ${row.model} :: ${row.detail}`)
  else console.log(`WARN fallback ${row.model} :: ${row.detail} (not usable right now, skipped at runtime)`)
}
note(reachable.length > 0, "at least one fallback answers", reachable.map((row) => row.model).join(", ") || "all configured fallbacks are limited or unauthorized")

console.log(`\n${problems.length === 0 ? "READY: a limit failure will be resumed on a working model" : `${problems.length} problem(s): ${problems.join("; ")}`}`)
process.exit(problems.length === 0 ? 0 : 1)
