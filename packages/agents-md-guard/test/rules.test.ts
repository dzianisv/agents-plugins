// The judge reads the global ~/.agents/AGENTS.md and the project's own AGENTS.md.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeRules, readRules, rulesPaths } from "../src/core/rules"

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tc-rules-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("rules files", () => {
  test("reads the global file, then the project AGENTS.md and .agents/AGENTS.md", () => {
    const home = temp()
    const project = temp()
    mkdirSync(join(home, ".agents"), { recursive: true })
    writeFileSync(join(home, ".agents", "AGENTS.md"), "GLOBAL RULE")
    writeFileSync(join(project, "AGENTS.md"), "PROJECT RULE")
    mkdirSync(join(project, ".agents"))
    writeFileSync(join(project, ".agents", "AGENTS.md"), "PROJECT NESTED RULE")

    const sources = readRules({ HOME: home }, project)
    expect(sources.map((source) => source.text)).toEqual(["GLOBAL RULE", "PROJECT RULE", "PROJECT NESTED RULE"])
    const composed = composeRules(sources)
    expect(composed).toContain(`# Rules from ${join(home, ".agents", "AGENTS.md")}\nGLOBAL RULE`)
    expect(composed).toContain(`# Rules from ${join(project, "AGENTS.md")}\nPROJECT RULE`)
    expect(composed).toContain("PROJECT NESTED RULE")
  })

  test("reads memory files with a memory header", () => {
    const home = temp()
    const project = temp()
    mkdirSync(join(home, ".agents"), { recursive: true })
    mkdirSync(join(project, ".agents"))
    writeFileSync(join(home, ".agents", "MEMORY.md"), "GLOBAL LESSON")
    writeFileSync(join(project, ".agents", "MEMORY.md"), "PROJECT LESSON")

    const sources = readRules({ HOME: home }, project)
    expect(sources.map((source) => source.text)).toEqual(["GLOBAL LESSON", "PROJECT LESSON"])
    const composed = composeRules(sources)
    expect(composed).toContain(`# Memory from ${join(home, ".agents", "MEMORY.md")}\nGLOBAL LESSON`)
    expect(composed).toContain(`# Memory from ${join(project, ".agents", "MEMORY.md")}\nPROJECT LESSON`)
  })

  test("skips a missing or empty file and de-duplicates the same path", () => {
    const project = temp()
    writeFileSync(join(project, "AGENTS.md"), "   ")
    expect(readRules({ HOME: project }, project)).toEqual([])
    expect(composeRules([])).toBe("")
  })

  test("SUPERVISOR_RULES replaces both", () => {
    const project = temp()
    writeFileSync(join(project, "AGENTS.md"), "PROJECT RULE")
    const override = join(project, "custom.md")
    writeFileSync(override, "CUSTOM RULE")
    expect(rulesPaths({ SUPERVISOR_RULES: override }, project)).toEqual([override])
    expect(readRules({ SUPERVISOR_RULES: override }, project).map((source) => source.text)).toEqual(["CUSTOM RULE"])
  })

  test("the project file is read from the session cwd, not the plugin cwd", () => {
    const home = temp()
    const project = temp()
    mkdirSync(join(home, ".agents"), { recursive: true })
    writeFileSync(join(home, ".agents", "AGENTS.md"), "GLOBAL RULE")
    writeFileSync(join(project, "AGENTS.md"), "OTHER PROJECT RULE")
    expect(readRules({ HOME: home }, project).map((source) => source.text)).toEqual(["GLOBAL RULE", "OTHER PROJECT RULE"])
  })
})
