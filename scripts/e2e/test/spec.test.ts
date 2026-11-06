import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSpec, validateSpec, waitFor } from "../spec"

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
