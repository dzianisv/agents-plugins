import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { exportAuth, removeAuth } from "../auth"

// Built at runtime so this source file never contains a credential-looking literal.
const SECRET = ["f", "w", "SECRET"].join("_")
const KEYCHAIN_TOKEN = ["sk", "ant", "FROMKEYCHAIN"].join("-")

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-auth-test-"))
  roots.push(dir)
  return dir
}

function fakeHome(provider: unknown = { options: { apiKey: SECRET } }): string {
  const home = join(tempRoot(), "home")
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true })
  mkdirSync(join(home, ".claude"), { recursive: true })
  writeFileSync(
    join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ provider: { "fireworks-ai": provider, openai: { options: { apiKey: "other" } } } }),
  )
  writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ openai: { type: "api", key: "x" } }))
  return home
}

function fakeBin(home: string): { bin: string; mark: string } {
  const bin = join(dirname(home), "bin")
  mkdirSync(bin, { recursive: true })
  copyFileSync(join(import.meta.dir, "fixtures", "fake-security.ts"), join(bin, "security"))
  chmodSync(join(bin, "security"), 0o755)
  return { bin, mark: join(dirname(home), "security.mark") }
}

const envFor = (home: string, bin: string, mark: string, extra: Record<string, string> = {}) => ({
  HOME: home,
  PATH: `${bin}:${process.env.PATH}`,
  FAKE_SECURITY_MARK: mark,
  ...extra,
})

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("exportAuth", () => {
  test("writes the minimal provider block, the credentials and 0700/0600 modes", () => {
    const home = fakeHome()
    const { bin, mark } = fakeBin(home)
    const dest = join(dirname(home), "auth")
    const log = spyOn(console, "log").mockImplementation(() => {})
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      exportAuth(dest, { env: envFor(home, bin, mark), platform: "darwin" })
    } finally {
      log.mockRestore()
      error.mockRestore()
    }

    expect(statSync(dest).mode & 0o777).toBe(0o700)
    const config = JSON.parse(readFileSync(join(dest, "opencode.json"), "utf8")) as { provider: Record<string, unknown> }
    expect(Object.keys(config.provider)).toEqual(["fireworks-ai"])
    expect((config.provider["fireworks-ai"] as { options: { apiKey: string } }).options.apiKey).toBe(SECRET)
    expect(JSON.parse(readFileSync(join(dest, "auth.json"), "utf8"))).toEqual({ openai: { type: "api", key: "x" } })
    expect(existsSync(mark)).toBe(true)
    expect((JSON.parse(readFileSync(join(dest, "claude", ".credentials.json"), "utf8")) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken).toBe(KEYCHAIN_TOKEN)
    for (const file of ["opencode.json", "auth.json", "claude/.credentials.json"]) {
      expect(statSync(join(dest, file)).mode & 0o777).toBe(0o600)
    }
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  test("gives CLAUDE_CODE_OAUTH_TOKEN precedence over the keychain", () => {
    const home = fakeHome()
    const { bin, mark } = fakeBin(home)
    const dest = join(dirname(home), "auth")
    exportAuth(dest, { env: envFor(home, bin, mark, { CLAUDE_CODE_OAUTH_TOKEN: KEYCHAIN_TOKEN }), platform: "darwin" })
    expect(readFileSync(join(dest, "claude", "oauth-token"), "utf8")).toBe(KEYCHAIN_TOKEN)
    expect(existsSync(join(dest, "claude", ".credentials.json"))).toBe(false)
    expect(existsSync(mark)).toBe(false)
  })

  test("on linux copies ~/.claude/.credentials.json", () => {
    const home = fakeHome()
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }))
    const dest = join(dirname(home), "auth")
    exportAuth(dest, { env: { HOME: home }, platform: "linux" })
    expect(existsSync(join(dest, "claude", ".credentials.json"))).toBe(true)
  })

  test("throws without the provider block and never leaks the config content", () => {
    const home = fakeHome()
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ provider: { openai: { options: { apiKey: SECRET } } } }))
    const dest = join(dirname(home), "auth")
    let message = ""
    try {
      exportAuth(dest, { env: { HOME: home }, platform: "linux" })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("fireworks-ai")
    expect(message).not.toContain(SECRET)
  })

  test("throws when no Claude Code credentials exist anywhere", () => {
    const home = fakeHome()
    const dest = join(dirname(home), "auth")
    expect(() => exportAuth(dest, { env: { HOME: home }, platform: "linux" })).toThrow(/no Claude Code credentials/)
  })
})

describe("removeAuth", () => {
  test("removes the directory and tolerates a second call", () => {
    const home = fakeHome()
    const dest = join(dirname(home), "auth")
    mkdirSync(dest, { recursive: true })
    removeAuth(dest)
    expect(existsSync(dest)).toBe(false)
    expect(() => removeAuth(dest)).not.toThrow()
  })
})
