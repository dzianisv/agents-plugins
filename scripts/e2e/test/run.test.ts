import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverPlugins, formatTable, parseArgs, parseResult, runtimesFor, type CaseResult } from "../run"
import type { Spec } from "../spec"

describe("parseArgs", () => {
  test("defaults to every available plugin and both runtimes", () => {
    expect(parseArgs([], ["a", "b"])).toEqual({ plugins: ["a", "b"], runtimes: ["claude", "opencode"], keep: false, noBuild: false, timeout: 300 })
  })

  test("collects repeated --plugin flags", () => {
    expect(parseArgs(["--plugin", "a", "--plugin", "b"], ["a", "b"]).plugins).toEqual(["a", "b"])
  })

  test("selects one runtime or all", () => {
    expect(parseArgs(["--runtime", "claude"], ["a"]).runtimes).toEqual(["claude"])
    expect(parseArgs(["--runtime", "opencode"], ["a"]).runtimes).toEqual(["opencode"])
    expect(parseArgs(["--runtime", "all"], ["a"]).runtimes).toEqual(["claude", "opencode"])
  })

  test("reads --timeout, --keep and --no-build", () => {
    const options = parseArgs(["--timeout", "60", "--keep", "--no-build"], ["a"])
    expect(options.timeout).toBe(60)
    expect(options.keep).toBe(true)
    expect(options.noBuild).toBe(true)
  })

  test("rejects an unknown runtime", () => {
    expect(() => parseArgs(["--runtime", "vscode"], ["a"])).toThrow(/unknown runtime/)
  })

  test("rejects an unknown plugin", () => {
    expect(() => parseArgs(["--plugin", "zzz"], ["a"])).toThrow(/unknown plugin/)
  })

  test("rejects a missing flag value", () => {
    expect(() => parseArgs(["--plugin"], ["a"])).toThrow(/needs a name/)
    expect(() => parseArgs(["--timeout", "abc"], ["a"])).toThrow(/positive number/)
  })

  test("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus"], ["a"])).toThrow(/unknown flag/)
  })

  test("rejects a run with no specs at all", () => {
    expect(() => parseArgs([], [])).toThrow(/no plugin/)
  })
})

describe("parseResult", () => {
  const good: CaseResult = { plugin: "p", runtime: "claude", status: "pass", checks: [{ name: "c", ok: true }] }

  test("parses a well-formed result", () => {
    expect(parseResult(JSON.stringify(good))).toEqual(good)
  })

  test("rejects broken JSON", () => {
    expect(parseResult("{oops")).toBeNull()
  })

  test("rejects an unknown runtime", () => {
    expect(parseResult(JSON.stringify({ ...good, runtime: "vscode" }))).toBeNull()
  })

  test("rejects an unknown status", () => {
    expect(parseResult(JSON.stringify({ ...good, status: "maybe" }))).toBeNull()
  })

  test("rejects checks without a boolean ok", () => {
    expect(parseResult(JSON.stringify({ ...good, checks: [{ name: "c", ok: "yes" }] }))).toBeNull()
  })
})

describe("formatTable", () => {
  const results: CaseResult[] = [
    { plugin: "gh-guard", runtime: "claude", status: "pass", checks: [{ name: "exit code 0", ok: true }, { name: "review allowed the commit", ok: true, detail: "decision allow" }] },
    { plugin: "gh-guard", runtime: "opencode", status: "fail", checks: [{ name: "review allowed the commit", ok: false, detail: "x".repeat(100) }] },
  ]

  test("renders a row per check with PASS/FAIL", () => {
    const table = formatTable(results)
    expect(table).toContain("plugin")
    expect(table).toContain("gh-guard")
    expect(table).toContain("PASS")
    expect(table).toContain("FAIL")
    expect(table.split("\n").length).toBe(5)
  })

  test("truncates long details", () => {
    const table = formatTable(results)
    expect(table).toContain(`${"x".repeat(77)}...`)
    expect(table).not.toContain("x".repeat(80))
  })

  test("handles an empty result list", () => {
    expect(formatTable([])).toBe("(no results)")
  })
})

describe("discoverPlugins", () => {
  test("finds only packages with an e2e spec", () => {
    const repo = mkdtempSync(join(tmpdir(), "e2e-run-test-"))
    try {
      mkdirSync(join(repo, "packages", "x", "e2e"), { recursive: true })
      writeFileSync(join(repo, "packages", "x", "e2e", "spec.ts"), "export default {}\n")
      mkdirSync(join(repo, "packages", "y"), { recursive: true })
      expect(discoverPlugins(repo)).toEqual(["x"])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("runtimesFor", () => {
  const spec: Spec = { plugin: "p", runtimes: ["opencode"], prompt: "hi", checks: [{ name: "c", run: () => ({ ok: true }) }] }

  test("keeps only the runtimes the spec declares", () => {
    expect(runtimesFor(spec, ["claude", "opencode"])).toEqual(["opencode"])
    expect(runtimesFor(spec, ["claude"])).toEqual([])
  })
})
