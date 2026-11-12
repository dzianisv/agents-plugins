// A git install keeps only this package, so src/shared holds real copies of packages/shared/src.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const source = join(import.meta.dir, "..", "..", "shared", "src")
const copy = join(import.meta.dir, "..", "src", "shared")
const files = ["inject-limit.ts", "notify.ts"]

describe("vendored shared modules", () => {
  test("match packages/shared/src byte for byte", () => {
    if (!existsSync(source)) return
    for (const name of files) {
      expect(readFileSync(join(copy, name), "utf8")).toBe(readFileSync(join(source, name), "utf8"))
    }
  })
})
