import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { notify } from "../src/notify"

let log: string
const keys = ["AGENTS_NOTIFY", "AGENTS_NOTIFY_CMD", "AGENTS_NOTIFY_STATE_DIR", "AGENTS_NOTIFY_WINDOW"]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of keys) saved[key] = process.env[key]
  const tmp = mkdtempSync(join(tmpdir(), "notify-"))
  log = join(tmp, "calls.txt")
  const recorder = join(tmp, "rec.sh")
  writeFileSync(recorder, `#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> "${log}"\n`)
  chmodSync(recorder, 0o755)
  delete process.env.AGENTS_NOTIFY
  delete process.env.AGENTS_NOTIFY_WINDOW
  process.env.AGENTS_NOTIFY_CMD = recorder
  process.env.AGENTS_NOTIFY_STATE_DIR = join(tmp, "state")
})

afterEach(() => {
  for (const key of keys) saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key])
})

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])

test("shows the message once per window and toasts through the client", async () => {
  const toasts: any[] = []
  const client = { tui: { showToast: async (arg: any) => void toasts.push(arg) } }
  expect(await notify("turn-check", "audit failed:\n boom", { client })).toBe(true)
  expect(await notify("turn-check", "audit failed: boom", { client })).toBe(false)
  expect(calls()).toEqual(["turn-check|audit failed: boom"])
  expect(toasts[0].body).toMatchObject({ title: "turn-check", message: "audit failed: boom", variant: "error" })
})

test("dedupe false shows a repeated message every time", async () => {
  expect(await notify("turn-check feedback", "1 rule violation(s): a", { dedupe: false })).toBe(true)
  expect(await notify("turn-check feedback", "1 rule violation(s): a", { dedupe: false })).toBe(true)
  expect(calls()).toHaveLength(2)
})

test("can be turned off and never rejects", async () => {
  process.env.AGENTS_NOTIFY = "0"
  expect(await notify("t", "m")).toBe(false)
  delete process.env.AGENTS_NOTIFY
  process.env.AGENTS_NOTIFY_CMD = "/no/such/command"
  expect(await notify("t", "other")).toBe(true)
})
