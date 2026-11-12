import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandsPath, DEFAULT_COMMANDS, needsPolicy, parseCommands, readCommands } from "../src/core/commands"

const dirs: string[] = []
const envFor = () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-commands-"))
  dirs.push(dir)
  return { AGENTS_MD_GUARD_HOME: join(dir, "guard") }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("command list", () => {
  test("skips blank lines and comments", () => {
    expect(parseCommands("git commit\n\n# a note\n  gh pr create  \n")).toEqual(["git commit", "gh pr create"])
  })

  test("creates the defaults on first read and never overwrites an edit", () => {
    const env = envFor()
    expect(readCommands(env)).toEqual(DEFAULT_COMMANDS)
    expect(existsSync(commandsPath(env))).toBe(true)
    writeFileSync(commandsPath(env), "git commit\n")
    expect(readCommands(env)).toEqual(["git commit"])
  })

  test("an empty file means no command is checked", () => {
    const env = envFor()
    readCommands(env)
    writeFileSync(commandsPath(env), "")
    expect(readCommands(env)).toEqual([])
  })
})

describe("needsPolicy", () => {
  test("matches a plain substring and ignores extra whitespace", () => {
    expect(needsPolicy("cd repo && git   commit -m x", ["git commit"])).toBe(true)
    expect(needsPolicy("gh pr create --title x", ["gh pr create"])).toBe(true)
    expect(needsPolicy("git status", ["git commit"])).toBe(false)
  })

  test("is not a regex and ignores an empty command", () => {
    expect(needsPolicy("git commit", ["git .*"])).toBe(false)
    expect(needsPolicy("", ["git commit"])).toBe(false)
    expect(needsPolicy(undefined, ["git commit"])).toBe(false)
  })
})
