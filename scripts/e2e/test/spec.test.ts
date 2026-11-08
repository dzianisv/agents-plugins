import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverPlugins } from "../run"
import { loadSpec, opencodeLoadFailure, opencodeLoadedCheck, validateSpec, waitFor, type CheckContext } from "../spec"

const SPEC_PATH = join(import.meta.dir, "..", "spec.ts")
const valid = { plugin: "p", runtimes: ["claude"], prompt: "hi", checks: [{ name: "c", run: () => ({ ok: true }) }] }

describe("validateSpec", () => {
  test("accepts a minimal spec", () => {
    expect(validateSpec(valid).plugin).toBe("p")
  })

  test("accepts setup and claude options", () => {
    const spec = validateSpec({ ...valid, setup: () => {}, claude: { maxTurns: 3, allowedTools: ["Bash(git commit:*)"] } })
    expect(spec.runtimes).toEqual(["claude"])
  })

  test("accepts an env record", () => {
    const spec = validateSpec({ ...valid, env: { OPENCODE_SESSION_INDEX_IDLE_MS: "5000" } })
    expect(spec.env).toEqual({ OPENCODE_SESSION_INDEX_IDLE_MS: "5000" })
  })

  test("rejects an env that is not an object of strings", () => {
    expect(() => validateSpec({ ...valid, env: ["A=1"] })).toThrow(/spec.env must be an object/)
    expect(() => validateSpec({ ...valid, env: { A: 1 } })).toThrow(/spec.env.A must be a string/)
  })

  test("rejects a missing plugin name", () => {
    expect(() => validateSpec({ ...valid, plugin: "" })).toThrow(/spec.plugin/)
  })

  test("rejects a plugin mismatch", () => {
    expect(() => validateSpec(valid, "other")).toThrow(/expected "other"/)
  })

  test("rejects an unknown runtime", () => {
    expect(() => validateSpec({ ...valid, runtimes: ["vscode"] })).toThrow(/unknown runtime/)
  })

  test("rejects duplicate runtimes", () => {
    expect(() => validateSpec({ ...valid, runtimes: ["claude", "claude"] })).toThrow(/duplicates/)
  })

  test("rejects an empty prompt", () => {
    expect(() => validateSpec({ ...valid, prompt: "  " })).toThrow(/spec.prompt/)
  })

  test("rejects a spec without checks", () => {
    expect(() => validateSpec({ ...valid, checks: [] })).toThrow(/spec.checks/)
  })

  test("rejects a check without a run function", () => {
    expect(() => validateSpec({ ...valid, checks: [{ name: "c" }] })).toThrow(/no run function/)
  })
})

describe("loadSpec", () => {
  test("loads and validates packages/<plugin>/e2e/spec.ts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "e2e-spec-test-"))
    try {
      mkdirSync(join(repo, "packages", "foo", "e2e"), { recursive: true })
      writeFileSync(
        join(repo, "packages", "foo", "e2e", "spec.ts"),
        `import { defineSpec } from ${JSON.stringify(SPEC_PATH)}\nexport default defineSpec({ plugin: "foo", runtimes: ["opencode"], prompt: "ok", checks: [{ name: "c", run: () => ({ ok: true }) }] })\n`,
      )
      const spec = await loadSpec(repo, "foo")
      expect(spec.plugin).toBe("foo")
      expect(spec.runtimes).toEqual(["opencode"])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("throws a path-bearing error for a missing spec", async () => {
    const repo = mkdtempSync(join(tmpdir(), "e2e-spec-test-"))
    try {
      await expect(loadSpec(repo, "missing")).rejects.toThrow(/missing\/e2e\/spec\.ts/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("loads and validates every spec shipped in this repo", async () => {
    const repo = join(import.meta.dir, "..", "..", "..")
    const plugins = discoverPlugins(repo)
    for (const plugin of ["task-gh-guard", "turn-check", "overhelm", "session-index", "session-self-improve", "auto-review", "reflection"]) {
      expect(plugins).toContain(plugin)
    }
    for (const plugin of plugins) {
      const spec = await loadSpec(repo, plugin)
      expect(spec.plugin).toBe(plugin)
      expect(spec.runtimes.length).toBeGreaterThan(0)
    }
  })
})

describe("opencodeLoadFailure", () => {
  const dir = "/work/agents-plugins/packages/x"
  const loading = `level=INFO msg="loading plugin" id=${dir} entrypoint=file://${dir}/server.ts`
  const failed = `level=WARN message="failed to load plugin" target=${dir} cause="Plugin must export a default definition"`

  test("finds a failed-to-load line", () => {
    expect(opencodeLoadFailure(`${loading}\n${failed}`, dir)).toBe(failed)
  })

  test("finds an error line mentioning the plugin", () => {
    expect(opencodeLoadFailure(`${loading}\nlevel=ERROR message="boom" ${dir}`, dir)).toContain("boom")
  })

  test("returns undefined for a clean log", () => {
    expect(opencodeLoadFailure(loading, dir)).toBeUndefined()
  })

  test("ignores failures of other plugins", () => {
    expect(opencodeLoadFailure(`${loading}\nlevel=WARN message="failed to load plugin" target=/other/dir`, dir)).toBeUndefined()
  })
})

describe("opencodeLoadedCheck", () => {
  test("passes on a clean log and fails on a failed-to-load line", async () => {
    const repo = mkdtempSync(join(tmpdir(), "e2e-spec-test-"))
    const home = mkdtempSync(join(tmpdir(), "e2e-spec-test-"))
    const previous = process.env.XDG_DATA_HOME
    delete process.env.XDG_DATA_HOME
    try {
      const dir = join(repo, "packages", "x")
      const logDir = join(home, ".local", "share", "opencode", "log")
      mkdirSync(logDir, { recursive: true })
      const logPath = join(logDir, "opencode.log")
      const ctx: CheckContext = { runtime: "opencode", plugin: "x", repo, home, out: home, exitCode: 0, stdout: "", stderr: "" }
      const loading = `level=INFO msg="loading plugin" id=${dir} entrypoint=file://${dir}/server.ts\n`
      writeFileSync(logPath, loading)
      expect(await opencodeLoadedCheck("x").run(ctx)).toEqual({ ok: true, detail: `loaded from ${dir}` })
      writeFileSync(logPath, `${loading}level=WARN message="failed to load plugin" target=${dir}\n`)
      expect((await opencodeLoadedCheck("x").run(ctx)).ok).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previous
      rmSync(repo, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("waitFor", () => {
  test("returns the value once the probe has one", async () => {
    let calls = 0
    const value = await waitFor(() => (++calls === 3 ? "done" : undefined), 1000, 5)
    expect(value).toBe("done")
    expect(calls).toBe(3)
  })

  test("returns undefined on timeout", async () => {
    expect(await waitFor(() => undefined, 30, 5)).toBeUndefined()
  })
})
